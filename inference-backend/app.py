import modal
import io
import os

# Define the image with necessary dependencies
chatterbox_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "git")
    .uv_sync()
    .add_local_dir("./petergriffin", remote_path="/root/petergriffin")
)

app = modal.App("peter-griffin-chatterbox")

# Create a volume to cache the Hugging Face model weights
cache_volume = modal.Volume.from_name("huggingface-cache", create_if_missing=True)
CACHE_DIR = "/root/cache"

cf_account_id = "b8a6047310bbd4b0a0e5374e91089308"

r2_secret = modal.Secret.from_name("cf-access-key", required_keys=["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"])
R2_MOUNT_PATH = "/root/r2"


@app.cls(
    image=chatterbox_image,
    gpu="H100",
    scaledown_window=300,
    # Mount the volume to persist the model weights
    volumes={CACHE_DIR: cache_volume, 
             R2_MOUNT_PATH: modal.CloudBucketMount(
                    bucket_name="learnscrolling-assets",
                    bucket_endpoint_url=f"https://{cf_account_id}.r2.cloudflarestorage.com",
                    secret=r2_secret
                 )},
    # Requires a Modal Secret named 'huggingface-secret' with HF_TOKEN key
    enable_memory_snapshot=True,
    secrets=[modal.Secret.from_name("huggingface-secret")],
    experimental_options={"enable_gpu_snapshot": True},
)
class PeterGriffinTTS:
    @modal.enter(snap=True)
    def load_model(self):
        # Set the Hugging Face cache directory to the mounted volume
        os.environ["HF_HOME"] = CACHE_DIR

        from chatterbox.tts import ChatterboxTTS
        import whisper

        # The model will be downloaded to the volume on the first run
        # and reused from the volume on subsequent container starts
        self.model = ChatterboxTTS.from_pretrained(device="cuda")
        self.whisper_model = whisper.load_model("base", device="cuda")
        self.audio_prompt_path = "/root/petergriffin/literally just peter griffin talking for 8 minutes with almost no background noise.mp3"

    @modal.method()
    def generate_with_timestamps(self, text: str, job_id: str, reel_index: int):
        import json
        import logging
        import subprocess
        import tempfile
        import torchaudio
        from pathlib import Path

        logging.info(
            json.dumps(
                {
                    "event": "generate_with_timestamps_start",
                    "job_id": job_id,
                    "reel_index": reel_index,
                    "text_length": len(text),
                }
            )
        )

        # Generate the audio using Peter Griffin's voice as the prompt
        wav = self.model.generate(text, 
                                  audio_prompt_path=self.audio_prompt_path, 
                                  exaggeration=0.7)

        wav = wav.cpu()

        if wav.dim() == 1:
            wav = wav.unsqueeze(0)

        # Speed up 1.5x without pitch shift using ffmpeg (sox_effects removed in torchaudio 2.1+)
        with tempfile.NamedTemporaryFile(suffix=".wav") as tmp_in, \
             tempfile.NamedTemporaryFile(suffix=".wav") as tmp_out:
            torchaudio.save(tmp_in.name, wav, self.model.sr, format="wav")
            result = subprocess.run(
                [
                    "ffmpeg", "-y", "-i", tmp_in.name,
                    "-filter:a", "atempo=1.15",
                    "-ar", str(self.model.sr),
                    tmp_out.name,
                ],
                capture_output=True,
            )
            if result.returncode != 0:
                logging.error(json.dumps({
                    "event": "ffmpeg_error",
                    "stderr": result.stderr.decode(),
                }))
                raise RuntimeError(f"ffmpeg tempo adjustment failed: {result.stderr.decode()}")

            result = self.whisper_model.transcribe(
                tmp_out.name,
                word_timestamps=True,
                language="en")

            buffer = io.BytesIO()
            wav_sped, new_sr = torchaudio.load(tmp_out.name)
            words = []
            for segment in result["segments"]:
                for w in segment.get("words", []):
                    words.append(
                        {
                            "word": w["word"].strip(),
                            "start": round(w["start"], 3),
                            "end": round(w["end"], 3),
                        }
                    )

            duration = wav_sped.shape[1] / new_sr
            audio_key = f"audio/{job_id}/{reel_index}.wav"
            audio_path = Path(R2_MOUNT_PATH) / audio_key
            audio_path.parent.mkdir(parents=True, exist_ok=True)
            torchaudio.save(str(audio_path), wav_sped, int(new_sr), format="wav")

            # 7. Write timestamps JSON to R2
            timestamps_key = f"timestamps/{job_id}/{reel_index}.json"
            timestamps_path = Path(R2_MOUNT_PATH) / timestamps_key
            timestamps_path.parent.mkdir(parents=True, exist_ok=True)
            with open(timestamps_path, "w") as f:
                json.dump(
                    {
                        "wordTimestamps": words,
                        "durationSeconds": round(duration, 2),
                    },
                    f,
                )
    
            logging.info(
                json.dumps(
                    {
                        "event": "generate_with_timestamps_done",
                        "job_id": job_id,
                        "reel_index": reel_index,
                        "duration_seconds": round(duration, 2),
                        "word_count": len(words),
                        "audio_key": audio_key,
                        "timestamps_key": timestamps_key,
                    }
                )
            )
    
            return {
                "audioKey": audio_key,
                "timestampsKey": timestamps_key,
                "durationSeconds": round(duration, 2),
                "wordCount": len(words),
            }

        logging.info(json.dumps({"event": "generate_complete", "audio_bytes": buffer.tell()}))
        return buffer.getvalue()


@app.function(image=chatterbox_image)
@modal.fastapi_endpoint(method="POST")
def speak(body: dict):
    api_key = "d736adf4b03b0519393e6d5cbedc73bb81539edb2771d856bff265e59e44f559"
    import json
    import logging
    from fastapi import Response

    text = body.get("text", "")
    job_id = body.get("job_id", "")
    reel_index = body.get("reel_index")
 
    if not text:
        logging.warning(json.dumps({"event": "missing_text"}))
        return Response(
            content=json.dumps({"error": "text is required"}),
            media_type="application/json",
            status_code=400,
        )
    if not job_id:
        logging.warning(json.dumps({"event": "missing_job_id"}))
        return Response(
            content=json.dumps({"error": "job_id is required"}),
            media_type="application/json",
            status_code=400,
        )
    if reel_index is None or not isinstance(reel_index, int):
        logging.warning(json.dumps({"event": "missing_reel_index"}))
        return Response(
            content=json.dumps({"error": "reel_index (integer) is required"}),
            media_type="application/json",
            status_code=400,
        )
 
    logging.info(
        json.dumps(
            {
                "event": "generate_speech_request",
                "job_id": job_id,
                "reel_index": reel_index,
                "text_length": len(text),
            }
        )
    )
 
    # --- Generate TTS + timestamps + write to R2 ---
    tts = PeterGriffinTTS()
    result = tts.generate_with_timestamps.remote(text, job_id, reel_index)
 
    logging.info(
        json.dumps(
            {
                "event": "generate_speech_complete",
                "job_id": job_id,
                "reel_index": reel_index,
                "duration_seconds": result["durationSeconds"],
                "word_count": result["wordCount"],
                "audio_key": result["audioKey"],
                "timestamps_key": result["timestampsKey"],
            }
        )
    )
 
    logging.info(json.dumps({"event": "speak_response", "audio_bytes": len(audio_data)}))
    return Response(content=audio_data, media_type="audio/wav")
    return Response(
        content=json.dumps(
            {
                "success": True,
                "audioKey": result["audioKey"],
                "timestampsKey": result["timestampsKey"],
                "durationSeconds": result["durationSeconds"],
                "wordCount": result["wordCount"],
            }
        ),
        media_type="application/json",
    )


@app.local_entrypoint()
def main(text: str = "Hey Lois, I'm a cloud function!"):
    tts = PeterGriffinTTS()
    result = tts.generate_with_timestamps.remote(text, "test-local", 0)

if __name__ == "__main__":
    app.run()

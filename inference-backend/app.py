import modal
import io
import os

# Define the image with necessary dependencies
chatterbox_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "git", "sox", "libsox-dev", "libsox-fmt-all")
    .uv_sync()
    .add_local_dir("./petergriffin", remote_path="/root/petergriffin")
)

app = modal.App("peter-griffin-chatterbox")

# Create a volume to cache the Hugging Face model weights
cache_volume = modal.Volume.from_name("huggingface-cache", create_if_missing=True)
CACHE_DIR = "/root/cache"

# R2 bucket mount — Cloudflare account ID is not secret (it's in every R2 public URL)
# Set this to your Cloudflare account ID
CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", "REPLACE_ME")

r2_secret = modal.Secret.from_name(
    "r2-secret",
    required_keys=["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
)

R2_MOUNT_PATH = "/root/r2"


@app.cls(
    image=chatterbox_image,
    gpu="H100",
    scaledown_window=300,
    volumes={
        CACHE_DIR: cache_volume,
        R2_MOUNT_PATH: modal.CloudBucketMount(
            bucket_name="learnscrolling-assets",
            bucket_endpoint_url=f"https://{CF_ACCOUNT_ID}.r2.cloudflarestorage.com",
            secret=r2_secret,
        ),
    },
    enable_memory_snapshot=True,
    secrets=[
        modal.Secret.from_name("huggingface-secret"),
        modal.Secret.from_name("tts-api-key"),
    ],
    experimental_options={"enable_gpu_snapshot": True},
)
class PeterGriffinTTS:
    @modal.enter(snap=True)
    def load_model(self):
        os.environ["HF_HOME"] = CACHE_DIR

        from chatterbox.tts_turbo import ChatterboxTurboTTS
        import whisper

        self.model = ChatterboxTurboTTS.from_pretrained(device="cuda")
        self.audio_prompt_path = "/root/petergriffin/literally just peter griffin talking for 8 minutes with almost no background noise.mp3"

        # Whisper base (~150MB) for word-level timestamp extraction
        self.whisper_model = whisper.load_model("base", device="cuda")

    @modal.method()
    def generate_with_timestamps(self, text: str, job_id: str, reel_index: int):
        """Generate TTS audio + word-level timestamps, write both to R2.

        Writes:
          - audio/{job_id}/{reel_index}.wav
          - timestamps/{job_id}/{reel_index}.json

        Returns dict with R2 keys, durationSeconds, and wordCount.
        """
        import torchaudio
        import tempfile
        import json
        import logging
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

        # 1. Chatterbox generates WAV
        wav = self.model.generate(
            text, audio_prompt_path=self.audio_prompt_path, exaggeration=0.7
        )
        wav = wav.cpu()
        if wav.dim() == 1:
            wav = wav.unsqueeze(0)

        # 2. Speed up 1.5x without pitch shift
        effects = [["tempo", "1.5"]]
        wav_sped, new_sr = torchaudio.sox_effects.apply_effects_tensor(
            wav, self.model.sr, effects
        )

        # 3. Save sped-up audio to temp file for Whisper
        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        torchaudio.save(tmp.name, wav_sped, int(new_sr), format="wav")
        tmp.close()

        # 4. Run Whisper on the sped-up audio for word-level timestamps
        result = self.whisper_model.transcribe(
            tmp.name,
            word_timestamps=True,
            language="en",
        )
        os.unlink(tmp.name)

        # 5. Extract word timings
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

        # 6. Write audio WAV to R2
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


@app.function(
    image=chatterbox_image,
    secrets=[modal.Secret.from_name("tts-api-key")],
)
@modal.fastapi_endpoint(method="POST")
def generate_speech(body: dict):
    """Generate Peter Griffin TTS with word timestamps, write to R2.

    See API.md for the full contract.
    """
    import json
    import logging
    from fastapi import Response

    # --- Auth ---
    expected_key = os.environ.get("TTS_API_KEY", "")
    provided_key = body.get("api_key", "")
    if not expected_key or provided_key != expected_key:
        logging.warning(json.dumps({"event": "auth_failed"}))
        return Response(
            content=json.dumps({"error": "unauthorized"}),
            media_type="application/json",
            status_code=401,
        )

    # --- Validate input ---
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

    print(f"Audio written to R2: {result['audioKey']}")
    print(f"Timestamps written to R2: {result['timestampsKey']}")
    print(f"Duration: {result['durationSeconds']}s, Words: {result['wordCount']}")

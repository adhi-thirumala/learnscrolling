import modal
import os
import re

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

r2_secret = modal.Secret.from_name(
    "r2-secret", required_keys=["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]
)
R2_MOUNT_PATH = "/root/r2"


# --- Script line parsing ---
# The LLM generates dialogue in the format:
#   [Peter]: "Some dialogue here."
#   [Stewie]: "Some other dialogue."
# We parse each line to extract the speaker and dialogue text, then
# generate TTS for each line using the corresponding voice reference.


def parse_script_lines(text: str) -> list[dict]:
    """Parse a Peter/Stewie script into individual speaker lines.

    Each line should start with [Peter]: or [Stewie]:.
    Returns a list of dicts: [{"speaker": "Peter"|"Stewie", "text": "..."}]

    Lines that don't match the pattern are skipped (e.g. empty lines).
    Strips surrounding quotes from the dialogue text.
    """
    lines = []
    for raw_line in text.strip().splitlines():
        raw_line = raw_line.strip()
        if not raw_line:
            continue

        # Match [Peter]: or [Stewie]: at the start (case-insensitive)
        match = re.match(r"\[(Peter|Stewie)\]\s*:\s*(.*)", raw_line, re.IGNORECASE)
        if match:
            speaker = match.group(1).capitalize()  # Normalize to "Peter" or "Stewie"
            dialogue = match.group(2).strip()
            # Strip surrounding quotes if present
            if dialogue.startswith('"') and dialogue.endswith('"'):
                dialogue = dialogue[1:-1].strip()
            if dialogue:
                lines.append({"speaker": speaker, "text": dialogue})
    return lines


@app.cls(
    image=chatterbox_image,
    gpu="H100",
    scaledown_window=300,
    # Mount the volume to persist the model weights
    volumes={
        CACHE_DIR: cache_volume,
        R2_MOUNT_PATH: modal.CloudBucketMount(
            bucket_name="learnscrolling-assets",
            bucket_endpoint_url=f"https://{cf_account_id}.r2.cloudflarestorage.com",
            secret=r2_secret,
        ),
    },
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

        # Voice reference paths — keyed by speaker name
        self.peter_path = "/root/petergriffin/literally just peter griffin talking for 8 minutes with almost no background noise.mp3"
        self.stewie_path = "/root/petergriffin/stewie.wav"

        self.voice_paths = {
            "Peter": self.peter_path,
            "Stewie": self.stewie_path,
        }

        # The model will be downloaded to the volume on the first run
        # and reused from the volume on subsequent container starts
        self.model = ChatterboxTTS.from_pretrained(device="cuda")
        self.whisper_model = whisper.load_model("turbo", device="cuda")

    @modal.method()
    def generate_with_timestamps(self, text: str, job_id: str, reel_index: int):
        import json
        import logging
        import shutil
        import subprocess
        import tempfile
        import torch
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

        # --- 1. Parse script into speaker lines ---
        script_lines = parse_script_lines(text)
        if not script_lines:
            raise ValueError("No valid [Peter]: or [Stewie]: lines found in text")

        logging.info(
            json.dumps(
                {
                    "event": "script_parsed",
                    "job_id": job_id,
                    "reel_index": reel_index,
                    "num_lines": len(script_lines),
                    "speakers": [ln["speaker"] for ln in script_lines],
                }
            )
        )

        # --- 2. Generate TTS for each line using the correct voice ---
        line_wavs = []
        # Track cumulative sample count per line so we can map Whisper words
        # back to the correct speaker after speed-up.
        line_sample_boundaries = []  # list of (start_sample, end_sample, speaker)
        cumulative_samples = 0

        for i, line in enumerate(script_lines):
            speaker = line["speaker"]
            dialogue = line["text"]
            voice_path = self.voice_paths.get(speaker, self.peter_path)

            logging.info(
                json.dumps(
                    {
                        "event": "line_generate_start",
                        "job_id": job_id,
                        "reel_index": reel_index,
                        "line_index": i,
                        "speaker": speaker,
                        "line_words": len(dialogue.split()),
                    }
                )
            )

            wav = self.model.generate(
                dialogue,
                audio_prompt_path=voice_path,
                exaggeration=0.7,
            )
            wav = wav.cpu()
            if wav.dim() == 1:
                wav = wav.unsqueeze(0)

            num_samples = wav.shape[1]
            line_sample_boundaries.append(
                {
                    "start_sample": cumulative_samples,
                    "end_sample": cumulative_samples + num_samples,
                    "speaker": speaker,
                }
            )
            cumulative_samples += num_samples
            line_wavs.append(wav)

            logging.info(
                json.dumps(
                    {
                        "event": "line_generate_done",
                        "job_id": job_id,
                        "reel_index": reel_index,
                        "line_index": i,
                        "speaker": speaker,
                        "line_duration_seconds": round(num_samples / self.model.sr, 2),
                    }
                )
            )

        # --- 3. Concatenate all line WAVs ---
        full_wav = torch.cat(line_wavs, dim=1)
        total_samples = full_wav.shape[1]

        logging.info(
            json.dumps(
                {
                    "event": "lines_concatenated",
                    "job_id": job_id,
                    "reel_index": reel_index,
                    "num_lines": len(line_wavs),
                    "total_raw_duration_seconds": round(
                        total_samples / self.model.sr, 2
                    ),
                }
            )
        )

        # --- 4. Speed up 1.15x without pitch shift using ffmpeg ---
        # Convert sample boundaries to time boundaries (pre-speedup), then
        # scale them by 1/1.15 to get post-speedup times for speaker mapping.
        SPEED_FACTOR = 1.15
        line_time_boundaries = []
        for b in line_sample_boundaries:
            line_time_boundaries.append(
                {
                    "start_sec": (b["start_sample"] / self.model.sr) / SPEED_FACTOR,
                    "end_sec": (b["end_sample"] / self.model.sr) / SPEED_FACTOR,
                    "speaker": b["speaker"],
                }
            )

        with (
            tempfile.NamedTemporaryFile(suffix=".wav") as tmp_in,
            tempfile.NamedTemporaryFile(suffix=".wav") as tmp_out,
        ):
            torchaudio.save(tmp_in.name, full_wav, self.model.sr, format="wav")
            ffmpeg_result = subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-i",
                    tmp_in.name,
                    "-filter:a",
                    f"atempo={SPEED_FACTOR}",
                    "-ar",
                    str(self.model.sr),
                    tmp_out.name,
                ],
                capture_output=True,
            )
            if ffmpeg_result.returncode != 0:
                logging.error(
                    json.dumps(
                        {
                            "event": "ffmpeg_error",
                            "stderr": ffmpeg_result.stderr.decode(),
                        }
                    )
                )
                raise RuntimeError(
                    f"ffmpeg tempo adjustment failed: {ffmpeg_result.stderr.decode()}"
                )

            # --- 5. Run Whisper on the sped-up audio for word timestamps ---
            whisper_result = self.whisper_model.transcribe(
                tmp_out.name, word_timestamps=True, language="en"
            )

            wav_sped, new_sr = torchaudio.load(tmp_out.name)

            # --- 6. Map each word to its speaker based on time boundaries ---
            words = []
            for segment in whisper_result["segments"]:
                for w in segment.get("words", []):
                    word_mid = (w["start"] + w["end"]) / 2.0
                    # Find which speaker line this word falls into
                    speaker = script_lines[0]["speaker"]  # fallback
                    for boundary in line_time_boundaries:
                        if boundary["start_sec"] <= word_mid <= boundary["end_sec"]:
                            speaker = boundary["speaker"]
                            break
                    words.append(
                        {
                            "word": w["word"].strip(),
                            "start": round(w["start"], 3),
                            "end": round(w["end"], 3),
                            "speaker": speaker,
                        }
                    )

            duration = wav_sped.shape[1] / new_sr

            # --- 7. Write final WAV to R2 ---
            audio_key = f"audio/{job_id}/{reel_index}.wav"
            audio_dest = Path(R2_MOUNT_PATH) / audio_key
            audio_dest.parent.mkdir(parents=True, exist_ok=True)

            with tempfile.NamedTemporaryFile(suffix=".wav") as tmp_audio:
                torchaudio.save(tmp_audio.name, wav_sped, int(new_sr), format="wav")
                shutil.copy(tmp_audio.name, str(audio_dest))

            # --- 8. Write timestamps JSON to R2 ---
            # Include line_time_boundaries so compositor can reconstruct
            # speaker changes for subtitle display.
            timestamps_key = f"timestamps/{job_id}/{reel_index}.json"
            timestamps_dest = Path(R2_MOUNT_PATH) / timestamps_key
            timestamps_dest.parent.mkdir(parents=True, exist_ok=True)

            with tempfile.NamedTemporaryFile(
                mode="w", suffix=".json", delete=False
            ) as tmp_ts:
                json.dump(
                    {
                        "wordTimestamps": words,
                        "durationSeconds": round(duration, 2),
                        "lineTimeBoundaries": line_time_boundaries,
                    },
                    tmp_ts,
                )
            tmp_ts_name = tmp_ts.name
            shutil.copy(tmp_ts_name, str(timestamps_dest))
            os.unlink(tmp_ts_name)

            logging.info(
                json.dumps(
                    {
                        "event": "generate_with_timestamps_done",
                        "job_id": job_id,
                        "reel_index": reel_index,
                        "duration_seconds": round(duration, 2),
                        "word_count": len(words),
                        "num_lines": len(script_lines),
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
def speak(body: dict):
    import json
    import logging
    from fastapi import Response

    # --- Auth ---
    expected_key = os.environ.get("TTS_API_KEY", "")
    provided_key = body.get("api_key", "")
    if not expected_key or provided_key != expected_key:
        logging.warning(json.dumps({"event": "tts_auth_failed"}))
        return Response(
            content=json.dumps({"error": "unauthorized"}),
            media_type="application/json",
            status_code=401,
        )

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

    # --- Fire-and-forget: spawn the GPU work and return immediately ---
    # The caller (CF Workflow) will poll R2 for the output files instead of
    # waiting for this HTTP response to carry the result. This avoids the
    # 120-second Cloudflare Proxy Read Timeout (524) on long TTS jobs.
    tts = PeterGriffinTTS()
    tts.generate_with_timestamps.spawn(text, job_id, reel_index)

    logging.info(
        json.dumps(
            {
                "event": "generate_speech_spawned",
                "job_id": job_id,
                "reel_index": reel_index,
            }
        )
    )

    return Response(
        content=json.dumps({"accepted": True, "job_id": job_id, "reel_index": reel_index}),
        media_type="application/json",
    )


@app.local_entrypoint()
def main(
    text: str = '[Peter]: "Hey Lois, I\'m a cloud function!"\n[Stewie]: "You imbecile, you\'re a serverless container."',
):
    tts = PeterGriffinTTS()
    result = tts.generate_with_timestamps.remote(text, "test-local", 0)


if __name__ == "__main__":
    app.run()

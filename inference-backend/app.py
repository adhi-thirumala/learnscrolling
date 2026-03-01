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

# --- Text chunking ---
# Chatterbox hardcodes max_new_tokens=1000 (~34 seconds of audio).
# To generate longer audio, we split the script into sentence-level chunks,
# generate audio for each chunk separately, then concatenate.
MAX_WORDS_PER_CHUNK = 50  # ~17 seconds of speech — well within the 1000-token limit


def split_into_chunks(text: str, max_words: int = MAX_WORDS_PER_CHUNK) -> list[str]:
    """Split text into chunks at sentence boundaries, each ≤ max_words words.

    Strategy:
    1. Split text into sentences (on . ! ?)
    2. Greedily pack sentences into chunks up to max_words
    3. If a single sentence exceeds max_words, include it as its own chunk
       (Chatterbox will still handle it — it just gets closer to the token limit)
    """
    # Split on sentence-ending punctuation, keeping the punctuation attached
    sentences = re.split(r"(?<=[.!?])\s+", text.strip())
    sentences = [s.strip() for s in sentences if s.strip()]

    if not sentences:
        return [text]

    chunks = []
    current_chunk: list[str] = []
    current_word_count = 0

    for sentence in sentences:
        sentence_words = len(sentence.split())

        if current_word_count + sentence_words <= max_words:
            current_chunk.append(sentence)
            current_word_count += sentence_words
        else:
            # Flush current chunk if non-empty
            if current_chunk:
                chunks.append(" ".join(current_chunk))
            current_chunk = [sentence]
            current_word_count = sentence_words

    # Flush remaining
    if current_chunk:
        chunks.append(" ".join(current_chunk))

    return chunks


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

        # The model will be downloaded to the volume on the first run
        # and reused from the volume on subsequent container starts
        self.model = ChatterboxTTS.from_pretrained(device="cuda")
        self.whisper_model = whisper.load_model("large", device="cuda")
        self.audio_prompt_path = "/root/petergriffin/literally just peter griffin talking for 8 minutes with almost no background noise.mp3"

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

        # --- 1. Split text into chunks to work around Chatterbox's 1000-token (~34s) limit ---
        chunks = split_into_chunks(text)

        logging.info(
            json.dumps(
                {
                    "event": "text_chunked",
                    "job_id": job_id,
                    "reel_index": reel_index,
                    "num_chunks": len(chunks),
                    "chunk_word_counts": [len(c.split()) for c in chunks],
                }
            )
        )

        # --- 2. Generate audio for each chunk separately ---
        chunk_wavs = []
        for i, chunk_text in enumerate(chunks):
            logging.info(
                json.dumps(
                    {
                        "event": "chunk_generate_start",
                        "job_id": job_id,
                        "reel_index": reel_index,
                        "chunk_index": i,
                        "chunk_words": len(chunk_text.split()),
                    }
                )
            )

            wav = self.model.generate(
                chunk_text,
                audio_prompt_path=self.audio_prompt_path,
                exaggeration=0.7,
            )
            wav = wav.cpu()
            if wav.dim() == 1:
                wav = wav.unsqueeze(0)
            chunk_wavs.append(wav)

            logging.info(
                json.dumps(
                    {
                        "event": "chunk_generate_done",
                        "job_id": job_id,
                        "reel_index": reel_index,
                        "chunk_index": i,
                        "chunk_duration_seconds": round(
                            wav.shape[1] / self.model.sr, 2
                        ),
                    }
                )
            )

        # --- 3. Concatenate all chunk WAVs ---
        full_wav = torch.cat(chunk_wavs, dim=1)

        logging.info(
            json.dumps(
                {
                    "event": "chunks_concatenated",
                    "job_id": job_id,
                    "reel_index": reel_index,
                    "total_raw_duration_seconds": round(
                        full_wav.shape[1] / self.model.sr, 2
                    ),
                }
            )
        )

        # --- 4. Speed up 1.15x without pitch shift using ffmpeg ---
        with (
            tempfile.NamedTemporaryFile(suffix=".wav") as tmp_in,
            tempfile.NamedTemporaryFile(suffix=".wav") as tmp_out,
        ):
            torchaudio.save(tmp_in.name, full_wav, self.model.sr, format="wav")
            result = subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-i",
                    tmp_in.name,
                    "-filter:a",
                    "atempo=1.15",
                    "-ar",
                    str(self.model.sr),
                    tmp_out.name,
                ],
                capture_output=True,
            )
            if result.returncode != 0:
                logging.error(
                    json.dumps(
                        {
                            "event": "ffmpeg_error",
                            "stderr": result.stderr.decode(),
                        }
                    )
                )
                raise RuntimeError(
                    f"ffmpeg tempo adjustment failed: {result.stderr.decode()}"
                )

            # --- 5. Run Whisper on the full sped-up audio for word timestamps ---
            result = self.whisper_model.transcribe(
                tmp_out.name, word_timestamps=True, language="en"
            )

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

            # --- 6. Write final WAV to R2 ---
            # CloudBucketMount (mountpoint-s3) does not support seek — torchaudio.save
            # writes WAV headers then seeks back to update the size field, which fails
            # silently. Write to a local temp file first, then copy to R2.
            audio_key = f"audio/{job_id}/{reel_index}.wav"
            audio_dest = Path(R2_MOUNT_PATH) / audio_key
            audio_dest.parent.mkdir(parents=True, exist_ok=True)

            with tempfile.NamedTemporaryFile(suffix=".wav") as tmp_audio:
                torchaudio.save(tmp_audio.name, wav_sped, int(new_sr), format="wav")
                shutil.copy(tmp_audio.name, str(audio_dest))

            # --- 7. Write timestamps JSON to R2 ---
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
                        "num_chunks": len(chunks),
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
def main(text: str = "Hey Lois, I'm a cloud function!"):
    tts = PeterGriffinTTS()
    result = tts.generate_with_timestamps.remote(text, "test-local", 0)


if __name__ == "__main__":
    app.run()

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


@app.cls(
    image=chatterbox_image,
    gpu="A100",
    scaledown_window=300,
    # Mount the volume to persist the model weights
    volumes={CACHE_DIR: cache_volume},
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

        from chatterbox.tts_turbo import ChatterboxTurboTTS

        # The model will be downloaded to the volume on the first run
        # and reused from the volume on subsequent container starts
        self.model = ChatterboxTurboTTS.from_pretrained(device="cuda")
        self.audio_prompt_path = "/root/petergriffin/literally just peter griffin talking for 8 minutes with almost no background noise.mp3"

    @modal.method()
    def generate(self, text: str):
        import torchaudio

        # Generate the audio using Peter Griffin's voice as the prompt
        wav = self.model.generate(text, audio_prompt_path=self.audio_prompt_path, exaggeration=0.7)

        wav = wav.cpu()

        if wav.dim() == 1:
            wav = wav.unsqueeze(0)

        # Speed up 1.5x without pitch shift
        effects = [['tempo', '1.5']]
        wav_sped, new_sr = torchaudio.sox_effects.apply_effects_tensor(wav, self.model.sr, effects)
        # Save to buffer
        buffer = io.BytesIO()
        torchaudio.save(buffer, wav_sped, int(new_sr), format="wav")
        return buffer.getvalue()


@app.function(image=chatterbox_image)
@modal.fastapi_endpoint(method="POST")
def speak(body: dict):
    api_key = "d736adf4b03b0519393e6d5cbedc73bb81539edb2771d856bff265e59e44f559"
    import json
    import logging
    from fastapi import Response

    text = body.get("text", "")
    logging.info(json.dumps({"event": "speak_request", "text_length": len(text)}))

    if not text:
        logging.warning(json.dumps({"event": "speak_request_missing_text"}))
        return Response(
            content=json.dumps({"error": "text field is required"}),
            media_type="application/json",
            status_code=400,
        )

    tts = PeterGriffinTTS()
    audio_data = tts.generate.remote(text)

    logging.info(json.dumps({"event": "speak_response", "audio_bytes": len(audio_data)}))
    return Response(content=audio_data, media_type="audio/wav")


@app.local_entrypoint()
def main(text: str = "Hey Lois, I'm a cloud function!"):
    tts = PeterGriffinTTS()
    audio_bytes = tts.generate.remote(text)

    with open("output.wav", "wb") as f:
        f.write(audio_bytes)
    print("Generated audio saved to output.wav")


if __name__ == "__main__":
    app.run()

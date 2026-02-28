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


@app.cls(
    image=chatterbox_image,
    gpu="A100",
    scaledown_window=300,
    # Mount the volume to persist the model weights
    volumes={CACHE_DIR: cache_volume},
    # Requires a Modal Secret named 'huggingface-secret' with HF_TOKEN key
    secrets=[modal.Secret.from_name("huggingface-secret")],
)
class PeterGriffinTTS:
    @modal.enter()
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
        wav = self.model.generate(text, audio_prompt_path=self.audio_prompt_path)

        # Save to buffer
        buffer = io.BytesIO()
        torchaudio.save(buffer, wav, self.model.sr, format="wav")
        return buffer.getvalue()


@app.function(image=chatterbox_image)
@modal.fastapi_endpoint()
def speak(text: str):
    from fastapi import Response

    tts = PeterGriffinTTS()
    audio_data = tts.generate.remote(text)

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

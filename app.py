import modal
import io

# Define the image with necessary dependencies and the audio files
# We use .add_local_dir to bake the Peter Griffin audio into the image
chatterbox_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install(
        "chatterbox-tts==0.1.6",
        "torch",
        "torchaudio",
        "peft",
        "transformers"
    )
    .add_local_dir("./petergriffin", remote_path="/root/petergriffin")
)

app = modal.App("peter-griffin-chatterbox")

@app.cls(
    image=chatterbox_image,
    gpu="A100", 
    container_idle_timeout=300,
    # Requires a Modal Secret named 'huggingface-secret' with HF_TOKEN key
    # Create it via: modal secret create huggingface-secret HF_TOKEN=your_token
    secrets=[modal.Secret.from_name("huggingface-secret")]
)
class PeterGriffinTTS:
    @modal.enter()
    def load_model(self):
        from chatterbox.tts_turbo import ChatterboxTurboTTS
        # Load the Turbo model for fast inference
        self.model = ChatterboxTurboTTS.from_pretrained(device="cuda")
        self.audio_prompt_path = "/root/petergriffin/literally just peter griffin talking for 8 minutes with almost no background noise.mp3"

    @modal.method()
    def generate(self, text: str):
        import torchaudio
        
        # Generate the audio using Peter Griffin's voice as the prompt
        wav = self.model.generate(
            text, 
            audio_prompt_path=self.audio_prompt_path
        )
        
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
    print(f"Generated audio saved to output.wav")

if __name__ == "__main__":
    app.run()

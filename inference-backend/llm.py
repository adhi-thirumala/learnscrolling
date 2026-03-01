import modal
import textwrap

# vllm_image = (
#     modal.Image.from_registry("nvidia/cuda:12.8.0-devel-ubuntu22.04", add_python="3.12")
#     .apt_install("git")  # <--- THIS IS THE MAGIC FIX!
#     .pip_install("huggingface-hub")
#     # Install transformers directly from GitHub source to get Qwen 3.5 support
#     .pip_install("git+https://github.com/huggingface/transformers.git")
#     # Force install the nightly build of vLLM which contains the newest kernels
#     .run_commands("pip install -U vllm --extra-index-url https://wheels.vllm.ai/nightly")
#     .add_local_dir("./textbook", remote_path="/root/petergriffin")
# )

vllm_image = (
    modal.Image.from_registry("nvidia/cuda:12.8.0-devel-ubuntu22.04", add_python="3.12")
    # Pin transformers to a stable v4 version to fix the tokenizer crash
    .pip_install("vllm==0.7.3", "huggingface-hub", "transformers<5.0.0")
    .add_local_dir("./textbook", remote_path="/root/petergriffin")
)

app = modal.App("cs374-peter-griffin-reels")


# 2. Define the Modal Class to hold the massive model in VRAM
# Using an A100-80GB which is perfect for a 32B model in 16-bit precision
@app.cls(
    image=vllm_image,
    gpu="H100",
    timeout=1800,
    enable_memory_snapshot=True,
    experimental_options={"enable_gpu_snapshot": True},
)
class ReelGenerator:
    @modal.enter(snap=True)
    def load_model(self):
        print("Loading Qwen 2.5 32B into VRAM... grab a coffee ☕")
        from vllm import LLM

        # This only runs once when the container starts
        self.llm = LLM(
            model="Qwen/Qwen2.5-32B-Instruct",
            tensor_parallel_size=1,
            max_model_len=8192,
            enforce_eager=True,
        )
        print("Model loaded successfully!")

    # def load_model(self):
    #     print("Loading Qwen 3.5 27B into VRAM... grab a coffee ☕")
    #     from vllm import LLM

    #     self.llm = LLM(
    #         model="Qwen/Qwen3.5-27B",
    #         tensor_parallel_size=1,
    #         max_model_len=8192,
    #         enforce_eager=True
    #     )
    #     print("Model loaded successfully!")

    # def load_model(self):
    #     from vllm import LLM
    #     print("Loading deepseek")
    #     self.llm = LLM(
    #         # Swapping to Mistral for better comedic timing and high speed
    #         model="mistralai/Mistral-Nemo-Instruct-2407",
    #         tensor_parallel_size=1,
    #         max_model_len=8192,
    #         enforce_eager=True,
    #         tokenizer_mode="mistral"
    #     )
    #     print("Model loaded successfully!")

    @modal.method()
    def generate_script(self, text_chunk: str):
        from vllm import SamplingParams

        system_prompt = """
        Act as a scriptwriter for highly engaging, fast-paced TikTok/Instagram Reels. I am going to provide you with a chapter from a theoretical computer science textbook.

        Your job is to extract the single most important concept from this text (e.g., how the "Recursion Fairy" works, induction, or finite automata) and convert it into a 60-second back-and-forth dialogue between two characters:

        Character A (Stewie Griffin persona): Highly intelligent, articulate, and slightly condescending. He acts as the interrogator, asking piercing questions to test the other character's knowledge of the algorithms.

        Character B (Peter Griffin persona): Loud, confident, but easily confused. He tries to explain the complex algorithmic concepts using absurd, everyday analogies (like drinking beer, watching TV, or fighting a giant chicken). He gets the core idea right but explains it in a hilariously stupid way.

        Formatting & TTS Rules:

        Format the output exactly like a script: [Stewie]: "..." and [Peter]: "..."

        Do not include any stage directions, visual cues, or emojis. The TTS engine will read them out loud and ruin the video.

        Translate all math: Do not use symbols like $\Sigma$ or $O(n^2)$. Write them out exactly as they should be spoken (e.g., "Big O of N squared").

        Length: Keep the entire script strictly under 180 words. The pacing must be relentless. Remember, Peter is primarily the instructor.
        """

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": f"Textbook chunk to adapt:\n{text_chunk}"},
        ]

        # Temperature 0.7 gives good creative leeway for jokes while staying on topic
        sampling_params = SamplingParams(temperature=0.7, max_tokens=800)
        # sampling_params = SamplingParams(temperature=0.7, max_tokens=2048)
        outputs = self.llm.chat(messages=messages, sampling_params=sampling_params)

        return outputs[0].outputs[0].text


# 3. Local execution block: This part runs locally on your machine
@app.local_entrypoint()
def main():
    print("Reading local file cs374ch1.txt...")
    try:
        with open(
            "./textbook/cs374ch1.txt", "r", encoding="utf-8", errors="replace"
        ) as file:
            full_text = file.read()
    except FileNotFoundError:
        print(
            "Error: Could not find 'cs374ch1.txt'. Make sure it is in the same folder as this script."
        )
        return

    # Mechanically break the dense chapter into ~500 word pieces (~3000 characters)
    # This prevents the Reel from trying to cover too many concepts at once
    chunks = textwrap.wrap(
        full_text, width=3000, break_long_words=False, replace_whitespace=False
    )

    print(f"Broke chapter into {len(chunks)} Reel-sized chunks.")
    print("Spinning up cloud GPU and sending Chunk 1 to Modal...\n")

    # Instantiate the remote class (this triggers the model download/load)
    generator = ReelGenerator()

    # We are just processing the first chunk to test it out
    script = generator.generate_script.remote(chunks[0])

    print("--- INSTAGRAM REEL SCRIPT ---\n")
    print(script)
    print("\n-----------------------------")

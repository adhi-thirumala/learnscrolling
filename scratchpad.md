# Scratchpad

## Lessons Learned

### resemble-perth / chatterbox-tts NoneType error
- `resemble-perth` has a try/except in `__init__.py` that silently sets `PerthImplicitWatermarker = None` when the import fails
- This causes `TypeError: 'NoneType' object is not callable` when chatterbox tries to call `perth.PerthImplicitWatermarker()`
- The real error is hidden — it's a missing system dependency, not a Python issue
- `resemble-perth` requires system packages: `libsox-dev`, `sox`, `rubberband-cli` (for the `sox` and `pyrubberband` Python packages)
- Fix: add these to `.apt_install()` in the Modal image definition
- Lesson: when you see `'NoneType' object is not callable`, check for conditional imports that silently swallow ImportErrors

### Actual root cause: missing `setuptools` (pkg_resources)
- The PyPI release of `resemble-perth` 1.0.1 uses `from pkg_resources import resource_filename` in `perth/perth_net/__init__.py`
- The GitHub master branch was updated to use `importlib.resources` but that change hasn't been released to PyPI yet
- `uv` doesn't install `setuptools` by default (unlike pip), so `pkg_resources` is missing
- Fix: add `setuptools` to `pyproject.toml` dependencies
- The diagnostic approach of importing directly (bypassing the try/except) was key to finding this
- Lesson: when debugging silent import failures, bypass the try/except to see the real error

### REAL root cause: wrong `perth` PyPI package shadowing `resemble-perth`
- PyPI has TWO packages that provide a `perth` module: `perth` (1.0.0, 1.7KB, unrelated) and `resemble-perth` (1.0.1, 34MB, the real one)
- `chatterbox-tts` depends on `resemble-perth` which installs as the `perth` Python module
- Adding `perth>=1.0.0` to pyproject.toml installed the WRONG tiny package, which shadowed the real `perth` module from `resemble-perth`
- The wrong package doesn't have `PerthImplicitWatermarker`, so `perth.__init__.py`'s try/except set it to `None`
- Fix: remove `perth` from pyproject.toml — `resemble-perth` is already pulled in transitively via `chatterbox-tts`
- Lesson: ALWAYS check if a PyPI package name matches its import name — they can differ and conflict
- Lesson: use `run_commands` in Modal image builds to validate imports at build time, not runtime

### uv_sync vs pip_install on Modal — setuptools not surviving to runtime
- `uv_sync` installs packages into `/.uv/.venv/` during image build, but Modal's runtime mounts a separate Python environment at `/pkg/`
- Even though `setuptools` was in `pyproject.toml` and the lockfile, and `uv sync` installed it at build time, it was NOT available at runtime
- `run_commands("uv pip install setuptools")` also showed "Audited 1 package" (already installed) but still missing at runtime
- `.pip_install()` uses Modal's native pip integration which installs into the environment Modal's runtime actually uses — so packages survive
- **Resolution**: switched from `.uv_sync()` to `.pip_install()` with all deps listed explicitly
- Lesson: when using Modal, `.pip_install()` is more reliable than `.uv_sync()` for packages that need `setuptools`/`pkg_resources`
- Lesson: build-time validation (`run_commands`) can pass while runtime still fails due to different environments
- Once `resemble-perth` releases a new version using `importlib.resources` instead of `pkg_resources`, `uv_sync` should work fine

### uv sync Resolution
we resolves uv sync by takng a version of perth from github which has the correct APIs - specifying this in pyproject.toml solves our problems

### System Design Complete (2026-02-28)
- Full design documented in DESIGN.md
- Architecture: Cloudflare Workflow orchestrates the pipeline (parse -> chunk -> LLM -> TTS -> video)
- Worker handles API routes + SSE streaming to frontend
- Modal handles all heavy compute: LLM script gen, Chatterbox TTS, Whisper alignment, FFmpeg compositing
- Presigned R2 URLs for Modal -> R2 uploads (no credential sprawl)
- Whisper needed for word-level subtitle timestamps (Chatterbox doesn't support timestamps natively)
- D1 for job/chunk state tracking, R2 for file storage
- Assets (Minecraft MP4, Peter Griffin PNG) live on a shared Modal Volume
- All chunks processed in parallel for speed
- LLM model choice still TBD -- interface designed to be model-agnostic

### Design Refinements (2026-02-28)
- Consolidated TTS + Whisper into a single Modal container (A100). Whisper `base` is tiny (~150MB), shares the GPU, and avoids shipping WAV bytes over the network between containers. New method: `generate_with_timestamps()`.
- FFmpeg video compositor moved from CPU to dedicated A10G GPU. NVENC accelerates H.264 encoding (~5s vs ~15-30s). Kept separate from TTS to avoid wasting A100 time on CPU-bound filter work.
- R2 is required (not optional) for PDF handoff -- Workflow event payload limit is 1 MiB, PDFs are up to 10 MB. R2 acts as durable handoff between the upload request and the async Workflow.
- Presigned URLs are safe: time-limited, operation-scoped, HMAC-signed. Modal gets write access to exactly one R2 key for a limited window. No R2 credentials leave Cloudflare.

### Cloudflare Workflow Scaffolded (2026-02-28)
- Added R2 bucket binding (`BUCKET` -> `learnscrolling-assets`) and Workflow binding (`REEL_WORKFLOW` -> `reel-generation`) to wrangler.jsonc
- Created `worker/workflow.ts` with `ReelGenerationWorkflow` class extending `WorkflowEntrypoint`
- Step 1 (`parse-pdf`): fetches PDF from R2, uses `unpdf` (serverless PDF.js build) to extract text. Has retry config (3 retries, 5s delay, linear backoff, 2min timeout). Warns if extracted text approaches 1 MiB step state limit.
- Step 2 (`chunk-text`): stub -- returns entire document as single chunk. TODO: implement two-stage chunking.
- Updated `worker/index.ts`: upload handler now stores PDF in R2 at `pdfs/{jobId}.pdf` and triggers Workflow via `env.REEL_WORKFLOW.create()`
- `unpdf` does NOT need `nodejs_compat` -- it ships its own serverless PDF.js build with zero dependencies. Keeping `nodejs_compat` anyway per CF best practices.
- `wrangler types` generates `worker-configuration.d.ts` with the global `Env` interface. Had to add it to `tsconfig.worker.json`'s `include` array for tsc to pick it up.
- The PDF.js serverless bundle from `unpdf` is ~1.9 MB in the built output -- well within the 10 MB Worker script limit.
- Enabled `observability: { enabled: true }` in wrangler config for structured log visibility.
- Switched Worker routing to Hono. Gives us `cors()` middleware, `logger()`, typed path params (`c.req.param("id")`), and `c.json()` helpers. The Hono app handles `/api/*` routes, everything else falls through to `env.ASSETS.fetch()` for the SPA. Workflow re-export still works fine at the top of the file.
- Replaced the `chunk-text` Workflow step with `generate-scripts`. Instead of chunking in JS, we send the full extracted text to an LLM in one shot. The LLM decides how to split the content and generates all reel scripts at once. Single LLM call = simpler, but requires a large context window model (128K+).
- Created `worker/llm.ts` with the system prompt, `ReelScript` types, and `generateScripts()` function. The file doubles as a spec for the person implementing the LLM endpoint -- it documents the exact OpenAI-compatible request/response contract.
- LLM env vars: `LLM_API_URL` and `LLM_MODEL` are in `wrangler.jsonc` as `vars`. `LLM_API_KEY` is a secret (set via `wrangler secret put LLM_API_KEY`). Added `worker/env.d.ts` to declare the secret type since `wrangler types` only generates types for vars, not secrets.
- generate-scripts retry config: 3 retries, 30s initial delay, exponential backoff, 5 min timeout. Each attempt gets the full 5 minutes -- the delay is only the wait between retries, not a response timeout.

### Whisper Word-Level Timestamps Integration (2026-02-28)
- Chatterbox TTS does NOT output word-level timestamps — only raw audio tensors
- Added `openai-whisper` to pyproject.toml, loaded Whisper `base` (~150MB) in the same `@modal.enter(snap=True)` as Chatterbox so both models are in the GPU memory snapshot
- New method `generate_with_timestamps()`: Chatterbox -> sox tempo 1.5x -> Whisper on sped-up audio -> returns `{audioWavBytes, wordTimestamps, durationSeconds}`
- Critical: Whisper runs on the POST-tempo audio so timestamps match the final delivered WAV. If we ran on original and scaled by 1/1.5, rounding errors would accumulate.
- Whisper `base` on clean TTS audio (no background noise) should give near-perfect word-level alignment
- Next step: use these word timestamps to generate `.ass` subtitle files for TikTok-style overlays in the FFmpeg video compositor

### TTS API Refactor — R2 Cloud Bucket Mount (2026-02-28)
- Replaced presigned URL approach with `modal.CloudBucketMount` — mounts R2 bucket directly as a filesystem at `/root/r2`
- Modal writes files directly: `audio/{jobId}/{reelIndex}.wav` and `timestamps/{jobId}/{reelIndex}.json`
- No boto3 needed, no presigned URLs — just filesystem writes via mountpoint-s3
- Removed old `speak()` and `speak_with_timestamps()` endpoints, replaced with single `POST /generate_speech`
- API key auth: `tts-api-key` Modal Secret provides `TTS_API_KEY` env var, checked against `api_key` field in request body
- Removed hardcoded API key (was on old `speak()` endpoint)
- Input: `{ api_key, text, job_id, reel_index }` — see `API.md` for full contract
- Output: `{ success, audioKey, timestampsKey, durationSeconds, wordCount }`
- R2 credentials stored as Modal Secret `r2-secret` with `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
- `bucket_endpoint_url` is hardcoded at module level using `CF_ACCOUNT_ID` env var — Modal secrets are NOT available at import time, so this must be a system env var or hardcoded. Account ID is not secret (it's in every R2 public URL).
- `CloudBucketMount` goes inline in the `volumes={}` dict on the `@app.cls` decorator, NOT defined as a module-level variable (Modal resolves it lazily)
- CloudBucketMount limitation: files cannot be opened in append mode, must write in truncate mode. Fine for our use case (write-once).
- The `r2-secret` only needs to be on the `@app.cls` (where the mount is), NOT on the `@app.function` endpoint — the endpoint just calls `.remote()` into the cls
- Local entrypoint now also writes to R2 (tests the full pipeline including upload)

### Workflow.ts Fixed + Audio Step Added (2026-02-28)
- workflow.ts had duplicate PDF delete (once in step 1, once in separate cleanup-pdf step) plus stray `},` and `);` causing syntax errors. Inconsistent indentation throughout.
- Fixed: removed duplicate delete from step 1, kept it in dedicated cleanup-pdf step. Fixed all syntax and indentation.
- Added Step 4: `generate-audio-{index}` — calls Modal TTS endpoint (`TTS_API_URL`) for each reel script in parallel via `Promise.all` + `step.do`. Sends `{ api_key, text, job_id, reel_index }`, expects `{ success, audioKey, timestampsKey, durationSeconds, wordCount }`.
- Added `TTS_API_URL` as a wrangler var (set to Modal endpoint URL after deploy) and `TTS_API_KEY` as a wrangler secret. Both declared in `worker/env.d.ts`.
- The TTS_API_KEY is shared between the Cloudflare Worker (sender) and Modal `tts-api-key` secret (receiver) — same key, set in both places.

### Video Compositor Implemented (2026-02-28)
- New file: `inference-backend/compositor.py` — separate Modal App (`learnscrolling-compositor`)
- **Image**: `nvidia/cuda:12.6.0-runtime-ubuntu24.04` base + BtbN static FFmpeg (GPL build with NVENC) + `libass9` for subtitle rendering
- **GPU**: H100 — 8th gen NVENC encoder, fastest available. Overkill cost-wise but fast.
- **R2**: Same `CloudBucketMount` pattern as TTS. Reads `audio/{jobId}/{reelIndex}.wav` + `timestamps/{jobId}/{reelIndex}.json`, writes `reels/{jobId}/{reelIndex}.mp4`.
- **Media assets**: Baked into container image via `add_local_dir("./petergriffin", remote_path="/root/media")` — same pattern as TTS app. No Modal Volume needed. Files referenced by their original filenames on disk.
- **ASS subtitle generation**: TikTok karaoke style with `\k` tags for per-word highlight timing. 4 words per line, DejaVu Sans 72pt bold, white on black outline, centered near bottom. `generate_ass_subtitles()` function takes word timestamps and returns complete ASS file content.
- **FFmpeg pipeline**: `-ss` random offset into Minecraft → scale/crop to 1080x1920 → overlay Peter Griffin PNG bottom-left → burn in ASS subtitles → `h264_nvenc` encode with `-preset p4 -cq 23` → AAC audio 128kbps → `faststart` flag
- **Key detail**: FFmpeg filter graph is CPU-bound (scale, crop, overlay, ASS text rasterization). Only the final H.264 encode step is GPU-accelerated via NVENC. On H100, encode is ~2-3s for a 60s clip.
- **Endpoint**: `POST /composite_video` with same auth pattern (api_key in body vs `COMPOSITOR_API_KEY` from Modal Secret)
- **Workflow Step 5**: `composite-video-{index}` in workflow.ts, parallel via `Promise.all`, 10 min timeout, 2 retries with exponential backoff
- Added `VIDEO_COMPOSITOR_URL` (wrangler var) and `VIDEO_COMPOSITOR_API_KEY` (wrangler secret) to env.d.ts and wrangler.jsonc
- BtbN FFmpeg static builds are self-contained binaries — they include NVENC code compiled in. At runtime they dynamically link against `libnvidia-encode.so` which Modal provides via driver injection on GPU machines.
- TODO: verify `ffmpeg -encoders | grep nvenc` actually works at runtime on Modal H100 (it's verified at image build time but driver libs are injected at runtime)
- TODO: the `libass` ASS filter in BtbN static FFmpeg may need the system `libass.so` — that's why we `apt_install("libass9", "libass-dev")`
- TODO: if Minecraft source video isn't H.264, keyframe-based seek (`-ss` before `-i`) may be slow. Verify with ffprobe.

### Compositor GPU Downgrade: H100 -> T4 (2026-02-28)
- `h264_nvenc` failed with `OpenEncodeSessionEx failed: unsupported device` on H100
- The NVENC encoder is present in the static FFmpeg binary but the H100's driver/NVENC session couldn't be opened (possible Modal driver injection issue, or H100 NVENC availability issue)
- H100 was overkill for video encoding anyway — NVENC is the same speed on any GPU that supports it
- Switched to T4 (Turing, SM75) — cheapest GPU on Modal with NVENC support, ~$0.07/hr vs ~$3.95/hr for H100
- T4 supports the newer `p1`-`p7` preset naming scheme (Turing+), so `-preset p4` still works
- The compositor doesn't do any ML inference — it only needs NVENC for H.264 encoding. T4 is ideal.
- If T4 also has NVENC issues, the fallback would be `libx264` on CPU (no GPU needed at all)

### Compositor NVENC Fix: Use System FFmpeg Instead of Static Build (2026-02-28)
- T4 also failed with `OpenEncodeSessionEx failed: unsupported device` — same error as H100
- Root cause: the BtbN static FFmpeg binary bundles NVENC *code* but dynamically links against `libnvidia-encode.so` at runtime. Modal injects NVIDIA drivers at runtime, but the static binary couldn't find/use them.
- Fix: replaced the BtbN static FFmpeg download with `apt_install("ffmpeg")`. The Debian-packaged FFmpeg is built with NVENC support and correctly links against the system NVIDIA libraries that Modal injects.
- Removed `wget`, `xz-utils` from apt_install (only needed for the static build download)
- Removed the `run_commands()` block that downloaded/extracted the static build
- Lesson: on Modal GPU machines, prefer system-packaged FFmpeg over static builds. Modal injects NVIDIA driver libs at runtime, and system FFmpeg knows how to find them. Static builds may not.

### Chatterbox 34-Second Audio Cutoff (2026-02-28)
- **Root cause**: Chatterbox hardcodes `max_new_tokens=1000` in `tts.py:227` when calling `self.t3.inference()`. This caps audio generation at ~1000 speech tokens ≈ 34 seconds.
- The `generate()` method does NOT expose `max_new_tokens` as a parameter — it's buried inside the method body.
- Both original Chatterbox and Chatterbox-Turbo have the same limit: `max_new_tokens=1000` / `max_gen_len=1000` in `t3.py`'s `inference()` and `inference_turbo()` methods respectively.
- The T3 model's `inference()` method DOES accept `max_new_tokens` as an optional parameter (defaults to `self.hp.max_speech_tokens`), but `tts.py` hardcodes it to 1000 with a `# TODO: use the value in config` comment.
- **Symptoms**: Audio cuts off mid-sentence at exactly ~34 seconds. All words from the input script are present in the generated speech, it just stops abruptly.
- **Fix**: Sentence-level chunking. Split input text into ~50-word chunks at sentence boundaries, generate audio for each chunk separately, then `torch.cat()` the WAV tensors before speed adjustment and Whisper alignment.
- **Why not monkey-patch**: Raising `max_new_tokens` to 2000+ might work but risks quality degradation — the model may not have been trained on sequences that long, and autoregressive quality tends to degrade with length.
- **Why not switch models**: Considered Chatterbox-Turbo, but it has the same 1000-token limit. Other models (F5-TTS, XTTS-v2) would require significant integration work.
- Lesson: always check for hardcoded generation limits in TTS/LLM libraries. The `# TODO` comment in the source was a dead giveaway.
- Also cleaned up dead code in `speak()` endpoint: removed unreachable `return Response(content=audio_data, ...)` that referenced undefined `audio_data` variable, and removed hardcoded API key.

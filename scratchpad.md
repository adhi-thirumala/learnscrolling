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

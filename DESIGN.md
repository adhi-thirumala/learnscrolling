# LearnScrolling System Design

> PDF textbook in, Peter Griffin Instagram Reels out.

Upload a textbook PDF. Get back a series of ~60-second vertical videos featuring Peter Griffin explaining the content, voiced by AI TTS, with word-by-word subtitles over Minecraft parkour gameplay.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                           CLOUDFLARE                                 │
│                                                                      │
│  ┌───────────┐     ┌────────────┐     ┌───────────────────────────┐ │
│  │  Frontend  │────▶│   Worker   │────▶│   Cloudflare Workflow     │ │
│  │  (React)   │◀───│  (Hono)   │     │   "reel-generation"       │ │
│  │           SSE   │            │     │                           │ │
│  └───────────┘     └─────┬──────┘     │  Step 1: Parse PDF        │ │
│                          │            │  Step 2: Generate scripts ─│─│──▶ LLM (OpenAI-compat)
│                     ┌────┴─────┐      │  Step 3: Generate audio   ─│─│──▶ Modal TTS + Whisper
│                     │    D1    │      │  Step 4: Composite video  ─│─│──▶ Modal FFmpeg (A10G)
│                     └──────────┘      │  Step 5: Finalize job      │ │
│                                       └───────────────────────────┘ │
│                     ┌──────────┐                                     │
│                     │    R2    │  ← PDFs in, MP4 reels out           │
│                     │  (files) │                                     │
│                     └──────────┘                                     │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│                             MODAL                                    │
│                                                                      │
│  ┌──────────────────┐  ┌───────────────────┐  ┌──────────────────┐  │
│  │  LLM Service     │  │  Peter Griffin    │  │  Video           │  │
│  │  (script gen)    │  │  TTS + Whisper    │  │  Compositor      │  │
│  │  GPU: TBD        │  │  GPU: A100        │  │  GPU: A10G       │  │
│  └──────────────────┘  └───────────────────┘  └──────────────────┘  │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────────┐│
│  │  Modal Volume: learnscrolling-assets                             ││
│  │  ├── minecraft_parkour.mp4   (background gameplay footage)       ││
│  │  └── peter_griffin.png       (character overlay image)           ││
│  └──────────────────────────────────────────────────────────────────┘│
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

## The Journey of a PDF

### Phase 1: Upload (Frontend -> Worker -> R2)

1. User drops a PDF on the React frontend (drag-and-drop or file picker).
2. Frontend POSTs to `/api/upload` as `FormData`.
3. Worker validates the file:
   - Must be a PDF (`application/pdf`)
   - Must be <= 10 MB
4. Worker uploads the PDF to **R2** at key `pdfs/{jobId}.pdf`.
5. Worker creates a job record in **D1** with status `queued`.
6. Worker triggers a **Cloudflare Workflow** instance (`reel-generation`), passing `{ jobId, pdfKey }`.
7. Worker returns `{ jobId }` to the frontend.
8. Frontend opens an SSE connection to `/api/events/{jobId}`.

### Phase 2: Parse PDF (Workflow Step 1, in Worker)

9. **Step 1 -- `parse-pdf`**: The Workflow fetches the PDF from R2 and extracts text using `unpdf` (a lightweight JS PDF parsing library). This runs inside the Workflow step's Worker context. Returns raw text. For a 10 MB PDF this should use well under the 30-second CPU time budget since PDF text extraction is not computationally heavy -- and `fetch()` calls to R2 do not count toward CPU time.

### Phase 3: Script Generation (Workflow Step 2, LLM)

10. **Step 2 -- `generate-scripts`**: A single LLM call that handles both content splitting and script writing:
    - Sends the **full extracted text** to an OpenAI-compatible LLM endpoint in one request.
    - The system prompt instructs the LLM to: (a) identify natural topic boundaries, (b) break the content into reel-sized pieces, and (c) write a ~150-word Peter Griffin narration script for each piece.
    - Uses **structured output** via `response_format: { type: "json_schema" }` with a strict JSON Schema. On vLLM, this triggers guided decoding (outlines/xgrammar) which enforces the schema at the token level -- the model physically cannot produce output that doesn't match.
    - The LLM determines the number of reels based on document content (typical range: 3-20 reels).
    - Returns an array of `ReelScript` objects: `{ index, title, script, sourceSection }`.
    - Retry config: 3 retries, 30s initial delay, exponential backoff, 5-minute timeout per attempt.
    - **Why a single LLM call instead of chunk-then-generate?** The LLM is better at identifying content boundaries than heuristic text splitting. It sees the full document context, can merge small topics and split complex ones intelligently, and produces scripts that are self-contained without redundant overlap.
    - **Requirement**: The model must have a large enough context window (128K+ tokens) to handle the full PDF text plus output.

### Phase 4: TTS Audio Generation (Workflow Step 3, Modal Chatterbox + Whisper)

11. **Step 3 -- `generate-audio`**: For each script, **in parallel**:
    - Calls a single Modal endpoint (`generate_with_timestamps`) that does both TTS and alignment in one container:
      1. Chatterbox generates WAV audio from the script text using Peter Griffin's voice.
      2. Whisper runs on the generated WAV (in the same process, on the same GPU) to extract **word-level timestamps**.
    - This is consolidated into one function because: (a) both need GPU, (b) the WAV never leaves the container -- no network hop between separate TTS and Whisper services, (c) Whisper `base` is tiny and adds negligible overhead to the A100 already running Chatterbox.
    - Chatterbox does not natively output word timestamps, but since the audio is clean TTS output (no background noise), even Whisper `base` gives near-perfect word-level alignment.
    - Returns `{ reelIndex, audioWavBytes, wordTimestamps, durationSeconds }`.
    - Updates each reel's status in D1 to `audio_done`.

### Phase 5: Video Compositing (Workflow Step 4, Modal FFmpeg on A10G)

12. **Step 4 -- `composite-video`**: For each audio clip, **in parallel**:
    - The Worker generates a **presigned R2 PUT URL** scoped to `reels/{jobId}/{reelIndex}.mp4` with a short expiration (e.g., 15 minutes). This URL is passed to Modal.
    - Calls the Modal video compositor endpoint (running on A10G GPU). The Modal function:
      1. Reads Minecraft parkour MP4 from the Modal Volume.
      2. Picks a random start offset and extracts a clip matching the audio duration.
      3. Overlays the Peter Griffin PNG image (from Modal Volume).
      4. Generates word-by-word ASS subtitles from the word timestamps (TikTok/Reels style -- current word highlighted, bold outlined text with shadow).
      5. Composites everything via FFmpeg with NVENC GPU-accelerated encoding: `minecraft_clip + audio + subtitles + peter_image -> final_reel.mp4`
      6. Uploads the final MP4 directly to R2 using the presigned PUT URL.
    - Modal returns `{ success: true, r2Key }` to the Workflow.
    - Updates each reel's status in D1 to `complete` and stores the `reel_r2_key`.

### Phase 6: Finalize (Workflow Step 5)

13. **Step 5 -- `finalize-job`**: Marks the overall job as `complete` in D1. Updates `completed_reels` count.

### Phase 7: Frontend Gets Updates (SSE, throughout)

15. Throughout the entire pipeline, the SSE endpoint `/api/events/{jobId}`:
    - The Worker reads job and reel status from D1.
    - Polls D1 every ~2-3 seconds.
    - Streams events to the frontend as they happen:
      ```
      event: job_started
      data: {"jobId":"abc","totalReels":8}

      event: scripts_generated
      data: {"jobId":"abc","totalReels":8,"titles":["What Even Is Thermodynamics","..."]}

      event: reel_audio_done
      data: {"reelIndex":0,"durationSeconds":58.3}

      event: reel_complete
      data: {"reelIndex":0,"reelUrl":"/api/reels/abc/0"}

      event: job_complete
      data: {"jobId":"abc","totalReels":8}
      ```
    - Frontend updates a progress UI as each reel completes.
    - Cloudflare Workers have **no wall-time limit** on SSE streaming responses.

---

## Cloudflare Resources

| Resource | Name | Binding | Purpose |
|----------|------|---------|---------|
| R2 Bucket | `learnscrolling-assets` | `BUCKET` | Store uploaded PDFs and generated reel MP4s |
| D1 Database | `learnscrolling-db` | `DB` | Job and reel tracking, status, metadata |
| Workflow | `reel-generation` | `REEL_WORKFLOW` | Durable orchestration of the multi-step pipeline |
| Worker | `learnscrolling` | -- | API routes, SSE, frontend serving |

### R2 Bucket Structure

```
learnscrolling-assets/
├── pdfs/
│   └── {jobId}.pdf              # Uploaded textbook
└── reels/
    └── {jobId}/
        ├── 0.mp4                # Reel 0
        ├── 1.mp4                # Reel 1
        └── ...
```

---

## D1 Database Schema

```sql
CREATE TABLE jobs (
    id TEXT PRIMARY KEY,                -- UUID
    status TEXT NOT NULL,               -- queued | processing | complete | failed
    pdf_key TEXT NOT NULL,              -- R2 key for the uploaded PDF
    total_reels INTEGER,                -- Set after script generation
    completed_reels INTEGER DEFAULT 0,  -- Incremented as reels finish
    created_at TEXT NOT NULL,           -- ISO 8601
    updated_at TEXT NOT NULL            -- ISO 8601
);

CREATE TABLE reels (
    id TEXT PRIMARY KEY,                -- UUID
    job_id TEXT NOT NULL,               -- FK to jobs.id
    reel_index INTEGER NOT NULL,        -- 0-based index
    title TEXT,                         -- Short reel title (from LLM)
    script TEXT,                        -- LLM-generated Peter Griffin script (~150 words)
    source_section TEXT,                -- Which part of the doc this covers (from LLM, for traceability)
    audio_duration_sec REAL,            -- Duration of generated TTS audio
    reel_r2_key TEXT,                   -- R2 key for final MP4 (set on completion)
    status TEXT NOT NULL,               -- pending | audio | audio_done | compositing | complete | failed
    error TEXT,                         -- Error message if failed
    created_at TEXT NOT NULL,           -- ISO 8601
    updated_at TEXT NOT NULL,           -- ISO 8601
    FOREIGN KEY (job_id) REFERENCES jobs(id)
);
```

---

## Worker API Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/upload` | POST | Accept PDF upload, validate, store in R2, create D1 job, trigger Workflow. Returns `{ jobId }`. |
| `/api/events/{jobId}` | GET | SSE stream. Polls D1 every ~2-3s and pushes status events to the frontend. Stays open until job completes or client disconnects. |
| `/api/jobs/{jobId}` | GET | Returns current job status and all reel statuses from D1. For non-SSE clients or initial page load. |
| `/api/reels/{jobId}/{index}` | GET | Generates a presigned R2 GET URL for the reel MP4 and redirects to it. |
| `/*` | GET | Serves the React SPA via the ASSETS binding. |

---

## Modal Services

### Existing (to be extended)

| Service | App Name | GPU | Input | Output |
|---------|----------|-----|-------|--------|
| Peter Griffin TTS + Whisper | `peter-griffin-chatterbox` | A100 | text string | WAV audio bytes + word-level timestamps |

The existing `PeterGriffinTTS` class will be extended with a `generate_with_timestamps()` method that runs Chatterbox TTS and then Whisper alignment in the same container. Whisper `base` model is loaded alongside Chatterbox -- it's tiny (~150MB) and adds negligible overhead to the A100 already in use. The WAV audio never leaves the container between TTS and alignment, avoiding a network round-trip.

### To Build

| Service | GPU | Input | Output |
|---------|-----|-------|--------|
| LLM Script Generator | TBD (depends on model choice) | OpenAI-compatible chat completions (system prompt + full doc text) | `{ reels: [{ index, title, script, sourceSection }] }` via `json_schema` structured output |
| Video Compositor | A10G | `{ audioWav, wordTimestamps, script, presignedUploadUrl, audioDuration }` | `{ success, r2Key }` |

#### LLM Endpoint Requirements

The LLM service must expose an **OpenAI-compatible** `POST /v1/chat/completions` endpoint. The Worker calls it using the official `openai` SDK. Key requirements:

- **Structured output**: Must support `response_format: { type: "json_schema", json_schema: { ... } }`. On vLLM, this uses guided decoding (outlines/xgrammar) to enforce the schema at the token level.
- **Large context window**: The full PDF text (up to ~70K tokens) is sent as the user message. The model must support 128K+ context.
- **JSON Schema** enforced by the endpoint:
  ```json
  {
    "type": "object",
    "properties": {
      "reels": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "index": { "type": "integer" },
            "title": { "type": "string" },
            "script": { "type": "string" },
            "sourceSection": { "type": "string" }
          },
          "required": ["index", "title", "script", "sourceSection"],
          "additionalProperties": false
        }
      }
    },
    "required": ["reels"],
    "additionalProperties": false
  }
  ```
- **Auth**: Bearer token via `Authorization` header. Key set as a Cloudflare secret (`LLM_API_KEY`).
- **Config**: `LLM_API_URL` and `LLM_MODEL` are Worker env vars (in `wrangler.jsonc`).

### Modal Volume

**Name**: `learnscrolling-assets`

Contents:
- `minecraft_parkour.mp4` -- Vertical Minecraft parkour gameplay (background video)
- `peter_griffin.png` -- Peter Griffin character image (overlay)

Both are stored on a shared Modal Volume so they're accessible to the video compositor without baking them into the container image. Easy to update without rebuilding.

---

## Key Design Decisions

### Why Cloudflare Workflows for orchestration?

The pipeline (parse -> LLM scripts -> TTS -> video) is inherently multi-step and long-running. A single Worker request would risk CPU time limits and has no built-in retry. Cloudflare Workflows provide:
- **Durable execution**: each step's output is persisted. If a step fails, only that step retries.
- **Automatic retries**: configurable per step with backoff.
- **Built-in status tracking**: `instance.status()` returns step-by-step progress.
- **No timeout concerns**: each step gets its own CPU budget. Wall time for waiting on Modal calls is unlimited.

### Why parse PDFs in the Worker (not Modal)?

- Avoids an extra network round-trip to Modal for a relatively lightweight operation.
- `unpdf` is a small JS library that works in the Workers runtime.
- For a 10 MB PDF, text extraction uses well under the 30-second default CPU limit.
- The 128 MB Worker memory limit is sufficient for a 10 MB PDF.
- If edge cases arise with complex PDFs, this decision can be revisited (move to Modal).

### Why presigned URLs for R2 <-> Modal communication?

Modal needs to upload finished MP4s to R2. Two options were considered:

1. **Presigned URLs (chosen)**: Worker generates a time-limited, operation-scoped, cryptographically signed URL. Modal does a simple HTTP PUT. No R2 credentials leave Cloudflare.
2. **R2 API keys on Modal**: Store R2 access keys as a Modal Secret. Simpler code but spreads credentials across platforms.

Presigned URLs are safer because they follow the principle of least privilege:
- **Time-limited**: expire after a set duration (e.g., 15 minutes).
- **Scoped**: can only write to one specific R2 key. Cannot read, list, or delete.
- **Tamper-proof**: HMAC signature covers the method, key, and expiration. Any modification invalidates the URL.
- **No credential sprawl**: R2 secrets never leave the Worker.

### Why Whisper for word-level subtitles? Why in the TTS container?

Chatterbox TTS does not output word-level timestamps. To get the TikTok/Reels-style word-by-word subtitle highlighting, we need precise timing for each word. Running Whisper on the generated TTS audio gives near-perfect word-level alignment because the audio is clean (no background noise, no accents). Even Whisper `base` is sufficient.

Whisper is consolidated into the same Modal container as Chatterbox TTS rather than being a separate service because:
- **Both need GPU** -- Whisper runs on the A100 that's already loaded for Chatterbox.
- **No network hop** -- the WAV stays in-process memory. No need to ship audio bytes between two separate Modal containers.
- **Negligible overhead** -- Whisper `base` is ~150MB. Loading it alongside Chatterbox adds ~1-2 seconds to container startup. Alignment of a 60-second clip takes ~3-5 seconds.
- **Simpler interface** -- the Workflow makes one call and gets back audio + timestamps together.

### Why FFmpeg on a dedicated A10G GPU?

Video compositing (overlaying Peter Griffin image, mixing audio, rendering word-by-word ASS subtitles onto Minecraft gameplay) benefits from GPU acceleration:
- **NVENC encoding**: GPU-accelerated H.264 encoding is significantly faster than CPU encoding (~5s vs ~15-30s for a 60-second clip).
- **A10G is cost-effective**: much cheaper than an A100, and more than sufficient for video encoding work.
- **Separate from TTS**: keeps the expensive A100 free for TTS work. FFmpeg is a different workload with different hardware needs -- no reason to hold an A100 hostage for CPU-bound filter graph work.
- **Note**: the overlay/subtitle compositing (FFmpeg filter graph) is still CPU-bound regardless of GPU. The GPU accelerates the final encode step via NVENC. The A10G also provides fast CPU cores for the filter work.

### Modal container strategy

Each Modal `@app.function()` or `@app.cls()` runs in its own container pool with its own image and hardware config. Key behaviors:

- **Container reuse**: Modal keeps warm containers alive for a few minutes after they finish. Subsequent calls to the same function reuse warm containers (no cold start).
- **Parallel scaling**: If a Workflow step calls the same function N times in parallel (e.g., 8 reels doing TTS), Modal spins up N containers from that function's pool simultaneously.
- **Different functions = different pools**: LLM (GPU TBD), TTS+Whisper (A100), and Video Compositor (A10G) each have separate pools with different images and hardware.

For a textbook that produces 8 reels, the container usage looks like:

```
Step 2 (scripts):  1x LLM call              (single call, all scripts at once)
Step 3 (audio):    8x TTS+Whisper containers (parallel, A100)
Step 4 (video):    8x FFmpeg containers      (parallel, A10G)
```

These steps run **sequentially** across Workflow steps (scripts finish before audio starts, etc.), but **parallel within** each step for TTS and video. Total: 1 LLM call + up to 16 container invocations, never more than 8 running simultaneously.

**Why not one mega-container that does everything?** An all-in-one container (LLM → TTS → Whisper → FFmpeg in one shot) would eliminate network hops between steps, but:
- The A100 would sit idle during FFmpeg (CPU-bound work). A100s cost ~$3.50/hr -- expensive idle time.
- A single failure reruns the entire pipeline for that reel, not just the failed step.
- The container image would be massive (LLM weights + Chatterbox + Whisper + FFmpeg + all deps).

TTS + Whisper are consolidated because they share the same GPU and operate on the same data in-memory. Everything else stays separate because the hardware needs differ.

### Why LLM-driven content splitting (not heuristic chunking)?

The original design had a separate chunking step that split text by headings and word count before sending individual chunks to the LLM. This was replaced with a single LLM call that handles both content splitting and script writing.

**Why this is better:**
- The LLM understands the **semantic structure** of the content, not just headings and word counts. It can merge related subsections, split complex topics, and handle documents with inconsistent formatting.
- **No heuristic tuning**: no magic numbers for min/max chunk sizes, no regex for heading detection.
- **Simpler pipeline**: one Workflow step instead of two. Less code, fewer failure points.
- **Self-contained scripts**: the LLM generates each script with full context of the document, so scripts don't have awkward boundaries or missing context.

**Tradeoff:** Requires a model with a large context window (128K+ tokens). A 10 MB PDF produces ~50K words (~70K tokens). If the LLM call fails, we retry the entire generation (all scripts), not just one chunk.

### Parallel reel processing

All reels are processed in parallel at each subsequent stage (TTS, video compositing). This means:
- A document that produces 10 reels spawns 10 Modal containers simultaneously for TTS, and 10 more for video.
- End-to-end latency is roughly the time for one reel (not N reels).
- Trade-off: higher Modal cost (more GPU-seconds), but much faster for the user.

### SSE for progress updates

- Workers support SSE natively via `ReadableStream`.
- No wall-time limit on SSE responses in Cloudflare Workers.
- The SSE endpoint polls D1 every ~2-3 seconds and pushes events.
- Simpler than WebSockets (no Durable Objects needed), more responsive than client polling.
- Frontend can show per-reel progress in real time.

---

## Workers CPU Time Analysis

Workers on the paid plan get 30 seconds of CPU time per request (configurable up to 5 minutes). CPU time only counts active computation -- waiting on `fetch()`, R2, D1, and other I/O does **not** count.

| Operation | CPU Time | Notes |
|-----------|----------|-------|
| PDF validation | < 1 ms | Type and size check |
| R2 upload | ~0 ms CPU | Network I/O, not CPU |
| D1 writes | ~0 ms CPU | Network I/O |
| Workflow trigger | ~0 ms CPU | Network I/O |
| PDF text extraction | ~1-5 s | Heaviest CPU operation. Runs in a Workflow step with its own budget. |
| LLM API call | ~0 ms CPU | Network I/O (waiting on remote inference). Runs in its own Workflow step with 5-min timeout. |
| Modal fetch calls | ~0 ms CPU | All network I/O |
| SSE streaming | < 1 ms per poll | D1 read + JSON serialize |

Every operation is well within limits. The Workflow gives each step its own CPU budget, so even PDF parsing gets a fresh 30 seconds.

---

## Open Questions / Future Work

- **LLM model choice**: TBD. Must support 128K+ context window and structured output (json_schema). Served via vLLM with OpenAI-compatible API.
- **Peter Griffin image positioning**: Bottom-left? Bottom-center? Need to test what looks best.
- **Subtitle styling**: Exact font, size, colors, highlight animation for the word-by-word effect. Will need iteration.
- **Video delivery**: Currently reels are stored in R2 and served via presigned GET URLs. Future work: gallery UI, download all as zip, share links, etc.
- **Stewie Griffin**: Only Peter's voice exists. Could add Stewie for a dialogue format.
- **Rate limiting**: No auth or rate limiting on the upload endpoint yet.
- **Cost estimation**: Need to profile Modal costs per reel (LLM + TTS + Whisper + FFmpeg).
- **Error handling UX**: What does the frontend show when a single reel fails but others succeed?

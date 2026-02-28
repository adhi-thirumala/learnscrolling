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
│  │  (React)   │◀───│   (API)    │     │   "reel-generation"       │ │
│  │           SSE   │            │     │                           │ │
│  └───────────┘     └─────┬──────┘     │  Step 1: Parse PDF        │ │
│                          │            │  Step 2: Chunk text        │ │
│                     ┌────┴─────┐      │  Step 3: Generate scripts ─│─│──▶ Modal LLM
│                     │    D1    │      │  Step 4: Generate audio   ─│─│──▶ Modal TTS + Whisper
│                     │  (jobs)  │      │  Step 5: Composite video  ─│─│──▶ Modal FFmpeg
│                     └──────────┘      │  Step 6: Finalize job      │ │
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
│  │  (script gen)    │  │  TTS (Chatterbox) │  │  Compositor      │  │
│  │  GPU: TBD        │  │  GPU: A100        │  │  CPU (FFmpeg)    │  │
│  └──────────────────┘  └───────────────────┘  └──────────────────┘  │
│                                                                      │
│                        ┌───────────────────┐                         │
│                        │ Whisper Alignment │                         │
│                        │ GPU: A10G         │                         │
│                        └───────────────────┘                         │
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

### Phase 2: Parse and Chunk (Workflow Steps 1-2, in Worker)

9. **Step 1 -- `parse-pdf`**: The Workflow fetches the PDF from R2 and extracts text using `unpdf` (a lightweight JS PDF parsing library). This runs inside the Workflow step's Worker context. Returns raw text. For a 10 MB PDF this should use well under the 30-second CPU time budget since PDF text extraction is not computationally heavy -- and `fetch()` calls to R2 do not count toward CPU time.

10. **Step 2 -- `chunk-text`**: Two-stage chunking strategy:
    - **Structural split**: Detect headings, sections, and natural document boundaries from the parsed text.
    - **Size-based subdivision**: Sections longer than ~500 words are split into ~400-500 word sub-chunks. Sections shorter than ~200 words are merged with adjacent content.
    - Target: each chunk contains ~400-500 words of source material. The LLM will condense this into a ~150-word script (~60 seconds of speech at ~150 wpm).
    - Returns an array of `{ chunkIndex, text, title }`.
    - Updates D1 with chunk records (one row per chunk, status `pending`).

### Phase 3: Script Generation (Workflow Step 3, Modal LLM)

11. **Step 3 -- `generate-scripts`**: For each chunk, **in parallel**:
    - Calls the Modal LLM endpoint with the chunk text + a system prompt.
    - The prompt instructs the LLM to write a ~150-word script of Peter Griffin explaining the topic in his voice -- funny, educational, with his catchphrases.
    - Returns `{ chunkIndex, script, estimatedDuration }`.
    - Updates each chunk's status in D1 to `scripted`.

### Phase 4: TTS Audio Generation (Workflow Step 4, Modal Chatterbox + Whisper)

12. **Step 4 -- `generate-audio`**: For each script, **in parallel**:
    - Calls the existing Modal Chatterbox TTS endpoint with the script text. Gets back WAV audio.
    - Runs Whisper alignment on the generated WAV to extract **word-level timestamps**. Chatterbox does not natively output word timestamps, but since the audio is clean TTS output, even a small Whisper model (`base` or `small`) gives near-perfect word-level alignment.
    - Returns `{ chunkIndex, audioWavBytes, wordTimestamps, durationSeconds }`.
    - Updates each chunk's status in D1 to `audio_done`.

### Phase 5: Video Compositing (Workflow Step 5, Modal FFmpeg)

13. **Step 5 -- `composite-video`**: For each audio clip, **in parallel**:
    - The Worker generates a **presigned R2 PUT URL** scoped to `reels/{jobId}/{chunkIndex}.mp4` with a short expiration (e.g., 15 minutes). This URL is passed to Modal.
    - Calls the Modal video compositor endpoint. The Modal function:
      1. Reads Minecraft parkour MP4 from the Modal Volume.
      2. Picks a random start offset and extracts a clip matching the audio duration.
      3. Overlays the Peter Griffin PNG image (from Modal Volume).
      4. Generates word-by-word ASS subtitles from the word timestamps (TikTok/Reels style -- current word highlighted, bold outlined text with shadow).
      5. Composites everything via FFmpeg: `minecraft_clip + audio + subtitles + peter_image -> final_reel.mp4`
      6. Uploads the final MP4 directly to R2 using the presigned PUT URL.
    - Modal returns `{ success: true, r2Key }` to the Workflow.
    - Updates each chunk's status in D1 to `complete` and stores the `reel_r2_key`.

### Phase 6: Finalize (Workflow Step 6)

14. **Step 6 -- `finalize-job`**: Marks the overall job as `complete` in D1. Updates `completed_chunks` count.

### Phase 7: Frontend Gets Updates (SSE, throughout)

15. Throughout the entire pipeline, the SSE endpoint `/api/events/{jobId}`:
    - The Worker reads job and chunk status from D1.
    - Polls D1 every ~2-3 seconds.
    - Streams events to the frontend as they happen:
      ```
      event: job_started
      data: {"jobId":"abc","totalChunks":8}

      event: chunk_scripted
      data: {"chunkIndex":2,"title":"Chapter 3: Thermodynamics"}

      event: chunk_audio_done
      data: {"chunkIndex":0,"durationSeconds":58.3}

      event: reel_complete
      data: {"chunkIndex":0,"reelUrl":"/api/reels/abc/0"}

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
| D1 Database | `learnscrolling-db` | `DB` | Job and chunk tracking, status, metadata |
| Workflow | `reel-generation` | `REEL_WORKFLOW` | Durable orchestration of the multi-step pipeline |
| Worker | `learnscrolling` | -- | API routes, SSE, frontend serving |

### R2 Bucket Structure

```
learnscrolling-assets/
├── pdfs/
│   └── {jobId}.pdf              # Uploaded textbook
└── reels/
    └── {jobId}/
        ├── 0.mp4                # Reel for chunk 0
        ├── 1.mp4                # Reel for chunk 1
        └── ...
```

---

## D1 Database Schema

```sql
CREATE TABLE jobs (
    id TEXT PRIMARY KEY,                -- UUID
    status TEXT NOT NULL,               -- queued | processing | complete | failed
    pdf_key TEXT NOT NULL,              -- R2 key for the uploaded PDF
    total_chunks INTEGER,               -- Set after chunking
    completed_chunks INTEGER DEFAULT 0, -- Incremented as reels finish
    created_at TEXT NOT NULL,           -- ISO 8601
    updated_at TEXT NOT NULL            -- ISO 8601
);

CREATE TABLE chunks (
    id TEXT PRIMARY KEY,                -- UUID
    job_id TEXT NOT NULL,               -- FK to jobs.id
    chunk_index INTEGER NOT NULL,       -- 0-based index
    title TEXT,                         -- Section/heading title
    source_text TEXT,                   -- Original textbook text (~400-500 words)
    script TEXT,                        -- LLM-generated Peter Griffin script (~150 words)
    audio_duration_sec REAL,            -- Duration of generated TTS audio
    reel_r2_key TEXT,                   -- R2 key for final MP4 (set on completion)
    status TEXT NOT NULL,               -- pending | scripting | scripted | audio | audio_done | compositing | complete | failed
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
| `/api/jobs/{jobId}` | GET | Returns current job status and all chunk statuses from D1. For non-SSE clients or initial page load. |
| `/api/reels/{jobId}/{index}` | GET | Generates a presigned R2 GET URL for the reel MP4 and redirects to it. |
| `/*` | GET | Serves the React SPA via the ASSETS binding. |

---

## Modal Services

### Existing

| Service | App Name | GPU | Input | Output |
|---------|----------|-----|-------|--------|
| Peter Griffin TTS | `peter-griffin-chatterbox` | A100 | text string | WAV audio bytes |

### To Build

| Service | GPU | Input | Output |
|---------|-----|-------|--------|
| LLM Script Generator | TBD (depends on model choice) | `{ text, systemPrompt }` | `{ script }` |
| Whisper Alignment | A10G (lightweight) | WAV audio bytes + transcript | `[{ word, start_sec, end_sec }, ...]` |
| Video Compositor | CPU | `{ audioWav, wordTimestamps, script, presignedUploadUrl, audioDuration }` | `{ success, r2Key }` |

### Modal Volume

**Name**: `learnscrolling-assets`

Contents:
- `minecraft_parkour.mp4` -- Vertical Minecraft parkour gameplay (background video)
- `peter_griffin.png` -- Peter Griffin character image (overlay)

Both are stored on a shared Modal Volume so they're accessible to the video compositor without baking them into the container image. Easy to update without rebuilding.

---

## Key Design Decisions

### Why Cloudflare Workflows for orchestration?

The pipeline (parse -> chunk -> LLM -> TTS -> video) is inherently multi-step and long-running. A single Worker request would risk CPU time limits and has no built-in retry. Cloudflare Workflows provide:
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

### Why Whisper for word-level subtitles?

Chatterbox TTS does not output word-level timestamps. To get the TikTok/Reels-style word-by-word subtitle highlighting, we need precise timing for each word. Running Whisper on the generated TTS audio gives near-perfect word-level alignment because the audio is clean (no background noise, no accents). Even Whisper `base` is sufficient. This adds ~3-5 seconds per clip on an A10G GPU.

### Why FFmpeg on CPU (not GPU)?

For compositing a 60-second video with an image overlay, audio track, and subtitles, FFmpeg on CPU handles this in under 30 seconds easily. GPU-accelerated rendering (NVENC) would be faster but adds complexity (CUDA toolkit, specific FFmpeg build) for marginal gain. The TTS step is the actual bottleneck, not video compositing.

### Chunking strategy

Two-stage approach:
1. **Structural split**: parse headings, sections, page breaks from the PDF. Respect natural content boundaries.
2. **Size-based subdivision**: split sections > 500 words into ~400-500 word sub-chunks. Merge sections < 200 words with adjacent content.

Why ~400-500 words per chunk? At ~150 wpm speaking rate, a 60-second reel needs ~150 words of script. The LLM summarizes/rewrites 400-500 words of source material into ~150 words, so each chunk maps to roughly one reel.

### Parallel chunk processing

All chunks are processed in parallel at each stage (script generation, TTS, video compositing). This means:
- A 10-chunk textbook spawns 10 Modal containers simultaneously.
- End-to-end latency is roughly the time for one chunk (not N chunks).
- Trade-off: higher Modal cost (more GPU-seconds), but much faster for the user.

### SSE for progress updates

- Workers support SSE natively via `ReadableStream`.
- No wall-time limit on SSE responses in Cloudflare Workers.
- The SSE endpoint polls D1 every ~2-3 seconds and pushes events.
- Simpler than WebSockets (no Durable Objects needed), more responsive than client polling.
- Frontend can show per-chunk progress in real time.

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
| Text chunking | < 100 ms | String splitting logic |
| Modal fetch calls | ~0 ms CPU | All network I/O |
| SSE streaming | < 1 ms per poll | D1 read + JSON serialize |

Every operation is well within limits. The Workflow gives each step its own CPU budget, so even PDF parsing gets a fresh 30 seconds.

---

## Open Questions / Future Work

- **LLM model choice**: TBD. Llama 3.1 8B on A10G is the likely starting point. Interface is designed to be model-agnostic.
- **Peter Griffin image positioning**: Bottom-left? Bottom-center? Need to test what looks best.
- **Subtitle styling**: Exact font, size, colors, highlight animation for the word-by-word effect. Will need iteration.
- **Video delivery**: Currently reels are stored in R2 and served via presigned GET URLs. Future work: gallery UI, download all as zip, share links, etc.
- **Stewie Griffin**: Only Peter's voice exists. Could add Stewie for a dialogue format.
- **Rate limiting**: No auth or rate limiting on the upload endpoint yet.
- **Cost estimation**: Need to profile Modal costs per reel (LLM + TTS + Whisper + FFmpeg).
- **Error handling UX**: What does the frontend show when a single chunk fails but others succeed?

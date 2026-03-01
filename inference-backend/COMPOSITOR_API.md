# Video Compositor API Contract

## Endpoint

```
POST /composite_video
```

Deployed via Modal as a FastAPI web endpoint. The URL is assigned by Modal on deploy (e.g. `https://<workspace>--learnscrolling-compositor-composite-video.modal.run`).

## Authentication

Include `api_key` in the JSON body. The value must match the `COMPOSITOR_API_KEY` environment variable set via the `compositor-api-key` Modal Secret.

Unauthorized requests receive a `401` response.

## Request

```json
{
  "api_key": "string (required)",
  "job_id": "string (required) - unique job identifier, used as R2 path prefix",
  "reel_index": "integer (required) - reel number within the job",
  "audio_key": "string (required) - R2 key for the audio WAV file (e.g. audio/abc123/0.wav)",
  "timestamps_key": "string (required) - R2 key for the timestamps JSON (e.g. timestamps/abc123/0.json)",
  "duration_seconds": "number (required) - duration of the audio in seconds"
}
```

### Example

```json
{
  "api_key": "your-secret-key",
  "job_id": "abc123",
  "reel_index": 0,
  "audio_key": "audio/abc123/0.wav",
  "timestamps_key": "timestamps/abc123/0.json",
  "duration_seconds": 42.5
}
```

## Response

### 200 OK

```json
{
  "success": true,
  "videoKey": "reels/abc123/0.mp4"
}
```

### 400 Bad Request

```json
{
  "error": "job_id is required; reel_index (integer) is required"
}
```

### 401 Unauthorized

```json
{
  "error": "unauthorized"
}
```

### 500 Internal Server Error

Returned if FFmpeg fails or files are not found in R2.

## R2 Input Files (read)

These are written by the TTS endpoint (`peter-griffin-chatterbox`) and must exist before the compositor is called.

| Key | Format | Description |
|-----|--------|-------------|
| `audio/{job_id}/{reel_index}.wav` | WAV (PCM) | TTS audio, 1.5x speed |
| `timestamps/{job_id}/{reel_index}.json` | JSON | Word-level timestamps from Whisper |

### Timestamps JSON format

```json
{
  "durationSeconds": 42.5,
  "wordTimestamps": [
    { "word": "So", "start": 0.0, "end": 0.18 },
    { "word": "thermodynamics", "start": 0.18, "end": 0.84 }
  ]
}
```

## R2 Output File (write)

| Key | Format | Description |
|-----|--------|-------------|
| `reels/{job_id}/{reel_index}.mp4` | MP4 (H.264 + AAC) | Final composited reel video |

## Video Composition Details

- **Resolution**: 1080x1920 (vertical / portrait)
- **Background**: Random clip from Minecraft parkour gameplay, scaled and cropped to fill 1080x1920
- **Peter Griffin overlay**: 300px wide, positioned bottom-left (x=50, y=H-h-50)
- **Subtitles**: ASS format, TikTok-style word-by-word karaoke highlighting
  - Font: DejaVu Sans, 72pt, bold
  - Colors: white primary, yellow secondary (karaoke fill), black outline (4px), shadow (2px)
  - Position: bottom center, 200px margin from bottom
  - Groups of 4 words per line
- **Video codec**: H.264 via NVENC (GPU-accelerated on H100)
  - Preset: p4
  - Quality: CQ 23
- **Audio codec**: AAC, 128kbps
- **Container**: MP4 with `faststart` flag for streaming

## Modal Secrets Required

| Secret Name | Keys | Purpose |
|---|---|---|
| `compositor-api-key` | `COMPOSITOR_API_KEY` | Authenticate incoming API requests |
| `r2-secret` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Mount R2 bucket |

## Environment Variables

| Variable | Where to set | Purpose |
|---|---|---|
| `CF_ACCOUNT_ID` | System env or hardcode in `compositor.py` | Cloudflare account ID for R2 endpoint URL |

## Media Assets

Baked into the container image via `add_local_dir("./petergriffin", remote_path="/root/media")`. No Modal Volume needed.

| File (in container) | Description |
|------|-------------|
| `/root/media/Minecraft Parkour Gameplay NO COPYRIGHT (Vertical) [_H2cLn-OlIU].mp4` | Vertical Minecraft parkour gameplay (background video) |
| `/root/media/Peter_Griffin.png` | Peter Griffin character image (overlay) |

To update these assets, replace the files in `inference-backend/petergriffin/` and redeploy.

import modal
import os
import json
import logging
import subprocess
import random
import tempfile
from pathlib import Path

# --- Image: Debian + system FFmpeg (NVENC via Modal's injected NVIDIA drivers) + libass ---

compositor_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(
        # FFmpeg from Debian repos — built with NVENC support, uses Modal's runtime NVIDIA drivers
        "ffmpeg",
        # libass for ASS subtitle rendering in FFmpeg filter graph
        "libass9",
        "libass-dev",
        # fonts for subtitle text
        "fontconfig",
        "fonts-dejavu-core",
        "git",
    )
    .uv_sync()
    # Bake media assets (Minecraft parkour MP4, Peter Griffin PNG) into the image
    .add_local_dir("./petergriffin", remote_path="/root/media")
)

app = modal.App("learnscrolling-compositor")

# R2 bucket mount — same bucket as TTS, same credentials
CF_ACCOUNT_ID = "b8a6047310bbd4b0a0e5374e91089308"

r2_secret = modal.Secret.from_name(
    "r2-secret",
    required_keys=["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
)

R2_MOUNT_PATH = "/root/r2"

# Media assets are baked into the image at /root/media via add_local_dir
MINECRAFT_VIDEO = "/root/media/minecraft.mp4"
PETER_GRIFFIN_PNG = "/root/media/Peter_Griffin.png"
STEWIE_GRIFFIN_PNG = "/root/media/latest.png"


# --- ASS subtitle generation ---


def format_ass_time(seconds: float) -> str:
    """Format seconds to ASS timestamp: H:MM:SS.cc (centiseconds)."""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def generate_ass_subtitles(
    word_timestamps: list[dict],
    video_width: int = 1080,
    video_height: int = 1920,
    words_per_line: int = 4,
) -> str:
    """Generate an ASS subtitle file with TikTok-style word-by-word karaoke highlighting.

    Uses \\k tags for per-word timing. Words are grouped into subtitle lines of
    `words_per_line` words each, but a new line is forced whenever the speaker
    changes. Each subtitle line that starts a new speaker run is prefixed with
    [Peter]: or [Stewie]: so the viewer knows who is talking.

    If word timestamps don't contain a "speaker" key, falls back to the
    original behavior (no speaker prefix).
    """
    header = f"""[Script Info]
Title: LearnScrolling Subtitles
ScriptType: v4.00+
PlayResX: {video_width}
PlayResY: {video_height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans,72,&H00FFFFFF,&H0000FFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,2,8,40,40,100,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    # PrimaryColour: white (highlighted word)
    # SecondaryColour: yellow (pre-highlight, the karaoke "fill" color)
    # OutlineColour: black
    # BackColour: semi-transparent black shadow
    # Bold: -1 (true)
    # Outline: 4px, Shadow: 2px
    # Alignment: 8 (top center)
    # MarginV: 100 (push down from very top)

    has_speakers = any("speaker" in w for w in word_timestamps)

    # --- Group words into subtitle lines ---
    # Rules:
    #   1. Force a new line whenever the speaker changes
    #   2. Within a single speaker run, group into `words_per_line` words
    #   3. The first line of each speaker run gets a [Speaker]: prefix
    lines: list[
        dict
    ] = []  # Each entry: {"words": [...], "speaker": str|None, "is_first_of_run": bool}
    current_speaker = None
    current_words: list[dict] = []
    is_first_of_run = True

    for w in word_timestamps:
        speaker = w.get("speaker") if has_speakers else None

        # Speaker changed — flush current line and start new speaker run
        if has_speakers and speaker != current_speaker:
            if current_words:
                lines.append(
                    {
                        "words": current_words,
                        "speaker": current_speaker,
                        "is_first_of_run": is_first_of_run,
                    }
                )
            current_words = []
            current_speaker = speaker
            is_first_of_run = True

        current_words.append(w)

        # Hit words_per_line limit — flush
        if len(current_words) >= words_per_line:
            lines.append(
                {
                    "words": current_words,
                    "speaker": current_speaker,
                    "is_first_of_run": is_first_of_run,
                }
            )
            current_words = []
            is_first_of_run = False

    # Flush remaining words
    if current_words:
        lines.append(
            {
                "words": current_words,
                "speaker": current_speaker,
                "is_first_of_run": is_first_of_run,
            }
        )

    # --- Build ASS dialogue events ---
    events = ""
    for line in lines:
        line_words = line["words"]
        if not line_words:
            continue

        start = format_ass_time(line_words[0]["start"])
        end = format_ass_time(line_words[-1]["end"])

        # Build karaoke text with \k tags
        # \k duration is in centiseconds (1/100th of a second)
        text_parts = []

        # Add speaker prefix if this is the first line of a new speaker run

        for w in line_words:
            duration_cs = max(1, int((w["end"] - w["start"]) * 100))
            text_parts.append(f"{{\\k{duration_cs}}}{w['word']}")

        text = " ".join(text_parts)
        events += f"Dialogue: 0,{start},{end},Default,,0,0,0,,{text}\n"

    return header + events


def build_speaker_enable_expr(line_time_boundaries: list[dict], speaker: str) -> str:
    """Build an ffmpeg 'enable' expression that activates during a given speaker's segments.

    Returns an expression like:
        between(t,0.00,3.50)+between(t,7.20,12.10)
    which evaluates to >0 (true) when the current time falls within any of
    that speaker's segments.

    If no boundaries are provided or the speaker has no segments, returns "1"
    (always on) for Peter and "0" (always off) for Stewie as a safe fallback.
    """
    segments = [b for b in line_time_boundaries if b.get("speaker") == speaker]
    if not segments:
        return "1" if speaker == "Peter" else "0"

    parts = []
    for seg in segments:
        start = f"{seg['start_sec']:.2f}"
        end = f"{seg['end_sec']:.2f}"
        parts.append(f"between(t\\,{start}\\,{end})")

    return "+".join(parts)


def get_video_duration(video_path: str) -> float:
    """Get video duration in seconds via ffprobe."""
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            video_path,
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    info = json.loads(result.stdout)
    return float(info["format"]["duration"])


# --- Compositor ---


@app.function(
    image=compositor_image,
    gpu="T4",
    scaledown_window=300,
    volumes={
        R2_MOUNT_PATH: modal.CloudBucketMount(
            bucket_name="learnscrolling-assets",
            bucket_endpoint_url=f"https://{CF_ACCOUNT_ID}.r2.cloudflarestorage.com",
            secret=r2_secret,
        ),
    },
    secrets=[modal.Secret.from_name("compositor-api-key")],
    timeout=600,
)
def composite(
    job_id: str,
    reel_index: int,
    audio_key: str,
    timestamps_key: str,
    duration_seconds: float,
):
    """Composite a reel video: Minecraft background + character overlay + audio + subtitles.

    Reads audio and timestamps from R2, writes final MP4 back to R2.
    Switches between Peter Griffin and Stewie Griffin character overlays
    based on speaker time boundaries in the timestamps JSON.
    Returns dict with videoKey.
    """
    logging.info(
        json.dumps(
            {
                "event": "composite_start",
                "job_id": job_id,
                "reel_index": reel_index,
                "duration_seconds": duration_seconds,
                "audio_key": audio_key,
                "timestamps_key": timestamps_key,
            }
        )
    )

    # 1. Read audio WAV from R2
    audio_path = Path(R2_MOUNT_PATH) / audio_key
    if not audio_path.exists():
        raise FileNotFoundError(f"Audio not found in R2: {audio_key}")

    # 2. Read timestamps JSON from R2
    timestamps_path = Path(R2_MOUNT_PATH) / timestamps_key
    if not timestamps_path.exists():
        raise FileNotFoundError(f"Timestamps not found in R2: {timestamps_key}")

    with open(timestamps_path) as f:
        ts_data = json.load(f)
    word_timestamps = ts_data["wordTimestamps"]
    line_time_boundaries = ts_data.get("lineTimeBoundaries", [])

    logging.info(
        json.dumps(
            {
                "event": "composite_inputs_loaded",
                "job_id": job_id,
                "reel_index": reel_index,
                "word_count": len(word_timestamps),
                "has_speaker_boundaries": len(line_time_boundaries) > 0,
            }
        )
    )

    # 3. Pick random start offset in the Minecraft video
    minecraft_duration = get_video_duration(MINECRAFT_VIDEO)
    max_start = minecraft_duration - duration_seconds - 1  # 1s buffer
    if max_start <= 0:
        start_offset = 0.0
        logging.warning(
            json.dumps(
                {
                    "event": "composite_minecraft_too_short",
                    "job_id": job_id,
                    "reel_index": reel_index,
                    "minecraft_duration": minecraft_duration,
                    "reel_duration": duration_seconds,
                }
            )
        )
    else:
        start_offset = random.uniform(0, max_start)

    logging.info(
        json.dumps(
            {
                "event": "composite_offset_selected",
                "job_id": job_id,
                "reel_index": reel_index,
                "start_offset": round(start_offset, 2),
            }
        )
    )

    # 4. Generate ASS subtitles
    ass_content = generate_ass_subtitles(word_timestamps)

    with tempfile.TemporaryDirectory() as tmpdir:
        ass_path = os.path.join(tmpdir, "subtitles.ass")
        output_path = os.path.join(tmpdir, "output.mp4")

        with open(ass_path, "w") as f:
            f.write(ass_content)

        # 5. Run FFmpeg composite
        # Filter graph:
        #   - Scale/crop Minecraft to 1080x1920 (vertical)
        #   - Scale Peter Griffin PNG and Stewie Griffin PNG
        #   - Overlay each character at bottom-left, toggling visibility
        #     based on who is speaking (using enable expressions)
        #   - Burn in ASS subtitles
        # Encode with T4 NVENC for GPU-accelerated H.264
        #
        # Inputs:
        #   [0] = Minecraft video
        #   [1] = Audio WAV
        #   [2] = Peter Griffin PNG
        #   [3] = Stewie Griffin PNG

        # Build enable expressions from speaker time boundaries
        peter_enable = build_speaker_enable_expr(line_time_boundaries, "Peter")
        stewie_enable = build_speaker_enable_expr(line_time_boundaries, "Stewie")

        # Peter Griffin PNG: scale to 600px wide (original is large)
        # Stewie Griffin PNG (781x987): scale to 450px wide to be shorter
        filter_complex = (
            "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,"
            "crop=1080:1920[bg];"
            "[2:v]scale=600:-1[pg];"
            "[3:v]scale=450:-1[sg];"
            f"[bg][pg]overlay=x=150:y=H-h-50:enable='{peter_enable}'[v1];"
            f"[v1][sg]overlay=x=150:y=H-h-50:enable='{stewie_enable}'[v2];"
            f"[v2]ass={ass_path}[out]"
        )

        ffmpeg_cmd = [
            "ffmpeg",
            "-ss",
            str(start_offset),
            "-t",
            str(duration_seconds),
            "-i",
            MINECRAFT_VIDEO,
            "-i",
            str(audio_path),
            "-i",
            PETER_GRIFFIN_PNG,
            "-i",
            STEWIE_GRIFFIN_PNG,
            "-filter_complex",
            filter_complex,
            "-map",
            "[out]",
            "-map",
            "1:a",
            "-c:v",
            "h264_nvenc",
            "-preset",
            "p4",
            "-cq",
            "23",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-movflags",
            "+faststart",
            "-y",
            output_path,
        ]

        logging.info(
            json.dumps(
                {
                    "event": "composite_ffmpeg_start",
                    "job_id": job_id,
                    "reel_index": reel_index,
                    "cmd": " ".join(ffmpeg_cmd),
                }
            )
        )

        result = subprocess.run(
            ffmpeg_cmd,
            capture_output=True,
            text=True,
        )

        if result.returncode != 0:
            logging.error(
                json.dumps(
                    {
                        "event": "composite_ffmpeg_failed",
                        "job_id": job_id,
                        "reel_index": reel_index,
                        "returncode": result.returncode,
                        "stderr": result.stderr[-2000:],
                    }
                )
            )
            raise RuntimeError(
                f"FFmpeg failed for reel {reel_index}: {result.stderr[-500:]}"
            )

        logging.info(
            json.dumps(
                {
                    "event": "composite_ffmpeg_done",
                    "job_id": job_id,
                    "reel_index": reel_index,
                }
            )
        )

        # 6. Write output MP4 to R2
        video_key = f"reels/{job_id}/{reel_index}.mp4"
        video_dest = Path(R2_MOUNT_PATH) / video_key
        video_dest.parent.mkdir(parents=True, exist_ok=True)

        # CloudBucketMount requires write in truncate mode (no append)
        # Use shutil.copy (not copy2) — copy2 calls copystat which tries to
        # set utime on the destination, and CloudBucketMount doesn't support that.
        import shutil

        shutil.copy(output_path, str(video_dest))

    output_size = video_dest.stat().st_size

    logging.info(
        json.dumps(
            {
                "event": "composite_complete",
                "job_id": job_id,
                "reel_index": reel_index,
                "video_key": video_key,
                "output_size_bytes": output_size,
            }
        )
    )

    return {
        "success": True,
        "videoKey": video_key,
    }


# --- Web endpoint ---


@app.function(
    image=compositor_image,
    secrets=[modal.Secret.from_name("compositor-api-key")],
)
@modal.fastapi_endpoint(method="POST")
def composite_video(body: dict):
    """Composite a reel video. See COMPOSITOR_API.md for the full contract."""
    from fastapi import Response

    # --- Auth ---
    expected_key = os.environ.get("COMPOSITOR_API_KEY", "")
    provided_key = body.get("api_key", "")
    if not expected_key or provided_key != expected_key:
        logging.warning(json.dumps({"event": "compositor_auth_failed"}))
        return Response(
            content=json.dumps({"error": "unauthorized"}),
            media_type="application/json",
            status_code=401,
        )

    # --- Validate input ---
    job_id = body.get("job_id", "")
    reel_index = body.get("reel_index")
    audio_key = body.get("audio_key", "")
    timestamps_key = body.get("timestamps_key", "")
    duration_seconds = body.get("duration_seconds")

    errors = []
    if not job_id:
        errors.append("job_id is required")
    if reel_index is None or not isinstance(reel_index, int):
        errors.append("reel_index (integer) is required")
    if not audio_key:
        errors.append("audio_key is required")
    if not timestamps_key:
        errors.append("timestamps_key is required")
    if duration_seconds is None or not isinstance(duration_seconds, (int, float)):
        errors.append("duration_seconds (number) is required")

    if errors:
        logging.warning(
            json.dumps(
                {
                    "event": "compositor_validation_failed",
                    "errors": errors,
                }
            )
        )
        return Response(
            content=json.dumps({"error": "; ".join(errors)}),
            media_type="application/json",
            status_code=400,
        )

    logging.info(
        json.dumps(
            {
                "event": "composite_video_request",
                "job_id": job_id,
                "reel_index": reel_index,
                "audio_key": audio_key,
                "timestamps_key": timestamps_key,
                "duration_seconds": duration_seconds,
            }
        )
    )

    # --- Fire-and-forget: spawn the GPU work and return immediately ---
    # The caller (CF Workflow) will poll R2 for the output file instead of
    # waiting for this HTTP response to carry the result. This avoids the
    # 120-second Cloudflare Proxy Read Timeout (524) on long compositing jobs.
    composite.spawn(
        job_id=job_id,
        reel_index=reel_index,
        audio_key=audio_key,
        timestamps_key=timestamps_key,
        duration_seconds=duration_seconds,
    )

    logging.info(
        json.dumps(
            {
                "event": "composite_video_spawned",
                "job_id": job_id,
                "reel_index": reel_index,
            }
        )
    )

    return Response(
        content=json.dumps(
            {"accepted": True, "job_id": job_id, "reel_index": reel_index}
        ),
        media_type="application/json",
    )


@app.local_entrypoint()
def main():
    """Test the compositor locally with dummy data."""
    result = composite.remote(
        job_id="test-local",
        reel_index=0,
        audio_key="audio/test-local/0.wav",
        timestamps_key="timestamps/test-local/0.json",
        duration_seconds=10.0,
    )
    print(f"Video written to R2: {result['videoKey']}")

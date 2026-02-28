import modal
import os
import json
import logging
import subprocess
import random
import tempfile
from pathlib import Path

# --- Image: NVIDIA CUDA runtime + static FFmpeg with NVENC + libass for subtitles ---

compositor_image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.6.0-runtime-ubuntu24.04",
        add_python="3.11",
    )
    .apt_install(
        "wget",
        "xz-utils",
        # libass for ASS subtitle rendering in FFmpeg filter graph
        "libass9",
        "libass-dev",
        # fonts for subtitle text
        "fontconfig",
        "fonts-dejavu-core",
    )
    .run_commands(
        # Download BtbN static FFmpeg build with NVENC support (GPL, includes all codecs)
        "wget -q https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz",
        "tar -xf ffmpeg-master-latest-linux64-gpl.tar.xz",
        "mv ffmpeg-master-latest-linux64-gpl/bin/ffmpeg /usr/local/bin/ffmpeg",
        "mv ffmpeg-master-latest-linux64-gpl/bin/ffprobe /usr/local/bin/ffprobe",
        "rm -rf ffmpeg-master-latest-linux64-gpl*",
        # Verify NVENC encoder is available in the binary
        "ffmpeg -encoders 2>/dev/null | grep h264_nvenc",
    )
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
MINECRAFT_VIDEO = (
    "/root/media/Minecraft Parkour Gameplay NO COPYRIGHT (Vertical) [_H2cLn-OlIU].mp4"
)
PETER_GRIFFIN_PNG = "/root/media/Peter_Griffin.png"


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

    Uses \\k tags for per-word timing. Each line shows a group of words,
    with the current word highlighted as it's spoken.
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
Style: Default,DejaVu Sans,72,&H00FFFFFF,&H0000FFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,2,2,40,40,200,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    # PrimaryColour: white (highlighted word)
    # SecondaryColour: yellow (pre-highlight, the karaoke "fill" color)
    # OutlineColour: black
    # BackColour: semi-transparent black shadow
    # Bold: -1 (true)
    # Outline: 4px, Shadow: 2px
    # Alignment: 2 (bottom center)
    # MarginV: 200 (push up from very bottom)

    # Group words into lines
    lines = []
    for i in range(0, len(word_timestamps), words_per_line):
        lines.append(word_timestamps[i : i + words_per_line])

    events = ""
    for line_words in lines:
        if not line_words:
            continue

        start = format_ass_time(line_words[0]["start"])
        end = format_ass_time(line_words[-1]["end"])

        # Build karaoke text with \k tags
        # \k duration is in centiseconds (1/100th of a second)
        text_parts = []
        for w in line_words:
            duration_cs = max(1, int((w["end"] - w["start"]) * 100))
            text_parts.append(f"{{\\k{duration_cs}}}{w['word']}")

        text = " ".join(text_parts)
        events += f"Dialogue: 0,{start},{end},Default,,0,0,0,,{text}\n"

    return header + events


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
    gpu="H100",
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
    """Composite a reel video: Minecraft background + Peter Griffin overlay + audio + subtitles.

    Reads audio and timestamps from R2, writes final MP4 back to R2.
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

    logging.info(
        json.dumps(
            {
                "event": "composite_inputs_loaded",
                "job_id": job_id,
                "reel_index": reel_index,
                "word_count": len(word_timestamps),
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
        #   - Scale Peter Griffin PNG to 300px wide
        #   - Overlay Peter Griffin at bottom-left
        #   - Burn in ASS subtitles
        # Encode with H100 NVENC for GPU-accelerated H.264
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
            "-filter_complex",
            (
                "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,"
                "crop=1080:1920[bg];"
                "[2:v]scale=300:-1[pg];"
                "[bg][pg]overlay=x=50:y=H-h-50[v];"
                f"[v]ass={ass_path}[out]"
            ),
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
        # shutil.copy opens in truncate mode by default
        import shutil

        shutil.copy2(output_path, str(video_dest))

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

    # --- Run compositor ---
    result = composite.remote(
        job_id=job_id,
        reel_index=reel_index,
        audio_key=audio_key,
        timestamps_key=timestamps_key,
        duration_seconds=duration_seconds,
    )

    logging.info(
        json.dumps(
            {
                "event": "composite_video_complete",
                "job_id": job_id,
                "reel_index": reel_index,
                "video_key": result["videoKey"],
            }
        )
    )

    return Response(
        content=json.dumps(result),
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

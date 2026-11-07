"""作业执行体：ffprobe/ffmpeg 直接吃连接器给的带 ticket HTTP directUrl。

源永远是 URL（不落地），成品先写 scratch 再上传。返回 (status, result_dict)。
"""
from __future__ import annotations

import os
import shutil
import subprocess

import client
import config

_FFMPEG = shutil.which("ffmpeg")
_FFPROBE = shutil.which("ffprobe")

_MIME_BY_EXT = {
    ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
    ".mkv": "video/x-matroska", ".webm": "video/webm", ".avi": "video/x-msvideo",
}


def has_ffmpeg() -> bool:
    return bool(_FFMPEG and _FFPROBE)


def _mime_for(rel_path: str | None) -> str:
    if not rel_path:
        return "video/mp4"
    return _MIME_BY_EXT.get(os.path.splitext(rel_path)[1].lower(), "video/mp4")


def _probe_duration(url: str) -> float | None:
    if not _FFPROBE:
        return None
    try:
        out = subprocess.run(
            [_FFPROBE, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", url],
            check=True, capture_output=True, timeout=60, text=True,
        )
        return float((out.stdout or "0").strip() or 0)
    except Exception:
        return None


def _has_encoder(name: str) -> bool:
    if not _FFMPEG:
        return False
    try:
        out = subprocess.run([_FFMPEG, "-hide_banner", "-encoders"],
                             capture_output=True, text=True, timeout=10)
        return name in out.stdout
    except Exception:
        return False


def _video_codec() -> list[str]:
    if _has_encoder("h264_videotoolbox"):
        return ["-c:v", "h264_videotoolbox", "-b:v", "6M"]
    if _has_encoder("h264_nvenc"):
        return ["-c:v", "h264_nvenc", "-b:v", "6M"]
    return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]


# ------------------------------------------------------------

def run_probe(node, job) -> tuple[str, dict]:
    src = (job.get("payload") or {}).get("source") or {}
    url = src.get("directUrl")
    if not url:
        return "failed", {"error": "no_source"}
    dur = _probe_duration(url)
    if dur is None:
        return "failed", {"error": "probe_failed"}
    return "completed", {"duration": dur, "mime": _mime_for(src.get("relPath"))}


def run_thumbnail(node, job) -> tuple[str, dict]:
    src = (job.get("payload") or {}).get("source") or {}
    url = src.get("directUrl")
    if not url or not _FFMPEG:
        return "failed", {"error": "no_source" if not url else "no_ffmpeg"}
    dur = _probe_duration(url) or 0
    at = min(1.0, dur / 2) if dur else 1.0
    out = os.path.join(config.SCRATCH, f"{job['mediaId']}.jpg")
    try:
        subprocess.run(
            [_FFMPEG, "-y", "-ss", f"{max(0, at)}", "-i", url,
             "-frames:v", "1", "-vf", "scale=400:-1", out],
            check=True, capture_output=True, timeout=90,
        )
    except Exception:
        return "failed", {"error": "grab_failed"}
    if not os.path.isfile(out):
        return "failed", {"error": "grab_failed"}
    with open(out, "rb") as f:
        jpg = f.read()
    try:
        client.upload_poster(node["id"], node["token"], job["mediaId"], jpg)
    except client.CoordinatorError as e:
        return "failed", {"error": f"poster_upload: {e}"}
    finally:
        try:
            os.remove(out)
        except OSError:
            pass
    return "completed", {}


def run_clip(node, job) -> tuple[str, dict]:
    p = job.get("payload") or {}
    src = p.get("source") or {}
    url = src.get("directUrl")
    upload_url = p.get("uploadUrl")
    out_rel = p.get("outRelPath")
    if not url or not upload_url or not out_rel:
        return "failed", {"error": "bad_payload"}
    if not _FFMPEG:
        return "failed", {"error": "no_ffmpeg"}
    start = float(p.get("rangeStart") or 0)
    dur = float(p.get("rangeEnd") or 0) - start
    if dur <= 0:
        return "failed", {"error": "bad_range"}
    out = os.path.join(config.SCRATCH, f"{job['mediaId']}.mp4")
    cmd = [_FFMPEG, "-y", "-ss", f"{start}", "-i", url, "-t", f"{dur}",
           *_video_codec(), "-c:a", "aac", "-movflags", "+faststart", out]
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=1800)
        size = os.path.getsize(out)
        with open(out, "rb") as f:
            client.upload_file(upload_url, f.read())
    except client.CoordinatorError as e:
        return "failed", {"error": f"upload: {e}"}
    except Exception:
        return "failed", {"error": "ffmpeg_failed"}
    finally:
        try:
            os.remove(out)
        except OSError:
            pass
    return "completed", {"rel_path": out_rel, "size": size}


_RUNNERS = {"probe": run_probe, "thumbnail": run_thumbnail, "clip": run_clip}


def run(node, job) -> tuple[str, dict]:
    fn = _RUNNERS.get(job.get("kind"))
    if not fn:
        return "failed", {"error": "unknown_kind"}
    return fn(node, job)

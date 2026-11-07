"""处理器 worker（模块拆分接缝）。

Phase 1：本机后台线程，从 `jobs` 表 claim 探测/缩略图/剪辑作业并执行，
完成后经 writes.* 回填调度中心 DB。真正的 ffmpeg/ffprobe 调用都在这里
（原 clipper._cut_one 的切片主体已挪入 _run_clip）。

Phase 2 起该逻辑搬到独立处理器进程，源文件改为经 HTTP 从连接器拉取；
届时只需把 _locate_source 换成「locate → 带 ticket 的 directUrl」，
media_assets 的 ffprobe/ffmpeg 直接吃 HTTP URL，其余不变。
"""
from __future__ import annotations

import os
import shutil
import subprocess
import threading
from typing import Callable, Optional

import config
import jobs
import media_assets
import nodes
import store
import writes

_FFMPEG = shutil.which("ffmpeg")
_KINDS = ["probe", "thumbnail", "clip"]

_lock = threading.Lock()
_thread: Optional[threading.Thread] = None

# 进度回调（阶段：面板轮询 delta 即可感知；预留给 WS）
ProgressCb = Callable[[str, str, float], None]
_listeners: list[ProgressCb] = []


def on_progress(cb: ProgressCb) -> None:
    _listeners.append(cb)


def _emit(clip_id: str, status: str, percent: float) -> None:
    for cb in list(_listeners):
        try:
            cb(clip_id, status, percent)
        except Exception:
            pass


# ------------------------------------------------------------
# ffmpeg 能力探测（macOS 硬件编码优先，回退 x264）
# ------------------------------------------------------------

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
    return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]


def _locate_source(media_id: str) -> tuple[str | None, str | None]:
    """定位源文件。Phase 1（loopback）直接用本地绝对路径；
    Phase 2 起换成带 ticket 的连接器 directUrl。"""
    row = store.get_media_row(media_id)
    if not row:
        return None, "not_found"
    return store.resolve_media_file(row)


# ------------------------------------------------------------
# 各类作业执行体：返回 (status, result_dict)
# ------------------------------------------------------------

def _run_probe(job: dict) -> tuple[str, dict]:
    mid = job["media_id"]
    src, err = _locate_source(mid)
    if err or not src:
        return "failed", {"error": err or "no_source"}
    probed = media_assets.probe_video(src)
    if not probed:
        return "failed", {"error": "probe_failed"}
    dur, mime = probed
    try:
        size = os.path.getsize(src)
    except OSError:
        size = None
    writes.apply_probe(mid, dur, mime=mime, size=size)
    return "completed", {"duration": dur, "mime": mime}


def _run_thumbnail(job: dict) -> tuple[str, dict]:
    mid = job["media_id"]
    src, err = _locate_source(mid)
    if err or not src:
        return "failed", {"error": err or "no_source"}
    row = store.get_media_row(mid)
    dur = float(row["duration"] or 0)
    at = min(1.0, dur / 2) if dur else 1.0
    poster_rel = media_assets.grab_poster(src, f"{mid}.jpg", at_sec=at)
    if not poster_rel:
        return "failed", {"error": "grab_failed"}
    writes.set_poster(mid, poster_rel)
    return "completed", {"poster_path": poster_rel}


def _run_clip(job: dict) -> tuple[str, dict]:
    clip_id = job["media_id"]
    row = store.get_media_row(clip_id)
    if not row:
        return "failed", {"error": "clip_missing"}
    parent = store.get_media_row(row["parent_id"]) if row["parent_id"] else None
    if not parent:
        writes.set_clip_status(clip_id, "failed")
        _emit(clip_id, "failed", 0)
        return "failed", {"error": "parent_missing"}
    # 母素材可能在外部存储（登记引用）；统一走 resolve_media_file，兼顾离线/缺失
    src, err = store.resolve_media_file(parent)
    if err or not src:
        writes.set_clip_status(clip_id, "failed")
        _emit(clip_id, "failed", 0)
        return "failed", {"error": err or "no_source"}
    if not _FFMPEG:
        writes.set_clip_status(clip_id, "failed")
        _emit(clip_id, "failed", 0)
        return "failed", {"error": "no_ffmpeg"}

    writes.set_clip_status(clip_id, "cutting")
    _emit(clip_id, "cutting", 0)

    out_rel = f"clips/{clip_id}.mp4"
    out_abs = os.path.join(config.CLIPS_DIR, f"{clip_id}.mp4")
    start = float(row["range_start"] or 0)
    dur = float(row["range_end"] or 0) - start
    cmd = [
        _FFMPEG, "-y", "-ss", f"{start}", "-i", src, "-t", f"{dur}",
        *_video_codec(), "-c:a", "aac", "-movflags", "+faststart", out_abs,
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=600)
        size = os.path.getsize(out_abs)
        writes.set_clip_status(clip_id, "completed", file_path=out_rel, has_file=True, size=size)
        _emit(clip_id, "completed", 100)
        return "completed", {"rel_path": out_rel, "size": size}
    except Exception:
        writes.set_clip_status(clip_id, "failed")
        _emit(clip_id, "failed", 0)
        return "failed", {"error": "ffmpeg_failed"}


_RUNNERS = {"probe": _run_probe, "thumbnail": _run_thumbnail, "clip": _run_clip}


def run_job(job: dict) -> tuple[str, dict]:
    runner = _RUNNERS.get(job["kind"])
    if not runner:
        return "failed", {"error": "unknown_kind"}
    jobs.mark_running(job["id"])
    return runner(job)


def _loop() -> None:
    global _thread
    try:
        while True:
            job = jobs.claim(_KINDS, nodes.LOOPBACK_ID)
            if not job:
                break
            status, result = run_job(job)
            jobs.complete(job["id"], status, result)
    finally:
        with _lock:
            _thread = None
    # 收尾竞态：循环退出后若又有新活入队（enqueue 与退出交错），补起一轮
    if jobs.pending_count(_KINDS):
        wake()


def wake() -> int:
    """确保 worker 线程在跑（若有可领作业）。返回当前可领作业数。

    本机无 ffmpeg/ffprobe 时不领活——作业留在 queued，交给具备算力的处理器
    （保留离线排队语义：探测/海报/剪辑会等到有处理器上线才执行）。
    仅 monolith 模式内嵌本地 worker；coordinator 模式一律交给远程处理器。
    """
    global _thread
    n = jobs.pending_count(_KINDS)
    if config.VM_MODE != "monolith":
        return n
    if not _FFMPEG or not media_assets.has_ffmpeg():
        return n
    with _lock:
        if _thread is None and n:
            _thread = threading.Thread(target=_loop, daemon=True)
            _thread.start()
    return n

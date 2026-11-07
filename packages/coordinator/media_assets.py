"""种子用的真实资产生成：用 ffmpeg 造可播放的 demo 视频，用 PIL 造海报。

只在首次 seed 时跑一次，产物落到 data/videos、data/thumbs。
没有 ffmpeg/PIL 时跳过对应产物（DB 里 has_file=0 / poster_path=None），
不影响元数据可浏览。
"""
from __future__ import annotations

import os
import shutil
import subprocess

import config

try:
    from PIL import Image, ImageDraw, ImageFont

    _HAS_PIL = True
except Exception:  # pragma: no cover
    _HAS_PIL = False

_FFMPEG = shutil.which("ffmpeg")


def has_ffmpeg() -> bool:
    return _FFMPEG is not None


def make_demo_video(rel_name: str, seconds: int = 6) -> tuple[str, float, int, str] | None:
    """生成一段竖屏测试视频到 data/videos/<rel_name>。

    返回 (相对路径, 时长, 字节数, mime)；无 ffmpeg 返回 None。
    """
    if not _FFMPEG:
        return None
    out_abs = os.path.join(config.VIDEOS_DIR, rel_name)
    if not os.path.exists(out_abs):
        # 竖屏 720x1280、带时间码的测试图 + 静音音轨，H.264 便于手机直连播放
        cmd = [
            _FFMPEG, "-y",
            "-f", "lavfi", "-i", f"testsrc=size=720x1280:rate=25:duration={seconds}",
            "-f", "lavfi", "-i", f"anullsrc=channel_layout=stereo:sample_rate=44100",
            "-t", str(seconds),
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast",
            "-c:a", "aac", "-shortest",
            "-movflags", "+faststart",
            out_abs,
        ]
        subprocess.run(cmd, check=True, capture_output=True)
    size = os.path.getsize(out_abs)
    return f"videos/{rel_name}", float(seconds), size, "video/mp4"


_HUE_RGB = {
    # 近似把种子里的「色相」映射成一个底色
    350: (190, 60, 80),
    200: (60, 130, 160),
    220: (70, 90, 170),
    25: (200, 150, 70),
    130: (70, 160, 110),
    265: (120, 80, 180),
    320: (180, 70, 140),
    210: (70, 110, 170),
}


def make_poster(rel_name: str, title: str, subtitle: str, hue: int) -> str | None:
    """生成一张 2:3 海报到 data/thumbs/<rel_name>，返回相对路径。"""
    if not _HAS_PIL:
        return None
    out_abs = os.path.join(config.THUMBS_DIR, rel_name)
    if os.path.exists(out_abs):
        return f"thumbs/{rel_name}"
    w, h = 400, 600
    base = _HUE_RGB.get(hue, (90, 90, 110))
    img = Image.new("RGB", (w, h), base)
    draw = ImageDraw.Draw(img)
    # 顶部到底部的暗角渐变，增强层次
    for y in range(h):
        a = int(90 * (y / h))
        draw.line([(0, y), (w, y)], fill=(max(0, base[0] - a), max(0, base[1] - a), max(0, base[2] - a)))

    def _font(size: int):
        for name in ("PingFang.ttc", "STHeiti Light.ttc", "Arial Unicode.ttf"):
            for root in ("/System/Library/Fonts", "/Library/Fonts", "/System/Library/Fonts/Supplemental"):
                p = os.path.join(root, name)
                if os.path.exists(p):
                    try:
                        return ImageFont.truetype(p, size)
                    except Exception:
                        pass
        return ImageFont.load_default()

    draw.text((28, h - 130), title, font=_font(34), fill=(255, 255, 255))
    if subtitle:
        draw.text((28, h - 78), subtitle, font=_font(20), fill=(220, 220, 220))
    img.save(out_abs, "JPEG", quality=85)
    return f"thumbs/{rel_name}"


_FFPROBE = shutil.which("ffprobe")


def probe_video(abs_path: str) -> tuple[float, str] | None:
    """探测视频时长与容器格式。返回 (时长秒, mime)；探测失败返回 None。"""
    if not _FFPROBE:
        return None
    try:
        out = subprocess.run(
            [_FFPROBE, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", abs_path],
            check=True, capture_output=True, timeout=30, text=True,
        )
        dur = float((out.stdout or "0").strip() or 0)
    except Exception:
        return None
    ext = os.path.splitext(abs_path)[1].lower()
    mime = {
        ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
        ".mkv": "video/x-matroska", ".webm": "video/webm", ".avi": "video/x-msvideo",
    }.get(ext, "video/mp4")
    return dur, mime


def grab_poster(abs_path: str, rel_name: str, at_sec: float = 1.0) -> str | None:
    """从视频抽一帧存成海报到 data/thumbs/<rel_name>，返回相对路径；失败返回 None。"""
    if not _FFMPEG:
        return None
    out_abs = os.path.join(config.THUMBS_DIR, rel_name)
    if os.path.exists(out_abs):
        return f"thumbs/{rel_name}"
    try:
        subprocess.run(
            [_FFMPEG, "-y", "-ss", f"{max(0, at_sec)}", "-i", abs_path,
             "-frames:v", "1", "-vf", "scale=400:-1", out_abs],
            check=True, capture_output=True, timeout=60,
        )
    except Exception:
        return None
    return f"thumbs/{rel_name}" if os.path.exists(out_abs) else None

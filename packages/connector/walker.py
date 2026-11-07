"""walk 一个存储根，产出候选视频文件（不碰 DB / ffprobe）。与调度中心 scanner.walk_root 一致。"""
from __future__ import annotations

import os

_VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"}


def walk_root(root: str) -> list[dict]:
    """返回候选视频文件 [{relPath, size, mtime}]（camelCase，直接进 scan-report）。"""
    items: list[dict] = []
    for dirpath, _dirs, files in os.walk(root):
        for fn in sorted(files):
            if os.path.splitext(fn)[1].lower() not in _VIDEO_EXTS:
                continue
            abs_path = os.path.join(dirpath, fn)
            rel = os.path.relpath(abs_path, root).replace("\\", "/")
            try:
                st = os.stat(abs_path)
                size, mtime = st.st_size, int(st.st_mtime * 1000)
            except OSError:
                size, mtime = 0, 0
            items.append({"relPath": rel, "size": size, "mtime": mtime})
    return items

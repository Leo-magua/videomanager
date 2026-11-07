"""PC 后端配置：磁盘目录与数据库路径。

数据分两类（见 docs/后端数据结构.md）：
  - 元数据 → SQLite（library.db）
  - 大文件 → data/ 下的子目录，DB 里只存相对路径
"""
from __future__ import annotations

import os

# server/ 目录
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# 数据根目录：可用环境变量 VM_DATA_DIR 覆盖（默认 server/data）
DATA_DIR = os.environ.get("VM_DATA_DIR") or os.path.join(BASE_DIR, "data")

DB_PATH = os.path.join(DATA_DIR, "library.db")

# 大文件子目录（与 docs/后端数据结构.md 第 6 节一致）
VIDEOS_DIR = os.path.join(DATA_DIR, "videos")   # 原始视频     -> media.file_path
CLIPS_DIR = os.path.join(DATA_DIR, "clips")     # 剪辑产物     -> 片段 file_path
THUMBS_DIR = os.path.join(DATA_DIR, "thumbs")   # 缩略图/海报  -> media.poster_path
ACTORS_DIR = os.path.join(DATA_DIR, "actors")   # 演员照片     -> actors.photo_path

# file_path / poster_path 里的目录前缀 -> 绝对根目录
_KIND_ROOTS = {
    "videos": VIDEOS_DIR,
    "clips": CLIPS_DIR,
    "thumbs": THUMBS_DIR,
    "actors": ACTORS_DIR,
}

VERSION = "0.1.0"

# 运行模式（模块拆分）：
#   monolith    —— 单机：调度中心内嵌 loopback 连接器 + 本地处理器 worker（默认，字节级不变）
#   coordinator —— 独立调度中心：不碰视频字节/不跑 ffmpeg，连接器/处理器为独立进程
VM_MODE = (os.environ.get("VM_MODE") or "monolith").strip().lower()


def ensure_dirs() -> None:
    for d in (DATA_DIR, VIDEOS_DIR, CLIPS_DIR, THUMBS_DIR, ACTORS_DIR):
        os.makedirs(d, exist_ok=True)


def resolve_asset(rel_path: str) -> str | None:
    """把 DB 里的相对路径（如 "videos/x.mp4"）解析成磁盘绝对路径。

    只允许落在四个受控目录内，防目录穿越。找不到/越权返回 None。
    """
    if not rel_path:
        return None
    rel_path = rel_path.replace("\\", "/").lstrip("/")
    head, _, tail = rel_path.partition("/")
    root = _KIND_ROOTS.get(head)
    if not root or not tail:
        return None
    abs_path = os.path.normpath(os.path.join(root, tail))
    # 归一化后必须仍在 root 内
    if os.path.commonpath([abs_path, root]) != os.path.normpath(root):
        return None
    return abs_path


def resolve_within_root(root_path: str, rel_path: str) -> str | None:
    """把「存储设备根 + 该根内相对子路径」解析成绝对路径。

    用于登记引用（不搬动）的外部素材：root_path 是后端可直达的存储根，
    file_path 是相对该根的子路径。归一化后必须仍落在 root_path 内，防目录穿越
    （`..`、绝对路径、软链逃逸的字符串层面拦截）。越权/空值返回 None。
    """
    if not root_path or not rel_path:
        return None
    root = os.path.normpath(root_path)
    rel = rel_path.replace("\\", "/").lstrip("/")
    abs_path = os.path.normpath(os.path.join(root, rel))
    if os.path.commonpath([abs_path, root]) != root:
        return None
    return abs_path

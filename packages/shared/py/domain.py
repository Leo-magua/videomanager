"""S1 领域模型（Python）—— 与 ts/domain.ts 严格对齐。

四种核心数据：素材(MediaItem) / 标记(Mark) / 演员(Actor) / 片段(clip=kind='clip').
大文件不进 DB：视频用 file_path 指磁盘，缩略图用 poster_path 指磁盘。

注：字段名用 snake_case（Python 习惯）；API 序列化到 JSON 时统一转 camelCase
（见 protocol.py 的 to_camel/序列化约定），以匹配 TS 端。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Optional

MediaKind = Literal["source", "clip"]
ClipStatus = Literal["pending", "cutting", "completed", "failed"]
StorageKind = Literal["local", "nas", "remote"]
NodeKind = Literal["connector", "processor"]


@dataclass
class Mark:
    id: str
    media_id: str
    time: float          # 秒
    label: str
    color: str
    created_at: int
    note: Optional[str] = None


@dataclass
class ActorRating:
    figure: int          # 身材 0-5
    looks: int           # 颜值 0-5
    acting: int          # 演技 0-5


@dataclass
class Actor:
    name: str            # 主键，全局唯一
    updated_at: int
    tags: list[str] = field(default_factory=list)
    ratings: Optional[ActorRating] = None
    bio: Optional[str] = None
    photo_path: Optional[str] = None   # 相对 data/actors/


@dataclass
class MediaItem:
    id: str
    name: str
    kind: MediaKind
    duration: float      # 秒；未下载为 0
    size: int            # 字节
    mime: str
    rating: float        # 0-10（0.5/0.1 精度）
    folder: str          # "电影/科幻"；空串=根
    has_file: bool
    created_at: int
    updated_at: int
    tags: list[str] = field(default_factory=list)
    cast: list[str] = field(default_factory=list)
    poster_path: Optional[str] = None   # 相对 data/thumbs/
    year: Optional[str] = None
    synopsis: Optional[str] = None
    file_path: Optional[str] = None      # 相对 data/videos|clips/ 或相对存储根；未下载=None
    storage_id: Optional[str] = None     # 所属存储设备 id；None=内建 data/ 目录

    original_path: Optional[str] = None
    source_kind: Optional[str] = None
    storage_name: Optional[str] = None

    # 仅片段(clip)
    parent_id: Optional[str] = None
    parent_name: Optional[str] = None
    range_start: Optional[float] = None
    range_end: Optional[float] = None
    clip_status: Optional[ClipStatus] = None


@dataclass
class Storage:
    """存储设备：后端唯一大脑，视频文件散在多个存储上（登记引用，不搬动）。"""
    id: str
    name: str
    kind: StorageKind
    root_path: str        # 后端可直达的绝对根路径
    online: bool          # 根目录当前是否可达
    added_at: int
    node_id: Optional[str] = None   # 持有该存储的连接器节点；None=调度中心本地(loopback)


@dataclass
class NodeCapabilities:
    """节点能力声明。连接器一般 has_ffmpeg=False（薄），处理器 has_ffmpeg=True。"""
    has_ffmpeg: bool = False


@dataclass
class Node:
    """模块拆分后的节点：连接器（持有文件+串流）或处理器（跑 ffmpeg）。

    只有调度中心拥有 DB；节点通过 HTTP enroll/heartbeat/回调，绝不直接写库。
    token 不进领域对象（只在 enroll 响应里下发一次，服务端仅存哈希）。
    """
    id: str
    kind: NodeKind
    name: str
    online: bool
    enrolled_at: int
    base_url: Optional[str] = None          # 连接器对外可达地址（直连串流用）
    last_seen: Optional[int] = None
    capabilities: NodeCapabilities = field(default_factory=NodeCapabilities)
    roots: list[dict] = field(default_factory=list)   # 连接器持有的存储 [{id,name}]
    is_coordinator: bool = False                       # loopback：存储+处理器，恒在线


def has_local_file(item: MediaItem) -> bool:
    return item.has_file and item.file_path is not None

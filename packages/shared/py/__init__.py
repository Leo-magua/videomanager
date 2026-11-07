"""视频素材管理器 · 共享契约（Python 端）。

from shared_py import MediaItem, Mark, Actor, OutboxEntry, ...
"""
from .domain import (
    Actor,
    ActorRating,
    ClipStatus,
    Mark,
    MediaItem,
    MediaKind,
    has_local_file,
)
from .protocol import (
    CreateClipRequest,
    Event,
    FlushResponse,
    LibraryDelta,
    LibrarySnapshot,
    OutboxEntry,
    files_stream_path,
    files_upload_path,
    keys_to_camel,
    keys_to_snake,
    poster_path,
    stream_path,
    to_camel,
    to_snake,
)

__all__ = [
    "Actor", "ActorRating", "ClipStatus", "Mark", "MediaItem", "MediaKind",
    "has_local_file", "CreateClipRequest", "Event", "FlushResponse",
    "LibraryDelta", "LibrarySnapshot", "OutboxEntry", "keys_to_camel",
    "keys_to_snake", "poster_path", "stream_path", "to_camel", "to_snake",
    "files_stream_path", "files_upload_path",
]

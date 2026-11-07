"""S2 协议（Python）—— 与 ts/protocol.ts 严格对齐。

包含：REST DTO、WebSocket 事件、Outbox 离线写操作。
序列化约定：Python 内部 snake_case，出入 JSON 时转 camelCase 以匹配 TS 端。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Literal, Optional, Union

# ============================================================
# 命名转换：Python snake_case <-> JSON camelCase
# ============================================================

def to_camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(w.capitalize() for w in rest)


_snake_re = re.compile(r"(?<!^)(?=[A-Z])")

def to_snake(name: str) -> str:
    return _snake_re.sub("_", name).lower()


def keys_to_camel(obj: Any) -> Any:
    """递归把 dict 的 key 转 camelCase（用于响应序列化）。"""
    if isinstance(obj, dict):
        return {to_camel(k): keys_to_camel(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [keys_to_camel(v) for v in obj]
    return obj


def keys_to_snake(obj: Any) -> Any:
    """递归把 dict 的 key 转 snake_case（用于请求解析）。"""
    if isinstance(obj, dict):
        return {to_snake(k): keys_to_snake(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [keys_to_snake(v) for v in obj]
    return obj


# ============================================================
# REST DTO（字段与 ts/protocol.ts 对应；此处只列结构，序列化用 dict 承载）
# ============================================================

@dataclass
class LibrarySnapshot:
    media: list[dict]
    marks: list[dict]
    actors: list[dict]
    storages: list[dict]
    revision: int


@dataclass
class LibraryDelta:
    upsert_media: list[dict]
    delete_media_ids: list[str]
    upsert_marks: list[dict]
    delete_mark_ids: list[str]
    upsert_actors: list[dict]
    delete_actor_names: list[str]
    revision: int


@dataclass
class CreateClipRequest:
    parent_id: str
    range_start: float
    range_end: float
    name: str


@dataclass
class AddStorageRequest:
    """POST /api/storages —— 注册存储设备并触发扫描登记。"""
    path: str                       # 后端可直达的绝对目录
    name: Optional[str] = None
    kind: str = "local"
    node_id: Optional[str] = None   # 目标设备；None/loopback=本机，否则登记到远程连接器


def storages_path() -> str:
    return "/api/storages"


def rescan_path(storage_id: str) -> str:
    return f"/api/storages/{storage_id}/rescan"


def nodes_path() -> str:
    return "/api/nodes"


def enroll_info_path() -> str:
    return "/api/enroll-info"


def stream_path(media_id: str) -> str:
    return f"/api/media/{media_id}/stream"


def poster_path(media_id: str) -> str:
    return f"/api/media/{media_id}/poster"


# ============================================================
# 模块拆分：节点 enroll / heartbeat、作业队列、扫描上报、智能串流定位
# 只有调度中心拥有 DB；连接器/处理器通过以下 DTO 经 HTTP 与调度中心通信。
# ============================================================

JobKind = Literal["probe", "thumbnail", "clip"]
JobStatus = Literal["queued", "claimed", "running", "completed", "failed"]


@dataclass
class Job:
    id: str
    kind: JobKind
    status: JobStatus
    created_at: int
    updated_at: int
    media_id: Optional[str] = None
    node_id: Optional[str] = None            # 源文件所属连接器节点
    payload: dict = field(default_factory=dict)
    result: Optional[dict] = None
    attempts: int = 0


@dataclass
class EnrollRequest:
    """POST /api/nodes/enroll —— 连接器/处理器上线注册（用 enrollment token 鉴权）。"""
    kind: str                                # connector | processor
    name: str = ""
    base_url: Optional[str] = None
    capabilities: dict = field(default_factory=dict)   # {"hasFfmpeg": bool}
    roots: list[str] = field(default_factory=list)     # 连接器登记的绝对根路径列表


@dataclass
class EnrollResponse:
    node_id: str
    node_token: str                          # 后续调用的 Bearer；服务端只存哈希
    stream_key: str                          # 该节点签流 ticket 的 HMAC 密钥
    revision: int
    storage_ids: list[str] = field(default_factory=list)   # 连接器各 root 对应的存储 id（与请求 roots 对齐）


@dataclass
class HeartbeatRequest:
    node_id: str
    online: bool = True
    roots: Optional[list[str]] = None
    capabilities: Optional[dict] = None


@dataclass
class HeartbeatResponse:
    revision: int
    pending_job_hint: int = 0                # 有多少可领作业（处理器据此决定是否 claim）


@dataclass
class ScanReportItem:
    rel_path: str
    size: int
    mtime: int


@dataclass
class ScanReportRequest:
    """连接器 walk 完一个根后上报候选文件；调度中心据此 INSERT media 并派 probe/thumbnail 作业。"""
    node_id: str
    root_id: str                             # 存储 id
    items: list[dict] = field(default_factory=list)    # [ScanReportItem]
    done: bool = True


@dataclass
class ScanReportResponse:
    accepted: int
    new_media_ids: list[str] = field(default_factory=list)


@dataclass
class ClaimRequest:
    node_id: str
    kinds: list[str] = field(default_factory=list)     # 处理器能干的活：probe/thumbnail/clip


@dataclass
class ClaimResponse:
    job: Optional[dict] = None               # 一个 Job（含 payload：源 direct_url + ticket 等）；None=无活


@dataclass
class CompleteRequest:
    """POST /api/jobs/<id>/complete —— 处理器回填结果。

    result 按 kind：probe→{duration,mime,size}；thumbnail→已单独上传，仅置状态；
    clip→{rel_path,size,node_id}（成品已上传到属主连接器）。
    """
    status: str                              # completed | failed
    result: dict = field(default_factory=dict)


@dataclass
class StreamLocateResponse:
    """GET /api/media/<id>/stream-locate —— 智能串流：先直连连接器，连不上回落代理。"""
    node_id: str
    direct_url: str                          # 连接器直连地址（带签名 ticket）
    proxy_url: str                           # 调度中心代理转发地址（回落）
    ticket: str
    expires_at: int


# ---- 模块 API 路径（与 ts 镜像）----

def stream_locate_path(media_id: str) -> str:
    return f"/api/media/{media_id}/stream-locate"


def node_enroll_path() -> str:
    return "/api/nodes/enroll"


def heartbeat_path() -> str:
    return "/api/nodes/heartbeat"


def scan_report_path() -> str:
    return "/api/nodes/scan-report"


def job_claim_path() -> str:
    return "/api/jobs/claim"


def job_complete_path(job_id: str) -> str:
    return f"/api/jobs/{job_id}/complete"


def poster_upload_path(media_id: str) -> str:
    return f"/api/media/{media_id}/poster"


# ---- 连接器侧路径（ticket 鉴权，不在调度中心）----

def files_stream_path() -> str:
    return "/files/stream"


def files_upload_path() -> str:
    return "/files/upload"


# ============================================================
# WebSocket 事件类型常量（服务端 → 面板）
# ============================================================

class Event:
    LIBRARY_CHANGED = "library.changed"
    MEDIA_UPSERTED = "media.upserted"
    MEDIA_DELETED = "media.deleted"
    ACTOR_UPSERTED = "actor.upserted"
    CLIP_PROGRESS = "clip.progress"
    CLIP_DONE = "clip.done"
    CLIP_FAILED = "clip.failed"


# ============================================================
# Outbox 离线写操作
# ============================================================

OutboxKind = Literal[
    "media.rename", "media.setRating", "media.setTags", "media.setCast",
    "mark.add", "mark.update", "mark.remove", "clip.create", "actor.upsert",
]


@dataclass
class OutboxEntry:
    op_id: str            # 幂等键
    seq: int              # 单调保序
    kind: OutboxKind
    payload: dict
    created_at: int
    # 目标定位（按 kind 取用）
    media_id: Optional[str] = None
    mark_id: Optional[str] = None


@dataclass
class FlushResponse:
    acked_op_ids: list[str]
    rejected: list[dict]          # [{op_id, reason}]
    delta: LibraryDelta

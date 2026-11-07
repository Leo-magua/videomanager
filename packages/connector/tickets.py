"""签名流 ticket 验签（连接器侧，只需 verify）。

调度中心用**本连接器的** stream_key 为每次直连/处理器拉流签一张短时 ticket；
连接器凭同一 stream_key 验 HMAC + 过期。逻辑与调度中心 tickets.py 严格一致。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time


def _b64u_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def _b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def verify(stream_key: str, ticket: str, now: float | None = None) -> dict | None:
    """验签 + 校验过期。成功返回 {node_id, storage_id, media_id, rel_path, exp}；失败 None。"""
    if not stream_key or not ticket:
        return None
    try:
        body, sig = ticket.split(".", 1)
    except ValueError:
        return None
    expect = _b64u(hmac.new(stream_key.encode(), body.encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(sig, expect):
        return None
    try:
        payload = json.loads(_b64u_decode(body))
    except Exception:
        return None
    t = now if now is not None else time.time()
    if int(payload.get("exp", 0)) < t:
        return None
    return {
        "node_id": payload.get("n"),
        "storage_id": payload.get("s"),
        "media_id": payload.get("m"),
        "rel_path": payload.get("p"),
        "exp": payload.get("exp"),
        "purpose": payload.get("purpose", "stream"),
        "destination": payload.get("destination"),
    }

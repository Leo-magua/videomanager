"""签名流 ticket（模块拆分鉴权之三）。

调度中心为每次直连串流签一张短时 ticket；连接器用**自己那份** stream_key 验签。
per-media、~5min TTL —— 泄露面有限，替代把手机 token 暴露给连接器。
stdlib hmac-sha256，不引 PyJWT。

ticket 格式：`<base64url(payload_json)>.<base64url(hmac_sha256)>`
payload：{n: node_id, s: storage_id, m: media_id, p: rel_path, exp: 秒级过期时间}
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time

TTL_SECONDS = 300


def _b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64u_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def sign(stream_key: str, node_id: str, storage_id: str | None, media_id: str,
         rel_path: str, ttl: int = TTL_SECONDS, now: float | None = None, purpose: str = "stream", destination: str | None = None) -> tuple[str, int]:
    """签一张 ticket，返回 (ticket, expires_at_ms)。"""
    base = now if now is not None else time.time()
    exp = int(base + ttl)
    payload = {"n": node_id, "s": storage_id, "m": media_id, "p": rel_path, "exp": exp, "purpose": purpose}
    if destination is not None:
        payload["destination"] = destination
    body = _b64u(json.dumps(payload, separators=(",", ":")).encode())
    sig = _b64u(hmac.new(stream_key.encode(), body.encode(), hashlib.sha256).digest())
    return f"{body}.{sig}", exp * 1000


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

"""Outbox 回放：面板离线时把写操作入队，上线后 POST /api/outbox/flush 批量重放。

服务端权威：按 seq 排序执行，opId 幂等去重（processed_ops 表记录已处理的 opId）。
每种 op 映射到 writes.py 的对应函数。返回 ackedOpIds + rejected + 最新 delta。
"""
from __future__ import annotations

import db
import store
import writes
import clipper

_PROCESSED_SCHEMA = """
CREATE TABLE IF NOT EXISTS processed_ops (
    op_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL
);
"""


def _ensure_table() -> None:
    db.get_conn().executescript(_PROCESSED_SCHEMA)


def _already_done(op_id: str) -> bool:
    _ensure_table()
    return db.get_conn().execute(
        "SELECT 1 FROM processed_ops WHERE op_id=?", (op_id,)
    ).fetchone() is not None


def _mark_done(op_id: str) -> None:
    db.get_conn().execute(
        "INSERT OR IGNORE INTO processed_ops(op_id, revision) VALUES(?,?)",
        (op_id, db.current_revision()),
    )
    db.get_conn().commit()


def _apply(op: dict) -> bool:
    """按 kind 分派到 writes。成功返回 True。"""
    kind = op.get("kind")
    p = op.get("payload") or {}
    mid = op.get("mediaId")
    try:
        if kind == "media.rename":
            return writes.rename_media(mid, p.get("name", "")) is not None
        if kind == "media.setRating":
            return writes.set_rating(mid, p.get("rating", 0)) is not None
        if kind == "media.setTags":
            return writes.set_tags(mid, p.get("tags", [])) is not None
        if kind == "media.setCast":
            return writes.set_cast(mid, p.get("cast", [])) is not None
        if kind == "mark.add":
            return writes.add_mark(mid, p.get("time", 0), p.get("label"), p.get("note")) is not None
        if kind == "mark.update":
            return writes.update_mark(mid, op.get("markId"), p) is not None
        if kind == "mark.remove":
            return writes.remove_mark(mid, op.get("markId"))
        if kind == "clip.create":
            r = writes.create_clip(p["parentId"], p["rangeStart"], p["rangeEnd"], p["name"])
            if r:
                clipper.process_pending_async()
            return r is not None
        if kind == "actor.upsert":
            return writes.upsert_actor(p) is not None
    except Exception:
        return False
    return False


def flush(entries: list[dict], since: int | None = None) -> dict:
    """处理一批 Outbox 条目。entries: [{opId, seq, op, createdAt}]。"""
    _ensure_table()
    base_rev = since if since is not None else 0
    acked: list[str] = []
    rejected: list[dict] = []

    for e in sorted(entries, key=lambda x: x.get("seq", 0)):
        op_id = e.get("opId")
        if not op_id:
            rejected.append({"opId": "", "reason": "missing opId"})
            continue
        if _already_done(op_id):
            acked.append(op_id)  # 幂等：已处理过，直接确认
            continue
        ok = _apply(e.get("op") or {})
        if ok:
            _mark_done(op_id)
            acked.append(op_id)
        else:
            rejected.append({"opId": op_id, "reason": "apply failed or target missing"})

    return {
        "ackedOpIds": acked,
        "rejected": rejected,
        "delta": store.delta(base_rev),
    }

"""作业队列（模块拆分接缝）。

调度中心维护 `jobs` 表；处理器（Phase 1 为本机 worker 线程，Phase 2+ 为独立进程）
claim → 执行 → complete。

作业内部流转**不 bump 面板 revision**：面板只关心 media/marks/actors 的变化，
那些变化在作业完成回填时由 writes.* 各自 bump（见 writes.apply_probe/set_poster/
set_clip_status）。jobs.rev 预留给未来的乐观并发，Phase 1 不用。
"""
from __future__ import annotations

import json
import time
import uuid
from typing import Optional

import db


def _now() -> int:
    return int(time.time() * 1000)


def _row_to_dict(row) -> dict:
    return {
        "id": row["id"],
        "kind": row["kind"],
        "status": row["status"],
        "media_id": row["media_id"],
        "node_id": row["node_id"],
        "claimed_by": row["claimed_by"],
        "payload": json.loads(row["payload"] or "{}"),
        "result": json.loads(row["result"]) if row["result"] else None,
        "attempts": row["attempts"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def enqueue(kind: str, media_id: Optional[str] = None, node_id: Optional[str] = None,
            payload: Optional[dict] = None) -> str:
    """入队一个 queued 作业，返回作业 id。"""
    conn = db.get_conn()
    jid = uuid.uuid4().hex[:12]
    now = _now()
    conn.execute(
        "INSERT INTO jobs"
        "(id,kind,status,media_id,node_id,claimed_by,payload,result,attempts,created_at,updated_at,rev)"
        " VALUES(?,?,'queued',?,?,NULL,?,NULL,0,?,?,0)",
        (jid, kind, media_id, node_id, json.dumps(payload or {}), now, now),
    )
    conn.commit()
    return jid


def claim(kinds: list[str], claimer_id: str) -> Optional[dict]:
    """原子领取一个 queued 作业（按 created_at 最旧优先）。无活/竞争丢失返回 None。"""
    if not kinds:
        return None
    conn = db.get_conn()
    placeholders = ",".join("?" for _ in kinds)
    row = conn.execute(
        f"SELECT id FROM jobs WHERE status='queued' AND kind IN ({placeholders})"
        " ORDER BY created_at LIMIT 1",
        tuple(kinds),
    ).fetchone()
    if not row:
        return None
    jid = row["id"]
    cur = conn.execute(
        "UPDATE jobs SET status='claimed', claimed_by=?, attempts=attempts+1, updated_at=?"
        " WHERE id=? AND status='queued'",
        (claimer_id, _now(), jid),
    )
    conn.commit()
    if cur.rowcount == 0:
        return None  # 竞争丢失（被别的处理器领走）
    full = conn.execute("SELECT * FROM jobs WHERE id=?", (jid,)).fetchone()
    return _row_to_dict(full)


def mark_running(job_id: str) -> None:
    conn = db.get_conn()
    conn.execute("UPDATE jobs SET status='running', updated_at=? WHERE id=?", (_now(), job_id))
    conn.commit()


def complete(job_id: str, status: str, result: Optional[dict] = None) -> None:
    """回填作业结果并置终态（completed | failed）。"""
    conn = db.get_conn()
    conn.execute(
        "UPDATE jobs SET status=?, result=?, updated_at=? WHERE id=?",
        (status, json.dumps(result) if result is not None else None, _now(), job_id),
    )
    conn.commit()


def get(job_id: str) -> Optional[dict]:
    row = db.get_conn().execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    return _row_to_dict(row) if row else None


def pending_count(kinds: Optional[list[str]] = None) -> int:
    conn = db.get_conn()
    if kinds:
        placeholders = ",".join("?" for _ in kinds)
        return conn.execute(
            f"SELECT COUNT(*) c FROM jobs WHERE status='queued' AND kind IN ({placeholders})",
            tuple(kinds),
        ).fetchone()["c"]
    return conn.execute("SELECT COUNT(*) c FROM jobs WHERE status='queued'").fetchone()["c"]


def has_open_job_for(media_id: str, kind: str) -> bool:
    """该 media 是否已有未结束（queued/claimed/running）的某类作业。"""
    row = db.get_conn().execute(
        "SELECT 1 FROM jobs WHERE media_id=? AND kind=?"
        " AND status IN ('queued','claimed','running') LIMIT 1",
        (media_id, kind),
    ).fetchone()
    return row is not None

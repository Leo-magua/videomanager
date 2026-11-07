"""剪辑作业入队（模块拆分接缝）。

真正的切片执行已挪到 worker.py（处理器职责，见 worker._run_clip）。
本模块只负责：为 pending 片段补派 clip 作业，并唤醒本机 worker。

`process_pending_async()` 保持为公共入口（app.py / outbox.py 调用点不变）：
PC 上线或新建片段后调用，给尚无在办 clip 作业的 pending 片段各补一个作业。
"""
from __future__ import annotations

import db
import jobs
import worker


def pending_clip_ids() -> list[str]:
    return [
        r["id"]
        for r in db.get_conn().execute(
            "SELECT id FROM media WHERE kind='clip' AND clip_status='pending' ORDER BY created_at"
        )
    ]


def enqueue_pending() -> int:
    """为没有在办 clip 作业的 pending 片段各补一个 clip 作业。返回入队数。"""
    conn = db.get_conn()
    n = 0
    for cid in pending_clip_ids():
        if jobs.has_open_job_for(cid, "clip"):
            continue
        # 源=父素材所属连接器节点；Phase 1 loopback 下 node_id 可为 NULL
        node_id = None
        row = conn.execute("SELECT parent_id FROM media WHERE id=?", (cid,)).fetchone()
        if row and row["parent_id"]:
            p = conn.execute(
                "SELECT storage_id FROM media WHERE id=?", (row["parent_id"],)
            ).fetchone()
            if p and p["storage_id"]:
                s = conn.execute(
                    "SELECT node_id FROM storages WHERE id=?", (p["storage_id"],)
                ).fetchone()
                node_id = s["node_id"] if s else None
        jobs.enqueue("clip", media_id=cid, node_id=node_id)
        n += 1
    return n


def process_pending_async() -> int:
    """（公共入口，签名不变）补派 pending 片段作业并唤醒 worker。返回可领作业数。"""
    enqueue_pending()
    return worker.wake()


# 进度回调兼容转发（真正的 emit 在 worker）
def on_progress(cb) -> None:
    worker.on_progress(cb)

"""存储扫描：把某个存储设备根目录下的视频「登记引用」入库（不搬动文件）。

模块拆分后一分为二（进程内接缝，Phase 2 起跨 HTTP）：
  - **连接器职责** `walk_root()`：walk 一个存储根找出候选视频文件，
    只返回 {rel_path,size,mtime}，不碰 DB、不跑 ffprobe。
  - **调度中心职责** `apply_scan_report()`：把候选文件登记入 media 表
    （has_file=1, duration=0, poster=NULL, mime 按扩展名猜），并为每个新素材
    派 probe + thumbnail 作业（时长/海报由处理器 worker 异步回填）。

`scan_storage()` 在单机下把两半串起来并唤醒本机 worker。
要点：
  - 登记引用：file_path 存相对路径，真实文件留在原地，不复制、不占额外空间。
  - 幂等：以 (storage_id, file_path) 去重，重扫已存在的文件跳过，只补新文件。
  - 后台线程执行，靠 revision 轮询让面板看到结果。
"""
from __future__ import annotations

import os
import threading
import time
import uuid

import db
import jobs

_VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"}

_MIME_BY_EXT = {
    ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
    ".mkv": "video/x-matroska", ".webm": "video/webm", ".avi": "video/x-msvideo",
}

_scan_lock = threading.Lock()
_scanning: set[str] = set()  # 正在扫描的 storage_id


def is_scanning(storage_id: str) -> bool:
    return storage_id in _scanning


def _now() -> int:
    return int(time.time() * 1000)


def guess_mime(name: str) -> str:
    return _MIME_BY_EXT.get(os.path.splitext(name)[1].lower(), "video/mp4")


def _existing_paths(conn, storage_id: str) -> set[str]:
    return {
        r["file_path"]
        for r in conn.execute(
            "SELECT file_path FROM media WHERE storage_id=?", (storage_id,)
        )
    }


# ------------------------------------------------------------
# 连接器职责：walk 一个根，产出候选文件（不碰 DB / ffprobe）
# ------------------------------------------------------------

def walk_root(root: str) -> list[dict]:
    """walk 一个存储根，返回候选视频文件 [{rel_path, size, mtime}]。"""
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
            items.append({"rel_path": rel, "size": size, "mtime": mtime})
    return items


# ------------------------------------------------------------
# 调度中心职责：登记候选文件并派 probe+thumbnail 作业
# ------------------------------------------------------------

def apply_scan_report(storage_id: str, items: list[dict], node_id: str | None = None) -> dict:
    """把连接器上报的候选文件登记入库，为每个新素材派 probe+thumbnail 作业。

    幂等：已登记的 file_path 跳过。返回 {added, skipped, new_media_ids}。
    """
    conn = db.get_conn()
    seen = _existing_paths(conn, storage_id)
    now = _now()
    added = 0
    skipped = 0
    new_ids: list[str] = []
    for it in items:
        rel = it["rel_path"]
        if rel in seen:
            skipped += 1
            continue
        mid = uuid.uuid4().hex[:12]
        name = os.path.splitext(os.path.basename(rel))[0]
        sub = os.path.dirname(rel)
        folder = sub if sub not in (".", "") else ""
        conn.execute(
            """INSERT INTO media
            (id,name,kind,duration,size,mime,poster_path,rating,year,synopsis,
             folder,has_file,file_path,storage_id,created_at,updated_at)
            VALUES (?,?,'source',0,?,?,NULL,0,NULL,NULL,?,1,?,?,?,?)""",
            (mid, name, it.get("size", 0), guess_mime(rel),
             folder, rel, storage_id, now, now),
        )
        seen.add(rel)
        new_ids.append(mid)
        added += 1
    if added:
        rev = db.bump_revision()
        conn.executemany(
            "UPDATE media SET updated_rev=? WHERE id=?", [(rev, mid) for mid in new_ids]
        )
        conn.commit()
        for mid in new_ids:
            jobs.enqueue("probe", media_id=mid, node_id=node_id)
            jobs.enqueue("thumbnail", media_id=mid, node_id=node_id)
    else:
        conn.commit()
    return {"added": added, "skipped": skipped, "new_media_ids": new_ids}


# ------------------------------------------------------------
# 单机编排：walk + apply + 唤醒 worker
# ------------------------------------------------------------

def scan_storage(storage_id: str) -> dict:
    """扫描一个存储根，登记新视频并派作业。返回 {added, skipped, total}。同步执行。"""
    import worker
    conn = db.get_conn()
    st = conn.execute("SELECT * FROM storages WHERE id=?", (storage_id,)).fetchone()
    if not st:
        return {"added": 0, "skipped": 0, "total": 0, "error": "storage_missing"}
    root = st["root_path"]
    node_id = st["node_id"] if "node_id" in st.keys() else None
    import nodes
    if node_id and node_id != nodes.LOOPBACK_ID:
        # 远程连接器存储：根目录在连接器机器上，调度中心不直接触达。
        # 写入待重扫标记，下次该连接器心跳时捎带 rescanStorageIds 下发，
        # 由连接器自己 walk 并经 scan-report 上报。不改 online（由节点心跳决定）。
        conn.execute(
            "INSERT OR REPLACE INTO pending_rescans(storage_id,node_id,created_at) VALUES(?,?,?)",
            (storage_id, node_id, _now()),
        )
        conn.commit()
        return {"added": 0, "skipped": 0, "total": 0, "remote": True, "scheduled": True,
                "note": "remote rescan scheduled; connector scans on next heartbeat"}
    if not os.path.isdir(root):
        # 目录不可达 → 标记该存储离线，不动已登记的行
        conn.execute("UPDATE storages SET online=0 WHERE id=?", (storage_id,))
        conn.commit()
        return {"added": 0, "skipped": 0, "total": 0, "error": "root_unreachable"}

    items = walk_root(root)
    result = apply_scan_report(storage_id, items, node_id=node_id)
    conn.execute("UPDATE storages SET online=1 WHERE id=?", (storage_id,))
    conn.commit()
    if result["added"]:
        worker.wake()
    added, skipped = result["added"], result["skipped"]
    return {"added": added, "skipped": skipped, "total": added + skipped}


def scan_async(storage_id: str) -> None:
    """后台线程扫描，避免阻塞请求（大目录可能很慢）。"""
    with _scan_lock:
        if storage_id in _scanning:
            return
        _scanning.add(storage_id)

    def _run():
        try:
            scan_storage(storage_id)
        finally:
            _scanning.discard(storage_id)

    threading.Thread(target=_run, daemon=True).start()

"""节点注册表 + 模块鉴权（模块拆分接缝）。

只有调度中心拥有 DB；本模块是唯一维护 `nodes` 表的地方。

三种凭证里的两种在这里：
  - **enrollment token**（见 auth.enroll_token）—— 连接器/处理器凭它 enroll。
  - **每节点 node token** —— enroll 下发一次，只存 sha256 哈希；后续 HTTP 调用带
    `Authorization: Bearer <nodeToken>` + `X-Node-Id`，由 require_node_auth 校验。
  - 第三种（签流 ticket 的 stream_key）在 tickets.py，key 在 enroll 时下发并入库。

Phase 1/monolith：一个自动登记的 loopback 节点，代表本机（连接器 + 本地处理器）。
"""
from __future__ import annotations

import functools
import hashlib
import json
import secrets
import time

from flask import g, jsonify, request

import db
import config

LOOPBACK_ID = "loopback"

# 心跳间隔 20s，3 个周期没心跳即视为离线（读时判定，因 mark_offline_stale 不定时调用）
STALE_MS = 60_000


def _now() -> int:
    return int(time.time() * 1000)


def _is_fresh(row) -> bool:
    """节点是否新鲜在线：loopback 恒在线；其余需 online=1 且 last_seen 在阈值内。"""
    if row["id"] == LOOPBACK_ID:
        return True
    if not row["online"]:
        return False
    ls = row["last_seen"]
    return ls is not None and ls > _now() - STALE_MS


def _sha256(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def get_node(node_id: str):
    return db.get_conn().execute("SELECT * FROM nodes WHERE id=?", (node_id,)).fetchone()


def node_stream_key(node_id: str) -> str | None:
    row = get_node(node_id)
    return row["stream_key"] if row else None


# ------------------------------------------------------------
# loopback（单机）
# ------------------------------------------------------------

def _loopback_has_ffmpeg() -> bool:
    """本机是否真的能处理视频：仅 monolith 模式内嵌 worker 线程消化 ffmpeg 作业；
    coordinator 模式下本机是纯元数据中枢，不跑 ffmpeg——此时不能冒称视频处理器。"""
    return config.VM_MODE == "monolith"


def ensure_loopback() -> str:
    """确保本机 loopback 节点存在（幂等）。返回其 id。

    loopback 也有 stream_key（签流 ticket 统一走验签路径，含单机 /files/stream）。
    token_hash 留空——loopback 不作为远程节点鉴权。
    capabilities.hasFfmpeg 按运行模式如实反映（见 _loopback_has_ffmpeg），
    模式变更后同步纠正历史行，避免设置页出现名不副实的「视频处理器」。
    """
    conn = db.get_conn()
    row = get_node(LOOPBACK_ID)
    caps = json.dumps({"hasFfmpeg": _loopback_has_ffmpeg()})
    if row is None:
        now = _now()
        conn.execute(
            "INSERT INTO nodes"
            "(id,kind,name,base_url,token_hash,stream_key,capabilities,online,last_seen,enrolled_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,?)",
            (LOOPBACK_ID, "connector", "本机", None, None, secrets.token_urlsafe(24),
             caps, 1, now, now),
        )
        conn.commit()
    else:
        updates, params = [], []
        if not row["stream_key"]:
            updates.append("stream_key=?")
            params.append(secrets.token_urlsafe(24))
        if row["capabilities"] != caps:
            updates.append("capabilities=?")
            params.append(caps)
        if updates:
            params.append(LOOPBACK_ID)
            conn.execute(f"UPDATE nodes SET {', '.join(updates)} WHERE id=?", params)
            conn.commit()
    return LOOPBACK_ID


def is_loopback(node_row) -> bool:
    return node_row is None or node_row["id"] == LOOPBACK_ID


def is_online(node_id: str | None) -> bool:
    """按新鲜度判定某节点是否在线（供 store 定位远程存储在线态）。"""
    if not node_id or node_id == LOOPBACK_ID:
        return True
    row = get_node(node_id)
    return bool(row) and _is_fresh(row)


def list_nodes_camel() -> list[dict]:
    """给面板设置页用：当前接入的设备（含 loopback 本机），带角色/在线态/下挂存储。

    只暴露安全列（排除 token_hash / stream_key）；online 按新鲜度实时计算。
    roots = 该节点下挂的存储 [{id,name}]（loopback 的本机存储也一并列出）。
    """
    conn = db.get_conn()
    out: list[dict] = []
    for row in conn.execute("SELECT * FROM nodes ORDER BY enrolled_at"):
        nid = row["id"]
        try:
            caps = json.loads(row["capabilities"] or "{}")
        except Exception:
            caps = {}
        # loopback 的本机存储 node_id 为 NULL（历史约定），需一并归到本机名下
        if nid == LOOPBACK_ID:
            root_rows = conn.execute(
                "SELECT id,name FROM storages WHERE node_id IS NULL OR node_id=? ORDER BY added_at",
                (nid,),
            )
        else:
            root_rows = conn.execute(
                "SELECT id,name FROM storages WHERE node_id=? ORDER BY added_at", (nid,)
            )
        roots = [{"id": r["id"], "name": r["name"]} for r in root_rows]
        out.append({
            "id": nid,
            "kind": row["kind"],
            "name": row["name"],
            "online": _is_fresh(row),
            "baseUrl": row["base_url"],
            "lastSeen": row["last_seen"],
            "capabilities": {"hasFfmpeg": bool(caps.get("hasFfmpeg"))},
            "roots": roots,
            "enrolledAt": row["enrolled_at"],
            "isCoordinator": nid == LOOPBACK_ID,
        })
    return out


# ------------------------------------------------------------
# enroll / heartbeat（远程连接器 / 处理器）
# ------------------------------------------------------------

def enroll(kind: str, name: str, base_url: str | None,
           capabilities: dict, roots: list[str]) -> dict:
    """连接器/处理器上线注册。生成 node token + stream_key（只存哈希），
    为连接器的每个根登记一个节点自有 storage。返回 EnrollResponse(+storageIds)。
    """
    import store
    conn = db.get_conn()
    nid = secrets.token_hex(6)
    node_token = secrets.token_urlsafe(24)
    stream_key = secrets.token_urlsafe(24)
    now = _now()
    conn.execute(
        "INSERT INTO nodes"
        "(id,kind,name,base_url,token_hash,stream_key,capabilities,online,last_seen,enrolled_at)"
        " VALUES(?,?,?,?,?,?,?,?,?,?)",
        (nid, kind, name or kind, base_url, _sha256(node_token), stream_key,
         json.dumps(capabilities or {}), 1, now, now),
    )
    conn.commit()
    storage_ids: list[str] = []
    if kind == "connector":
        for root in roots or []:
            storage_ids.append(store.ensure_node_storage(nid, root))
    return {
        "node_id": nid,
        "node_token": node_token,
        "stream_key": stream_key,
        "revision": db.current_revision(),
        "storage_ids": storage_ids,
    }


def heartbeat(node_id: str, online: bool = True,
              roots: list[str] | None = None, capabilities: dict | None = None) -> dict | None:
    """标记 online、更新 last_seen；连接器可带 roots 补登记新根。"""
    import jobs
    import store
    conn = db.get_conn()
    row = get_node(node_id)
    if row is None:
        return None
    sets = ["online=?", "last_seen=?"]
    vals: list = [1 if online else 0, _now()]
    if capabilities is not None:
        sets.append("capabilities=?"); vals.append(json.dumps(capabilities))
    vals.append(node_id)
    conn.execute(f"UPDATE nodes SET {', '.join(sets)} WHERE id=?", vals)
    conn.commit()
    # 连接器上报的 roots（如 env 里新增的根）先补登记，保证它们进 DB。
    # 有删除墓碑的根不补登记（防"复活"），并经 removedRoots 告知连接器本地也移除。
    removed_roots: list[str] = []
    if row["kind"] == "connector" and roots:
        for root in roots:
            if store.is_root_deleted(node_id, root):
                removed_roots.append(root)
            else:
                store.ensure_node_storage(node_id, root)
    # 取出该连接器的待重扫标记并消费掉（at-most-once），随心跳捎带下发，
    # 连接器据此对对应根重新 walk + scan-report（面板上"重新扫描"远程目录的通道）。
    rescan_storage_ids: list[str] = []
    if row["kind"] == "connector":
        rows = conn.execute(
            "SELECT storage_id FROM pending_rescans WHERE node_id=?", (node_id,)
        ).fetchall()
        rescan_storage_ids = [r["storage_id"] for r in rows]
        if rescan_storage_ids:
            conn.executemany(
                "DELETE FROM pending_rescans WHERE storage_id=?",
                [(sid,) for sid in rescan_storage_ids],
            )
            conn.commit()
    # 回传该连接器在调度中心 DB 里的全量权威存储映射（root_path→storageId）。
    # 用途一：storage id 因重建/迁移变化时，连接器据此纠正本地缓存，避免 scan-report 404。
    # 用途二：手机新加的远程 root 也在这里下发，连接器采纳后自行 walk + 上报（无需给
    #        连接器开「调度中心→连接器」的鉴权推送接口）。故用 DB 全量，而非仅请求带来的 roots。
    storages: list[dict] = []
    if row["kind"] == "connector":
        for r in conn.execute(
            "SELECT id,root_path FROM storages WHERE node_id=?", (node_id,)
        ):
            storages.append({"root": r["root_path"], "storage_id": r["id"]})
    # 处理器据此决定是否 claim
    caps = {}
    try:
        caps = json.loads(row["capabilities"] or "{}")
    except Exception:
        caps = {}
    kinds = ["probe", "thumbnail", "clip"] if caps.get("hasFfmpeg") else []
    return {"revision": db.current_revision(),
            "storages": storages,
            "removed_roots": removed_roots,
            "rescan_storage_ids": rescan_storage_ids,
            "pending_job_hint": jobs.pending_count(kinds) if kinds else 0}


def mark_offline_stale(max_age_ms: int) -> None:
    """把太久没心跳的节点标记离线（供后台巡检；Phase 2 暂不定时调用）。"""
    conn = db.get_conn()
    cutoff = _now() - max_age_ms
    conn.execute(
        "UPDATE nodes SET online=0 WHERE id!=? AND online=1 AND (last_seen IS NULL OR last_seen<?)",
        (LOOPBACK_ID, cutoff),
    )
    conn.commit()


# ------------------------------------------------------------
# 节点鉴权装饰器
# ------------------------------------------------------------

def _node_authorized():
    node_id = request.headers.get("X-Node-Id", "")
    auth = request.headers.get("Authorization", "")
    if not node_id or not auth.startswith("Bearer "):
        return None
    row = get_node(node_id)
    if not row or not row["token_hash"]:
        return None
    if secrets.compare_digest(_sha256(auth[7:]), row["token_hash"]):
        return row
    return None


def require_node_auth(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        node = _node_authorized()
        if node is None:
            return jsonify({"ok": False, "error": {"code": "node_unauthorized",
                                                    "message": "节点未授权"}}), 401
        g.node = node
        return fn(*args, **kwargs)
    return wrapper

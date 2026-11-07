"""读路径查询层：把规范化的关系表拼回 shared 契约的对象，并转 camelCase。

只读部分（阶段1）：list_media / list_marks / list_actors / snapshot / delta。
写路径（阶段3）另建函数，统一在这里维护 SQL。
"""
from __future__ import annotations

import os
import ntpath
from typing import Any, Optional

import config
import db
from contract import keys_to_camel


# ------------------------------------------------------------
# 组装：单行 media Row -> snake_case dict（含 tags/cast 聚合）
# ------------------------------------------------------------

def _media_row_to_dict(row) -> dict:
    conn = db.get_conn()
    mid = row["id"]
    tags = [
        r["tag"]
        for r in conn.execute(
            "SELECT tag FROM media_tags WHERE media_id=? ORDER BY tag", (mid,)
        )
    ]
    cast = [
        r["actor_name"]
        for r in conn.execute(
            "SELECT actor_name FROM media_cast WHERE media_id=? ORDER BY ord", (mid,)
        )
    ]
    d: dict[str, Any] = {
        "id": row["id"],
        "name": row["name"],
        "kind": row["kind"],
        "duration": row["duration"],
        "size": row["size"],
        "mime": row["mime"],
        "poster_path": row["poster_path"],
        "rating": row["rating"],
        "tags": tags,
        "cast": cast,
        "year": row["year"],
        "synopsis": row["synopsis"],
        "folder": row["folder"],
        "has_file": bool(row["has_file"]),
        "file_path": row["file_path"],
        "storage_id": row["storage_id"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }
    st = get_storage_row(row["storage_id"]) if row["storage_id"] else None
    file_path = row["file_path"]
    if file_path:
        root = st["root_path"] if st else config.DATA_DIR
        path_module = ntpath if "\\" in root or (len(root) > 1 and root[1] == ":") else os.path
        d["original_path"] = path_module.normpath(path_module.join(root, file_path))
    else:
        d["original_path"] = row["folder"] or None
    d["source_kind"] = "remote" if st and st["node_id"] and st["node_id"] != "loopback" else (st["kind"] if st else ("local" if row["has_file"] else "cloud"))
    d["storage_name"] = st["name"] if st else None
    # 片段专用字段：仅当是 clip 时带上，避免噪音
    if row["kind"] == "clip":
        d.update(
            parent_id=row["parent_id"],
            parent_name=row["parent_name"],
            range_start=row["range_start"],
            range_end=row["range_end"],
            clip_status=row["clip_status"],
        )
    return d


def _mark_row_to_dict(row) -> dict:
    return {
        "id": row["id"],
        "media_id": row["media_id"],
        "time": row["time"],
        "label": row["label"],
        "color": row["color"],
        "note": row["note"],
        "created_at": row["created_at"],
    }


def _actor_row_to_dict(row) -> dict:
    conn = db.get_conn()
    tags = [
        r["tag"]
        for r in conn.execute(
            "SELECT tag FROM actor_tags WHERE actor_name=? ORDER BY tag", (row["name"],)
        )
    ]
    d: dict[str, Any] = {
        "name": row["name"],
        "tags": tags,
        "bio": row["bio"],
        "photo_path": row["photo_path"],
        "updated_at": row["updated_at"],
    }
    # 三维评分：三项齐备才带 ratings 对象
    if row["rating_figure"] is not None:
        d["ratings"] = {
            "figure": row["rating_figure"],
            "looks": row["rating_looks"],
            "acting": row["rating_acting"],
        }
    return d


# ------------------------------------------------------------
# 读查询（snake_case dict 列表）
# ------------------------------------------------------------

def list_media() -> list[dict]:
    rows = db.get_conn().execute("SELECT * FROM media ORDER BY created_at DESC")
    return [_media_row_to_dict(r) for r in rows]


def get_media(media_id: str) -> Optional[dict]:
    """单条素材，camelCase（供写路径 API 返回）。"""
    row = db.get_conn().execute("SELECT * FROM media WHERE id=?", (media_id,)).fetchone()
    return keys_to_camel(_media_row_to_dict(row)) if row else None


def get_media_row(media_id: str):
    return db.get_conn().execute("SELECT * FROM media WHERE id=?", (media_id,)).fetchone()


def list_marks() -> list[dict]:
    rows = db.get_conn().execute("SELECT * FROM marks ORDER BY media_id, time")
    return [_mark_row_to_dict(r) for r in rows]


def list_actors() -> list[dict]:
    rows = db.get_conn().execute("SELECT * FROM actors ORDER BY name")
    return [_actor_row_to_dict(r) for r in rows]


def _storage_row_to_dict(row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "kind": row["kind"],
        "root_path": row["root_path"],
        "online": bool(row["online"]),
        "node_id": row["node_id"] if "node_id" in row.keys() else None,
        "added_at": row["added_at"],
    }


def list_storages() -> list[dict]:
    rows = db.get_conn().execute("SELECT * FROM storages ORDER BY added_at")
    return [_storage_row_to_dict(r) for r in rows]


def list_storages_camel() -> list[dict]:
    """给面板用：camelCase，并附带每个存储当前是否正在扫描。

    远程连接器存储的 online 改用属主节点新鲜度判定——调度中心对远程根做 isdir
    恒为假，直接用 storages.online 会误显示离线。本机(loopback/无节点)存储沿用自身 online。
    """
    import nodes
    import scanner
    out = []
    for d in list_storages():
        d = dict(d)
        node_id = d.get("node_id")
        if node_id and node_id != nodes.LOOPBACK_ID:
            d["online"] = nodes.is_online(node_id)
        d["scanning"] = scanner.is_scanning(d["id"])
        out.append(keys_to_camel(d))
    return out


def get_storage_row(storage_id: str):
    return db.get_conn().execute("SELECT * FROM storages WHERE id=?", (storage_id,)).fetchone()


def get_storage_camel(storage_id: str) -> Optional[dict]:
    """单条存储，camelCase（供写路径 API 返回）。"""
    row = get_storage_row(storage_id)
    return keys_to_camel(_storage_row_to_dict(row)) if row else None


def add_storage(name: str, kind: str, root_path: str) -> dict:
    """注册一个存储设备（登记引用）。返回 camelCase dict。"""
    import time
    import uuid
    conn = db.get_conn()
    sid = uuid.uuid4().hex[:12]
    now = int(time.time() * 1000)
    online = 1 if os.path.isdir(root_path) else 0
    conn.execute(
        "INSERT INTO storages (id,name,kind,root_path,online,added_at) VALUES (?,?,?,?,?,?)",
        (sid, name, kind, root_path, online, now),
    )
    conn.commit()
    row = get_storage_row(sid)
    return keys_to_camel(_storage_row_to_dict(row))


def ensure_node_storage(node_id: str, root_path: str, name: str | None = None) -> str | None:
    """为连接器节点的一个根登记 storage（幂等，按 (node_id, root_path) 去重）。返回 storage id。

    这是节点自有存储：root_path 是**连接器机器上**的绝对路径，调度中心不直接触达，
    只作登记引用；串流经 ticket 转由该连接器 /files/stream 服务。
    有删除墓碑（面板已删）时跳过补登记并返回 None，防止删除后被心跳"复活"。
    """
    import time
    import uuid
    conn = db.get_conn()
    existing = conn.execute(
        "SELECT id FROM storages WHERE node_id=? AND root_path=?", (node_id, root_path)
    ).fetchone()
    if existing:
        return existing["id"]
    if is_root_deleted(node_id, root_path):
        return None
    sid = uuid.uuid4().hex[:12]
    now = int(time.time() * 1000)
    nm = name or (os.path.basename(root_path.rstrip("/\\")) or root_path)
    conn.execute(
        "INSERT INTO storages (id,name,kind,root_path,online,node_id,added_at) VALUES (?,?,?,?,?,?,?)",
        (sid, nm, "remote", root_path, 1, node_id, now),
    )
    conn.commit()
    return sid


def is_root_deleted(node_id: str, root_path: str) -> bool:
    """该远程根是否有删除墓碑（面板删除后心跳不再补登记）。"""
    row = db.get_conn().execute(
        "SELECT 1 FROM deleted_roots WHERE node_id=? AND root_path=?",
        (node_id, root_path),
    ).fetchone()
    return row is not None


def clear_deleted_root(node_id: str, root_path: str) -> None:
    """显式重新添加远程根时清除墓碑（之后心跳可正常补登记）。"""
    conn = db.get_conn()
    conn.execute(
        "DELETE FROM deleted_roots WHERE node_id=? AND root_path=?", (node_id, root_path)
    )
    conn.commit()


def delete_storage(storage_id: str) -> bool:
    """删除存储登记。仅解除引用，不删磁盘文件；同时清掉该存储下登记的 source 素材行。

    删除前为每条素材写 tombstone（revision>since），面板增量同步据此下发删除；
    同时删除这些素材的 jobs（queued/claimed/running/历史），防止处理器领到无源任务空转。
    远程连接器存储额外写 deleted_roots 墓碑：连接器本地仍持有该根、下次心跳还会上报，
    墓碑让心跳补登记跳过它并回传 removedRoots，防止目录"复活"。
    """
    import time
    conn = db.get_conn()
    st = get_storage_row(storage_id)
    if not st:
        return False
    doomed = [
        r["id"] for r in conn.execute("SELECT id FROM media WHERE storage_id=?", (storage_id,))
    ]
    rev = db.bump_revision()
    for mid in doomed:
        conn.execute("DELETE FROM marks WHERE media_id=?", (mid,))
        conn.execute("DELETE FROM media_tags WHERE media_id=?", (mid,))
        conn.execute("DELETE FROM media_cast WHERE media_id=?", (mid,))
        # 顺带清掉该素材的待处理/历史作业，避免处理器之后领到必然 no_source 失败的任务
        conn.execute("DELETE FROM jobs WHERE media_id=?", (mid,))
        conn.execute(
            "INSERT OR REPLACE INTO tombstones(entity,ref,revision) VALUES('media',?,?)",
            (mid, rev),
        )
    conn.execute("DELETE FROM media WHERE storage_id=?", (storage_id,))
    conn.execute("DELETE FROM storages WHERE id=?", (storage_id,))
    node_id = st["node_id"] if "node_id" in st.keys() else None
    if node_id:
        import nodes
        if node_id != nodes.LOOPBACK_ID:
            conn.execute(
                "INSERT OR REPLACE INTO deleted_roots(node_id,root_path,deleted_at) VALUES(?,?,?)",
                (node_id, st["root_path"], int(time.time() * 1000)),
            )
    conn.commit()
    return True


def resolve_media_file(row) -> tuple[str | None, str | None]:
    """把 media 行解析成磁盘绝对路径。

    返回 (abs_path, error_code)：
      - 无 file_path → (None, "no_file")
      - 有 storage_id：查存储；离线 → (None, "storage_offline")；路径越权 → (None, "bad_path")
      - 无 storage_id：走内建 data/ 受控目录（resolve_asset）
      - 文件不在磁盘 → (None, "file_missing")
    成功 → (abs_path, None)。
    """
    file_path = row["file_path"]
    if not row["has_file"] or not file_path:
        return None, "no_file"
    storage_id = row["storage_id"] if "storage_id" in row.keys() else None
    if storage_id:
        st = get_storage_row(storage_id)
        if not st:
            return None, "storage_missing"
        if not st["online"]:
            return None, "storage_offline"
        abs_path = config.resolve_within_root(st["root_path"], file_path)
    else:
        abs_path = config.resolve_asset(file_path)
    if not abs_path:
        return None, "bad_path"
    if not os.path.isfile(abs_path):
        return None, "file_missing"
    return abs_path, None


def locate_media(row) -> tuple[Any, Optional[str], Optional[str]]:
    """路由定位（不碰磁盘）：判断素材源在哪个节点、相对路径是什么。

    返回 (node_row_or_None, rel_path, error)：
      - 无 file_path → (None, None, "no_file")
      - storage_id 指向外部存储：查存储；缺失→"storage_missing"；离线→"storage_offline"；
        属主是远程连接器且离线→"node_offline"；否则 (node_row|None, file_path, None)。
        node_row=None 表示 loopback（本机磁盘），调用方走本地 send_file 捷径。
      - storage_id 为空（内建 data/ 资产）→ (None, file_path, None)，loopback 本地服务。
    rel_path 语义：外部存储=相对存储根的子路径；内建=形如 "videos/x.mp4"。
    """
    import nodes
    file_path = row["file_path"]
    if not row["has_file"] or not file_path:
        return None, None, "no_file"
    storage_id = row["storage_id"] if "storage_id" in row.keys() else None
    if not storage_id:
        return None, file_path, None  # 内建 data/ 资产 = loopback
    st = get_storage_row(storage_id)
    if not st:
        return None, None, "storage_missing"
    node_id = st["node_id"] if "node_id" in st.keys() else None
    if not node_id or node_id == nodes.LOOPBACK_ID:
        # loopback / 本机磁盘：storage.online 由协调中心本地 isdir 决定，有意义
        if not st["online"]:
            return None, None, "storage_offline"
        return None, file_path, None
    # 远程连接器存储：可用性取决于连接器节点是否在线。
    # storage.online 是协调中心对远程路径做 os.path.isdir 的结果（恒为假），不作数。
    node = nodes.get_node(node_id)
    if not node:
        return None, None, "node_missing"
    if not node["online"]:
        return None, None, "node_offline"
    return node, file_path, None


# ------------------------------------------------------------
# 快照 / 增量（camelCase，直接进 JSON）
# ------------------------------------------------------------

def snapshot() -> dict:
    """GET /api/library 全量快照。"""
    return keys_to_camel(
        {
            "media": list_media(),
            "marks": list_marks(),
            "actors": list_actors(),
            "storages": list_storages(),
            "revision": db.current_revision(),
        }
    )


def delta(since: int) -> dict:
    """GET /api/library/delta?since= 增量。

    upsert = updated_rev > since 的行；delete = tombstones 里 revision>since 的。
    （updated_rev 与 revision 同源逻辑时钟，语义统一；早期未打点的行 updated_rev=0，
      仅经全量快照下发，不会在 delta 里反复重传。）
    """
    conn = db.get_conn()
    upsert_media = [
        _media_row_to_dict(r)
        for r in conn.execute("SELECT * FROM media WHERE updated_rev > ?", (since,))
    ]
    upsert_actors = [
        _actor_row_to_dict(r)
        for r in conn.execute("SELECT * FROM actors WHERE updated_rev > ?", (since,))
    ]
    upsert_marks = [
        _mark_row_to_dict(r)
        for r in conn.execute("SELECT * FROM marks WHERE updated_rev > ?", (since,))
    ]
    del_media, del_actors, del_marks = [], [], []
    for r in conn.execute("SELECT entity, ref FROM tombstones WHERE revision > ?", (since,)):
        if r["entity"] == "media":
            del_media.append(r["ref"])
        elif r["entity"] == "actor":
            del_actors.append(r["ref"])
        elif r["entity"] == "mark":
            del_marks.append(r["ref"])
    return keys_to_camel(
        {
            "upsert_media": upsert_media,
            "delete_media_ids": del_media,
            "upsert_marks": upsert_marks,
            "delete_mark_ids": del_marks,
            "upsert_actors": upsert_actors,
            "delete_actor_names": del_actors,
            "revision": db.current_revision(),
        }
    )

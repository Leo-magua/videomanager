"""写路径：所有会改元数据的操作，集中在这里维护 SQL 与业务规则。

每个写操作：改表 → bump_revision() → commit，返回受影响的实体（camelCase）。
核心业务规则：**演员⇄标签互通**（见 docs/后端数据结构.md 第 4 节）。

阶段3：这些函数既服务于在线写 REST，也服务于 Outbox 回放。
"""
from __future__ import annotations

import time
import uuid
from typing import Optional

import db
import store
from contract import keys_to_camel

_MARK_COLORS = ["#f43f5e", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#ec4899"]


def _now() -> int:
    return int(time.time() * 1000)


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


def _touch(conn, media_id: str, ts: int, rev: int) -> None:
    conn.execute(
        "UPDATE media SET updated_at=?, updated_rev=? WHERE id=?", (ts, rev, media_id)
    )


# ------------------------------------------------------------
# 标签词表
# ------------------------------------------------------------

def _ensure_tags(conn, tags: list[str]) -> None:
    for t in tags:
        conn.execute("INSERT OR IGNORE INTO tags(name) VALUES(?)", (t,))


# ------------------------------------------------------------
# media 字段写
# ------------------------------------------------------------

def rename_media(media_id: str, name: str) -> Optional[dict]:
    conn = db.get_conn()
    if not store.get_media_row(media_id):
        return None
    ts = _now()
    rev = db.bump_revision()
    conn.execute(
        "UPDATE media SET name=?, updated_at=?, updated_rev=? WHERE id=?",
        (name, ts, rev, media_id),
    )
    # 片段 parentName 跟随母素材改名
    conn.execute(
        "UPDATE media SET parent_name=?, updated_at=?, updated_rev=? WHERE parent_id=?",
        (name, ts, rev, media_id),
    )
    conn.commit()
    return store.get_media(media_id)


def set_rating(media_id: str, rating: float) -> Optional[dict]:
    conn = db.get_conn()
    if not store.get_media_row(media_id):
        return None
    rev = db.bump_revision()
    # 0–10 分，保留 0.5/0.1 精度（前端 RatingBar 以 0.5 步进打点、手动输入 1 位小数）
    val = round(max(0.0, min(10.0, float(rating))), 1)
    conn.execute(
        "UPDATE media SET rating=?, updated_at=?, updated_rev=? WHERE id=?",
        (val, _now(), rev, media_id),
    )
    conn.commit()
    return store.get_media(media_id)


def set_tags(media_id: str, tags: list[str]) -> Optional[dict]:
    """覆盖式设置素材标签，并把「新增的标签」写回该素材所有演员（互通）。"""
    conn = db.get_conn()
    row = store.get_media_row(media_id)
    if not row:
        return None
    ts = _now()
    rev = db.bump_revision()
    old = {
        r["tag"]
        for r in conn.execute("SELECT tag FROM media_tags WHERE media_id=?", (media_id,))
    }
    new = list(dict.fromkeys(tags))  # 去重保序
    added = [t for t in new if t not in old]

    _ensure_tags(conn, new)
    conn.execute("DELETE FROM media_tags WHERE media_id=?", (media_id,))
    for t in new:
        conn.execute(
            "INSERT OR IGNORE INTO media_tags(media_id,tag) VALUES(?,?)", (media_id, t)
        )
    _touch(conn, media_id, ts, rev)

    # 互通：新增标签写回该素材所有演员目录
    if added:
        cast = [
            r["actor_name"]
            for r in conn.execute(
                "SELECT actor_name FROM media_cast WHERE media_id=?", (media_id,)
            )
        ]
        for actor in cast:
            for t in added:
                conn.execute(
                    "INSERT OR IGNORE INTO actor_tags(actor_name,tag) VALUES(?,?)",
                    (actor, t),
                )
            conn.execute(
                "UPDATE actors SET updated_at=?, updated_rev=? WHERE name=?",
                (ts, rev, actor),
            )
    conn.commit()
    return store.get_media(media_id)


def set_cast(media_id: str, cast: list[str]) -> Optional[dict]:
    """覆盖式设置演员表。新加入的演员，其目录里已有标签自动并入本素材（互通）。"""
    conn = db.get_conn()
    row = store.get_media_row(media_id)
    if not row:
        return None
    ts = _now()
    rev = db.bump_revision()
    old = {
        r["actor_name"]
        for r in conn.execute("SELECT actor_name FROM media_cast WHERE media_id=?", (media_id,))
    }
    new = list(dict.fromkeys(cast))
    added = [a for a in new if a not in old]

    conn.execute("DELETE FROM media_cast WHERE media_id=?", (media_id,))
    for ord_, a in enumerate(new):
        # 演员目录里没有则建空条目（仅新建行会被 stamp updated_rev）
        conn.execute(
            "INSERT OR IGNORE INTO actors(name,updated_at,updated_rev) VALUES(?,?,?)",
            (a, ts, rev),
        )
        conn.execute(
            "INSERT OR IGNORE INTO media_cast(media_id,actor_name,ord) VALUES(?,?,?)",
            (media_id, a, ord_),
        )
    # 互通：新加入演员携带的标签并入素材
    for a in added:
        carry = [
            r["tag"] for r in conn.execute("SELECT tag FROM actor_tags WHERE actor_name=?", (a,))
        ]
        _ensure_tags(conn, carry)
        for t in carry:
            conn.execute(
                "INSERT OR IGNORE INTO media_tags(media_id,tag) VALUES(?,?)", (media_id, t)
            )
    _touch(conn, media_id, ts, rev)
    conn.commit()
    return store.get_media(media_id)


# ------------------------------------------------------------
# marks
# ------------------------------------------------------------

def add_mark(media_id: str, time_sec: float, label: Optional[str], note: Optional[str],
             mark_id: Optional[str] = None) -> Optional[dict]:
    conn = db.get_conn()
    if not store.get_media_row(media_id):
        return None
    count = conn.execute(
        "SELECT COUNT(*) c FROM marks WHERE media_id=?", (media_id,)
    ).fetchone()["c"]
    mk_id = mark_id or _new_id()
    color = _MARK_COLORS[count % len(_MARK_COLORS)]
    lbl = label or f"标记 {count + 1}"
    ts = _now()
    rev = db.bump_revision()
    conn.execute(
        "INSERT OR REPLACE INTO marks(id,media_id,time,label,color,note,created_at,updated_rev)"
        " VALUES(?,?,?,?,?,?,?,?)",
        (mk_id, media_id, max(0.0, float(time_sec)), lbl, color, note, ts, rev),
    )
    _touch(conn, media_id, ts, rev)
    conn.commit()
    row = conn.execute("SELECT * FROM marks WHERE id=?", (mk_id,)).fetchone()
    return keys_to_camel(store._mark_row_to_dict(row))


def update_mark(media_id: str, mark_id: str, patch: dict) -> Optional[dict]:
    conn = db.get_conn()
    row = conn.execute("SELECT * FROM marks WHERE id=? AND media_id=?", (mark_id, media_id)).fetchone()
    if not row:
        return None
    fields = {k: patch[k] for k in ("time", "label", "color", "note") if k in patch}
    ts = _now()
    rev = db.bump_revision()
    if fields:
        fields["updated_rev"] = rev
        sets = ", ".join(f"{k}=?" for k in fields)
        conn.execute(f"UPDATE marks SET {sets} WHERE id=?", (*fields.values(), mark_id))
    else:
        conn.execute("UPDATE marks SET updated_rev=? WHERE id=?", (rev, mark_id))
    _touch(conn, media_id, ts, rev)
    conn.commit()
    row = conn.execute("SELECT * FROM marks WHERE id=?", (mark_id,)).fetchone()
    return keys_to_camel(store._mark_row_to_dict(row))


def remove_mark(media_id: str, mark_id: str) -> bool:
    conn = db.get_conn()
    cur = conn.execute("DELETE FROM marks WHERE id=? AND media_id=?", (mark_id, media_id))
    if cur.rowcount:
        rev = db.bump_revision()
        conn.execute(
            "INSERT OR REPLACE INTO tombstones(entity,ref,revision) VALUES('mark',?,?)",
            (mark_id, rev),
        )
        _touch(conn, media_id, _now(), rev)
        conn.commit()
        return True
    conn.commit()
    return False


# ------------------------------------------------------------
# actor upsert
# ------------------------------------------------------------

def upsert_actor(actor: dict) -> Optional[dict]:
    """新增/更新演员目录条目（含三维评分与标签）。"""
    conn = db.get_conn()
    name = actor.get("name")
    if not name:
        return None
    ts = _now()
    rev = db.bump_revision()
    ratings = actor.get("ratings") or {}
    conn.execute(
        "INSERT INTO actors(name,photo_path,rating_figure,rating_looks,rating_acting,bio,updated_at,updated_rev)"
        " VALUES(?,?,?,?,?,?,?,?)"
        " ON CONFLICT(name) DO UPDATE SET"
        "  photo_path=COALESCE(excluded.photo_path, actors.photo_path),"
        "  rating_figure=excluded.rating_figure, rating_looks=excluded.rating_looks,"
        "  rating_acting=excluded.rating_acting,"
        "  bio=COALESCE(excluded.bio, actors.bio), updated_at=excluded.updated_at,"
        "  updated_rev=excluded.updated_rev",
        (name, actor.get("photoPath") or actor.get("photo_path"),
         ratings.get("figure"), ratings.get("looks"), ratings.get("acting"),
         actor.get("bio"), ts, rev),
    )
    tags = actor.get("tags")
    if tags is not None:
        _ensure_tags(conn, tags)
        conn.execute("DELETE FROM actor_tags WHERE actor_name=?", (name,))
        for t in dict.fromkeys(tags):
            conn.execute(
                "INSERT OR IGNORE INTO actor_tags(actor_name,tag) VALUES(?,?)", (name, t)
            )
    conn.commit()
    row = conn.execute("SELECT * FROM actors WHERE name=?", (name,)).fetchone()
    return keys_to_camel(store._actor_row_to_dict(row))


# ------------------------------------------------------------
# clip 创建（登记一条 pending 片段；真正切片在 clipper.py）
# ------------------------------------------------------------

def create_clip(parent_id: str, range_start: float, range_end: float, name: str,
                clip_id: Optional[str] = None) -> Optional[dict]:
    conn = db.get_conn()
    parent = store.get_media_row(parent_id)
    if not parent or range_end <= range_start:
        return None
    cid = clip_id or _new_id()
    ts = _now()
    rev = db.bump_revision()
    conn.execute(
        """INSERT OR REPLACE INTO media
        (id,name,kind,duration,size,mime,poster_path,rating,folder,has_file,file_path,
         parent_id,parent_name,range_start,range_end,clip_status,created_at,updated_at,updated_rev)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (cid, name, "clip", range_end - range_start, 0, parent["mime"] or "video/mp4",
         parent["poster_path"], 0, parent["folder"], 0, None,
         parent_id, parent["name"], range_start, range_end, "pending", ts, ts, rev),
    )
    # 继承母素材标签
    for r in conn.execute("SELECT tag FROM media_tags WHERE media_id=?", (parent_id,)):
        conn.execute(
            "INSERT OR IGNORE INTO media_tags(media_id,tag) VALUES(?,?)", (cid, r["tag"])
        )
    conn.commit()
    return store.get_media(cid)


# ------------------------------------------------------------
# 作业回填（处理器完成后落库）——探测 / 缩略图 / 剪辑
# ------------------------------------------------------------

def apply_probe(media_id: str, duration: float, mime: Optional[str] = None,
                size: Optional[int] = None) -> Optional[dict]:
    """probe 作业回填：写时长（可选 mime/size）。"""
    conn = db.get_conn()
    if not store.get_media_row(media_id):
        return None
    rev = db.bump_revision()
    sets = ["duration=?"]
    vals: list = [float(duration or 0)]
    if mime:
        sets.append("mime=?"); vals.append(mime)
    if size is not None:
        sets.append("size=?"); vals.append(int(size))
    sets += ["updated_at=?", "updated_rev=?"]
    vals += [_now(), rev]
    vals.append(media_id)
    conn.execute(f"UPDATE media SET {', '.join(sets)} WHERE id=?", vals)
    conn.commit()
    return store.get_media(media_id)


def set_poster(media_id: str, poster_rel: str) -> Optional[dict]:
    """thumbnail 作业回填：写海报相对路径。"""
    conn = db.get_conn()
    if not store.get_media_row(media_id):
        return None
    rev = db.bump_revision()
    conn.execute(
        "UPDATE media SET poster_path=?, updated_at=?, updated_rev=? WHERE id=?",
        (poster_rel, _now(), rev, media_id),
    )
    conn.commit()
    return store.get_media(media_id)


def set_clip_status(clip_id: str, status: str, *, file_path: Optional[str] = None,
                    has_file: Optional[bool] = None, size: Optional[int] = None) -> None:
    """clip 作业状态回填（pending→cutting→completed/failed）。"""
    conn = db.get_conn()
    sets = ["clip_status=?", "updated_at=?"]
    vals: list = [status, _now()]
    if file_path is not None:
        sets.append("file_path=?"); vals.append(file_path)
    if has_file is not None:
        sets.append("has_file=?"); vals.append(1 if has_file else 0)
    if size is not None:
        sets.append("size=?"); vals.append(size)
    rev = db.bump_revision()
    sets.append("updated_rev=?"); vals.append(rev)
    vals.append(clip_id)
    conn.execute(f"UPDATE media SET {', '.join(sets)} WHERE id=?", vals)
    conn.commit()


def delete_media(media_id: str) -> bool:
    conn = db.get_conn()
    doomed = [media_id] + [
        r["id"] for r in conn.execute("SELECT id FROM media WHERE parent_id=?", (media_id,))
    ]
    rev = None
    for mid in doomed:
        cur = conn.execute("DELETE FROM media WHERE id=?", (mid,))
        if cur.rowcount:
            conn.execute("DELETE FROM marks WHERE media_id=?", (mid,))
            conn.execute("DELETE FROM media_tags WHERE media_id=?", (mid,))
            conn.execute("DELETE FROM media_cast WHERE media_id=?", (mid,))
            rev = db.bump_revision()
            conn.execute(
                "INSERT OR REPLACE INTO tombstones(entity,ref,revision) VALUES('media',?,?)",
                (mid, rev),
            )
    conn.commit()
    return rev is not None


def delete_actors(names: list[str]) -> int:
    """Remove actor profiles and cast links; keep media and their tags intact."""
    conn = db.get_conn()
    removed = 0
    with conn:
        for name in dict.fromkeys(names):
            if not conn.execute("SELECT 1 FROM actors WHERE name=?", (name,)).fetchone():
                continue
            affected = [r["media_id"] for r in conn.execute("SELECT media_id FROM media_cast WHERE actor_name=?", (name,))]
            rev = db.bump_revision()
            conn.execute("DELETE FROM media_cast WHERE actor_name=?", (name,))
            conn.execute("DELETE FROM actor_tags WHERE actor_name=?", (name,))
            conn.execute("DELETE FROM actors WHERE name=?", (name,))
            conn.execute("INSERT OR REPLACE INTO tombstones(entity,ref,revision) VALUES('actor',?,?)", (name, rev))
            for mid in affected:
                _touch(conn, mid, _now(), rev)
            removed += 1
    return removed


def add_cast_batch(media_ids: list[str], names: list[str]) -> int:
    """Atomically append cast to source videos and merge the new actors' tags."""
    if not isinstance(media_ids, list) or not media_ids or len(media_ids) > 2000 or not all(isinstance(mid, str) and mid for mid in media_ids):
        raise ValueError("请选择要设置演员的视频")
    if not isinstance(names, list) or not names or len(names) > 200 or not all(isinstance(name, str) and name.strip() for name in names):
        raise ValueError("请选择或输入演员姓名")
    media_ids = list(dict.fromkeys(media_ids))
    names = list(dict.fromkeys(name.strip() for name in names))
    conn = db.get_conn()
    # Start the write transaction before validating to avoid deletion racing the batch.
    try:
        conn.execute("BEGIN IMMEDIATE")
        for mid in media_ids:
            row = conn.execute("SELECT kind FROM media WHERE id=?", (mid,)).fetchone()
            if not row or row["kind"] != "source":
                raise ValueError("部分视频已被移除，请刷新后重新选择")
        ts = _now()
        rev = db.bump_revision()
        for name in names:
            conn.execute("INSERT OR IGNORE INTO actors(name,updated_at,updated_rev) VALUES(?,?,?)", (name, ts, rev))
        carry = {name: [row["tag"] for row in conn.execute("SELECT tag FROM actor_tags WHERE actor_name=?", (name,))] for name in names}
        for mid in media_ids:
            old = [row["actor_name"] for row in conn.execute("SELECT actor_name FROM media_cast WHERE media_id=? ORDER BY ord", (mid,))]
            added = [name for name in names if name not in old]
            for offset, name in enumerate(added, len(old)):
                conn.execute("INSERT INTO media_cast(media_id,actor_name,ord) VALUES(?,?,?)", (mid, name, offset))
                _ensure_tags(conn, carry[name])
                for tag in carry[name]:
                    conn.execute("INSERT OR IGNORE INTO media_tags(media_id,tag) VALUES(?,?)", (mid, tag))
            _touch(conn, mid, ts, rev)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return len(media_ids)


def rename_actor(name: str, new_name: str) -> dict:
    if not isinstance(name, str) or not isinstance(new_name, str) or not new_name.strip() or len(new_name.strip()) > 200:
        raise ValueError('请输入 1–200 个字符的演员姓名')
    new_name = new_name.strip()
    conn = db.get_conn()
    try:
        conn.execute('BEGIN IMMEDIATE')
        if not conn.execute('SELECT 1 FROM actors WHERE name=?', (name,)).fetchone():
            raise FileNotFoundError('演员不存在，请刷新后重试')
        if name == new_name:
            conn.rollback()
            return {'name': new_name}
        if conn.execute('SELECT 1 FROM actors WHERE name=?', (new_name,)).fetchone():
            raise ValueError('该演员姓名已存在，请使用其他姓名')
        rev, ts = db.bump_revision(), _now()
        affected = list(conn.execute('SELECT media_id FROM media_cast WHERE actor_name=?', (name,)))
        conn.execute('UPDATE actors SET name=?,updated_at=?,updated_rev=? WHERE name=?', (new_name, ts, rev, name))
        conn.execute('UPDATE actor_tags SET actor_name=? WHERE actor_name=?', (new_name, name))
        conn.execute('UPDATE media_cast SET actor_name=? WHERE actor_name=?', (new_name, name))
        conn.execute("INSERT OR REPLACE INTO tombstones(entity,ref,revision) VALUES('actor',?,?)", (name, rev))
        conn.execute("DELETE FROM tombstones WHERE entity='actor' AND ref=?", (new_name,))
        for row in affected:
            _touch(conn, row['media_id'], ts, rev)
        conn.commit()
        return {'name': new_name}
    except Exception:
        conn.rollback()
        raise

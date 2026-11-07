"""SQLite 元数据库：连接管理 + 建表（schema）。

表设计见 docs/后端数据结构.md 第 6 节。这里只负责结构与连接，
业务查询在 store.py。

revision（逻辑时钟）：每次写操作 +1，用于面板增量同步/探活。
存在 meta 表（k-v）里。软删除用 tombstones 表记录，供 delta 下发删除。
"""
from __future__ import annotations

import sqlite3
import threading
from typing import Optional

import config

_SCHEMA = """
CREATE TABLE IF NOT EXISTS media (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    kind         TEXT NOT NULL DEFAULT 'source',   -- source | clip
    duration     REAL NOT NULL DEFAULT 0,
    size         INTEGER NOT NULL DEFAULT 0,
    mime         TEXT NOT NULL DEFAULT '',
    poster_path  TEXT,
    rating       REAL NOT NULL DEFAULT 0,        -- 0-10，支持 0.5/0.1 精度
    year         TEXT,
    synopsis     TEXT,
    folder       TEXT NOT NULL DEFAULT '',
    has_file     INTEGER NOT NULL DEFAULT 0,        -- 0/1
    file_path    TEXT,
    parent_id    TEXT,                              -- 片段专用
    parent_name  TEXT,
    range_start  REAL,
    range_end    REAL,
    clip_status  TEXT,                              -- pending|cutting|completed|failed
    storage_id   TEXT,                              -- 归属存储设备；NULL=老 data/ 内建资产
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    updated_rev  INTEGER NOT NULL DEFAULT 0          -- 最后变更时的 revision（delta 按此过滤）
);

CREATE TABLE IF NOT EXISTS marks (
    id         TEXT PRIMARY KEY,
    media_id   TEXT NOT NULL,
    time       REAL NOT NULL,
    label      TEXT NOT NULL DEFAULT '',
    color      TEXT NOT NULL DEFAULT '',
    note       TEXT,
    created_at INTEGER NOT NULL,
    updated_rev INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_marks_media ON marks(media_id);

CREATE TABLE IF NOT EXISTS actors (
    name          TEXT PRIMARY KEY,
    photo_path    TEXT,
    rating_figure INTEGER,
    rating_looks  INTEGER,
    rating_acting INTEGER,
    bio           TEXT,
    updated_at    INTEGER NOT NULL,
    updated_rev   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tags (
    name TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS media_tags (
    media_id TEXT NOT NULL,
    tag      TEXT NOT NULL,
    PRIMARY KEY (media_id, tag)
);

CREATE TABLE IF NOT EXISTS actor_tags (
    actor_name TEXT NOT NULL,
    tag        TEXT NOT NULL,
    PRIMARY KEY (actor_name, tag)
);

CREATE TABLE IF NOT EXISTS media_cast (
    media_id   TEXT NOT NULL,
    actor_name TEXT NOT NULL,
    ord        INTEGER NOT NULL DEFAULT 0,          -- 保留演员顺序
    PRIMARY KEY (media_id, actor_name)
);

-- 软删除墓碑：供 GET /api/library/delta 下发删除
CREATE TABLE IF NOT EXISTS tombstones (
    entity   TEXT NOT NULL,      -- 'media' | 'actor' | 'mark'
    ref      TEXT NOT NULL,      -- media.id / actor.name / mark.id
    revision INTEGER NOT NULL,
    PRIMARY KEY (entity, ref)
);

-- k-v 元信息（revision 逻辑时钟、seed 标记等）
CREATE TABLE IF NOT EXISTS meta (
    k TEXT PRIMARY KEY,
    v TEXT
);

-- 存储设备：视频文件所在的物理位置（本机磁盘 / NAS / 移动硬盘 / 另一台机器）。
-- 后端是唯一大脑，视频文件可散落在多个 storage 上；本轮先只跑本机(kind=local)。
-- root_path 是后端可直达的绝对路径；media.file_path 存相对该根的子路径。
-- online=0 表示该存储当前不可达（离线/未挂载），流式会友好降级。
CREATE TABLE IF NOT EXISTS storages (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'local',       -- local | nas | remote
    root_path  TEXT NOT NULL,
    online     INTEGER NOT NULL DEFAULT 1,          -- 0/1 当前是否可达
    node_id    TEXT,                                -- 持有该存储的连接器节点；NULL=调度中心本地(loopback)
    added_at   INTEGER NOT NULL
);

-- 节点注册表（模块拆分）：连接器/处理器 enroll 后落一行。
-- 只有调度中心拥有 DB；连接器/处理器通过 HTTP 回调，绝不直接写库。
-- token_hash 存节点 token 的哈希；stream_key 是每节点签流 ticket 的密钥。
CREATE TABLE IF NOT EXISTS nodes (
    id           TEXT PRIMARY KEY,
    kind         TEXT NOT NULL,                     -- connector | processor
    name         TEXT NOT NULL DEFAULT '',
    base_url     TEXT,                              -- 该节点对外可达地址（连接器用于直连串流）
    token_hash   TEXT,                              -- 节点 token 的 sha256（compare_digest 校验）
    stream_key   TEXT,                              -- 每节点签流 ticket 的 HMAC 密钥
    capabilities TEXT NOT NULL DEFAULT '{}',        -- json，如 {"hasFfmpeg": true}
    online       INTEGER NOT NULL DEFAULT 0,        -- 0/1
    last_seen    INTEGER,
    enrolled_at  INTEGER NOT NULL
);

-- 作业队列（模块拆分）：探测/缩略图/剪辑。处理器 claim → 执行 → complete 回填。
CREATE TABLE IF NOT EXISTS jobs (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,                       -- probe | thumbnail | clip
    status     TEXT NOT NULL DEFAULT 'queued',      -- queued|claimed|running|completed|failed
    media_id   TEXT,
    node_id    TEXT,                                -- 源文件所属连接器节点
    claimed_by TEXT,                                -- 领取该作业的处理器节点 id
    payload    TEXT NOT NULL DEFAULT '{}',          -- json
    result     TEXT,                                -- json
    attempts   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    rev        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_jobs_status_kind ON jobs(status, kind);

-- 远程根删除墓碑：面板删除连接器存储后落一行，心跳补登记据此跳过，
-- 防止连接器下次心跳把已删根重新登记回来（"复活"）。显式重新添加时清除。
CREATE TABLE IF NOT EXISTS deleted_roots (
    node_id    TEXT NOT NULL,
    root_path  TEXT NOT NULL,
    deleted_at INTEGER NOT NULL,
    PRIMARY KEY (node_id, root_path)
);

-- 远程存储待重扫标记：面板上对 remote 存储点"重新扫描"时写入，
-- 下次该连接器心跳时捎带下发（rescanStorageIds）并消费掉，由连接器自行 walk 上报。
CREATE TABLE IF NOT EXISTS pending_rescans (
    storage_id TEXT PRIMARY KEY,
    node_id    TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
"""

_local = threading.local()
_init_lock = threading.Lock()
_initialized = False


def _configure(conn: sqlite3.Connection) -> None:
    """每个连接都要设的 PRAGMA（foreign_keys/busy_timeout 是连接级，非库级）。"""
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")     # 库级，幂等重设无害
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")    # 写者串行：等锁而非立即报 database is locked


def get_conn() -> sqlite3.Connection:
    """返回**当前线程专属**的 SQLite 连接。

    sqlite3 的连接对象不能被多线程并发使用——Flask threaded=True 下，
    共享单一全局连接会在并发请求（手机 GET + 连接器 job-claim + 心跳同时打）时
    破坏其内部状态导致进程 segfault（exit 139）。改为一线程一连接：WAL 模式支持
    多读一写，各请求线程各用各的连接，天然安全。首次建库/迁移在锁内只做一次。
    """
    global _initialized
    conn = getattr(_local, "conn", None)
    if conn is not None:
        return conn
    config.ensure_dirs()
    with _init_lock:
        conn = sqlite3.connect(config.DB_PATH, check_same_thread=False)
        _configure(conn)
        if not _initialized:
            conn.executescript(_SCHEMA)
            _migrate(conn)
            if get_meta("revision", conn) is None:
                set_meta("revision", "0", conn)
            conn.commit()
            _initialized = True
    _local.conn = conn
    return conn


def _migrate(conn: sqlite3.Connection) -> None:
    """轻量迁移：给早于本版本建的库补列（executescript 不会改已存在的表）。"""
    media_cols = {r["name"] for r in conn.execute("PRAGMA table_info(media)")}
    if "storage_id" not in media_cols:
        conn.execute("ALTER TABLE media ADD COLUMN storage_id TEXT")
    if "updated_rev" not in media_cols:
        conn.execute("ALTER TABLE media ADD COLUMN updated_rev INTEGER NOT NULL DEFAULT 0")

    actor_cols = {r["name"] for r in conn.execute("PRAGMA table_info(actors)")}
    if "updated_rev" not in actor_cols:
        conn.execute("ALTER TABLE actors ADD COLUMN updated_rev INTEGER NOT NULL DEFAULT 0")

    mark_cols = {r["name"] for r in conn.execute("PRAGMA table_info(marks)")}
    if "updated_rev" not in mark_cols:
        conn.execute("ALTER TABLE marks ADD COLUMN updated_rev INTEGER NOT NULL DEFAULT 0")

    storage_cols = {r["name"] for r in conn.execute("PRAGMA table_info(storages)")}
    if "node_id" not in storage_cols:
        conn.execute("ALTER TABLE storages ADD COLUMN node_id TEXT")


def get_meta(key: str, conn: Optional[sqlite3.Connection] = None) -> Optional[str]:
    row = (conn or get_conn()).execute("SELECT v FROM meta WHERE k=?", (key,)).fetchone()
    return row["v"] if row else None


def set_meta(key: str, value: str, conn: Optional[sqlite3.Connection] = None) -> None:
    (conn or get_conn()).execute(
        "INSERT INTO meta(k, v) VALUES(?, ?) "
        "ON CONFLICT(k) DO UPDATE SET v=excluded.v",
        (key, value),
    )


def current_revision() -> int:
    return int(get_meta("revision") or "0")


def bump_revision() -> int:
    """逻辑时钟 +1，返回新值。写操作提交前调用。"""
    rev = current_revision() + 1
    set_meta("revision", str(rev))
    return rev

"""PC 后端 · Flask 应用（全阶段：读 + 流式 + 写 + Outbox + 剪辑 + 配对）。

路由（与 packages/shared/protocol 对齐）：
  GET  /healthz                          探活 {ok, revision, version}
  POST /api/pair            {code}       配对换 token
  --- 以下需 Bearer token（流式/海报可用 ?token= 兼容 <video>） ---
  GET  /api/library                      全量元数据快照
  GET  /api/library/delta?since=         增量
  GET  /api/media/<id>/stream            视频流（HTTP Range）
  GET  /api/media/<id>/poster            海报/缩略图
  POST /api/media/<id>/rename  {name}
  POST /api/media/<id>/rating  {rating}
  POST /api/media/<id>/tags    {tags}    （触发演员标签互通）
  POST /api/media/<id>/cast    {cast}    （触发标签并入）
  POST /api/media/<id>/marks   {time,label?,note?}
  POST /api/media/<id>/marks/<markId>    更新打点
  DELETE /api/media/<id>/marks/<markId>
  POST /api/actors            {actor}    upsert 演员
  POST /api/clips             {parentId,rangeStart,rangeEnd,name}  建片段并触发剪辑
  DELETE /api/media/<id>                 删除素材/片段
  POST /api/outbox/flush      {entries}  离线队列回放

连接：绑 0.0.0.0 + CORS 放开（局域网/Tailscale 直连）。
"""
from __future__ import annotations

import os

import requests
from flask import Flask, Response, abort, jsonify, request, send_file
from flask_cors import CORS

import auth
import clipper
import config
import contract
import db
import jobs
import nodes
import outbox
import scanner
import seed
import store
import tickets
import writes
import worker
import storage_files

app = Flask(__name__)
CORS(app)


def _ok(data=None):
    return jsonify({"ok": True, "data": data})


def _err(code: str, message: str, status: int):
    return jsonify({"ok": False, "error": {"code": code, "message": message}}), status


# ============================================================
# 探活 + 配对（无需鉴权）
# ============================================================

@app.get("/healthz")
def healthz():
    return jsonify({"ok": True, "revision": db.current_revision(), "version": config.VERSION})


@app.post("/api/pair")
def pair():
    code = (request.get_json(silent=True) or {}).get("code", "")
    token = auth.verify_pair(str(code))
    if not token:
        return _err("bad_code", "配对码不正确", 403)
    return _ok({"token": token, "revision": db.current_revision(), "version": config.VERSION})


# ============================================================
# 读路径
# ============================================================

@app.get("/api/library")
@auth.require_auth
def library():
    return _ok(store.snapshot())


@app.get("/api/library/delta")
@auth.require_auth
def library_delta():
    try:
        since = int(request.args.get("since", "0"))
    except ValueError:
        since = 0
    return _ok(store.delta(since))


def _stream_authorized() -> bool:
    # <video>/<img> 无法带 header，允许 ?token= 兜底
    import secrets
    if os.environ.get("VM_NO_AUTH") == "1":
        return True
    tok = db.get_meta("token")
    if not tok:
        return False
    qt = request.args.get("token")
    if qt and secrets.compare_digest(qt, tok):
        return True
    a = request.headers.get("Authorization", "")
    return a.startswith("Bearer ") and secrets.compare_digest(a[7:], tok)


_HOP_HEADERS = {"connection", "keep-alive", "transfer-encoding", "te", "trailer",
                "upgrade", "proxy-authorization", "proxy-authenticate"}


@app.get("/api/media/<media_id>/stream")
def stream_media(media_id: str):
    if not _stream_authorized():
        return _err("unauthorized", "需要配对", 401)
    row = store.get_media_row(media_id)
    if not row:
        return _err("not_found", "素材不存在", 404)
    node, rel, err = store.locate_media(row)
    if err == "storage_offline":
        return _err("storage_offline", "该视频所在的存储设备当前离线", 409)
    if err == "node_offline" or err == "node_missing":
        return _err("node_offline", "该视频所在的连接器当前离线", 409)
    if err == "no_file":
        return _err("no_file", "该素材尚未关联文件", 409)
    if err:
        return _err("file_missing", "文件在磁盘上缺失或不可访问", 410)
    if node is None:
        # loopback：本机磁盘，字节级不变的 send_file 捷径
        abs_path, ferr = store.resolve_media_file(row)
        if ferr:
            return _err("file_missing", "文件在磁盘上缺失或不可访问", 410)
        return send_file(abs_path, mimetype=row["mime"] or "application/octet-stream",
                         conditional=True)
    # 远程连接器：代理回落（签 ticket → 透传 Range，保留 status/headers）
    ticket, _exp = tickets.sign(node["stream_key"], node["id"],
                                row["storage_id"], media_id, rel)
    direct = f"{(node['base_url'] or '').rstrip('/')}{contract.files_stream_path()}?ticket={ticket}"
    fwd = {}
    if request.headers.get("Range"):
        fwd["Range"] = request.headers["Range"]
    try:
        upstream = requests.get(direct, headers=fwd, stream=True, timeout=(5, None))
    except requests.RequestException:
        return _err("node_offline", "连接器不可达", 502)
    resp_headers = [(k, v) for k, v in upstream.headers.items()
                    if k.lower() not in _HOP_HEADERS]
    return Response(upstream.iter_content(chunk_size=64 * 1024),
                    status=upstream.status_code, headers=resp_headers)


@app.get("/api/media/<media_id>/poster")
def poster_media(media_id: str):
    if not _stream_authorized():
        abort(401)
    row = store.get_media_row(media_id)
    if not row or not row["poster_path"]:
        abort(404)
    abs_path = config.resolve_asset(row["poster_path"])
    if not abs_path or not os.path.isfile(abs_path):
        abort(404)
    return send_file(abs_path, mimetype="image/jpeg", conditional=True)


# ============================================================
# 写路径
# ============================================================

def _body() -> dict:
    return request.get_json(silent=True) or {}


@app.post("/api/media/<media_id>/rename")
@auth.require_auth
def rename(media_id: str):
    r = writes.rename_media(media_id, _body().get("name", ""))
    return _ok(r) if r else _err("not_found", "素材不存在", 404)


@app.post("/api/media/<media_id>/rating")
@auth.require_auth
def rating(media_id: str):
    r = writes.set_rating(media_id, _body().get("rating", 0))
    return _ok(r) if r else _err("not_found", "素材不存在", 404)


@app.post("/api/media/<media_id>/tags")
@auth.require_auth
def tags(media_id: str):
    r = writes.set_tags(media_id, _body().get("tags", []))
    return _ok(r) if r else _err("not_found", "素材不存在", 404)


@app.post("/api/media/<media_id>/cast")
@auth.require_auth
def cast(media_id: str):
    r = writes.set_cast(media_id, _body().get("cast", []))
    return _ok(r) if r else _err("not_found", "素材不存在", 404)


@app.post("/api/media/<media_id>/marks")
@auth.require_auth
def add_mark(media_id: str):
    b = _body()
    r = writes.add_mark(media_id, b.get("time", 0), b.get("label"), b.get("note"))
    return _ok(r) if r else _err("not_found", "素材不存在", 404)


@app.post("/api/media/<media_id>/marks/<mark_id>")
@auth.require_auth
def update_mark(media_id: str, mark_id: str):
    r = writes.update_mark(media_id, mark_id, _body())
    return _ok(r) if r else _err("not_found", "打点不存在", 404)


@app.delete("/api/media/<media_id>/marks/<mark_id>")
@auth.require_auth
def remove_mark(media_id: str, mark_id: str):
    return _ok({"removed": True}) if writes.remove_mark(media_id, mark_id) \
        else _err("not_found", "打点不存在", 404)


@app.post("/api/media/batch-cast")
@auth.require_auth
def batch_media_cast():
    body = _body()
    try:
        count = writes.add_cast_batch(body.get("mediaIds"), body.get("names"))
    except ValueError as exc:
        return _err("bad_request", str(exc), 400)
    return _ok({"updated": count})


@app.post("/api/actors/delete")
@auth.require_auth
def delete_actors():
    names = _body().get("names")
    if not isinstance(names, list) or not names or len(names) > 1000 or not all(isinstance(n, str) and n for n in names):
        return _err("bad_request", "请选择要删除的演员", 400)
    return _ok({"removed": writes.delete_actors(names)})


@app.post("/api/actors/rename")
@auth.require_auth
def rename_actor():
    try:
        body = _body()
        return _ok(writes.rename_actor(body.get('name'), body.get('newName')))
    except ValueError as exc:
        return _err('bad_request', str(exc), 400)
    except FileNotFoundError as exc:
        return _err('not_found', str(exc), 404)


@app.post("/api/actors")
@auth.require_auth
def upsert_actor():
    r = writes.upsert_actor(_body())
    return _ok(r) if r else _err("bad_request", "缺少演员名", 400)


@app.post("/api/clips")
@auth.require_auth
def create_clip():
    b = _body()
    r = writes.create_clip(b.get("parentId"), b.get("rangeStart"), b.get("rangeEnd"), b.get("name", "片段"))
    if not r:
        return _err("bad_request", "母素材不存在或区间无效", 400)
    clipper.process_pending_async()  # 若母素材有本地文件，立即切；否则留 pending
    return _ok(r)


@app.delete("/api/media/<media_id>")
@auth.require_auth
def delete_media(media_id: str):
    try:
        return _ok({"removed": True}) if storage_files.delete_media_file(media_id) else _err("not_found", "素材不存在", 404)
    except (ValueError, OSError, requests.RequestException) as exc:
        return _err("file_error", str(exc), 409)


# ============================================================
# 存储设备（登记引用：注册真实 PC 目录，扫描登记视频，不搬动文件）
# ============================================================

@app.route("/api/storages/<storage_id>/entries", methods=["GET", "DELETE", "PATCH", "POST"])
@auth.require_auth
def storage_entries(storage_id: str):
    rel = request.args.get("path", "") if request.method == "GET" else _body().get("path", "")
    try:
        if request.method == "POST":
            return _ok(storage_files.create_entry(storage_id, rel))
        if request.method == "PATCH":
            body = _body()
            return _ok(storage_files.relocate(storage_id, rel, body.get("action"), body.get("name"), body.get("directory")))
        return _ok(storage_files.operate(storage_id, rel, delete=request.method == "DELETE"))
    except ValueError as exc:
        return _err("bad_path", str(exc), 400)
    except FileNotFoundError as exc:
        return _err("not_found", str(exc), 404)
    except (OSError, requests.RequestException) as exc:
        return _err("file_error", str(exc), 409)


@app.put("/api/storages/<storage_id>/files")
@auth.require_auth
def upload_storage_file(storage_id: str):
    try:
        return _ok(storage_files.create_entry(storage_id, request.args.get('path', ''), request.stream, request.content_length))
    except ValueError as exc:
        return _err('bad_path', str(exc), 400)
    except FileNotFoundError as exc:
        return _err('not_found', str(exc), 404)
    except (OSError, requests.RequestException) as exc:
        return _err('file_error', str(exc), 409)


@app.get("/api/storages")
@auth.require_auth
def list_storages_route():
    return _ok(store.list_storages_camel())


@app.post("/api/storages")
@auth.require_auth
def add_storage():
    b = _body()
    name = (b.get("name") or "").strip()
    path = (b.get("path") or "").strip()
    kind = (b.get("kind") or "local").strip() or "local"
    node_id = (b.get("nodeId") or b.get("node_id") or "").strip() or None
    if not path:
        return _err("bad_request", "缺少路径", 400)
    # 远程连接器设备：路径在连接器机器上，调度中心不做本机磁盘校验。
    # 登记一条 remote 存储，随后由连接器经心跳采纳该 root 并 walk 上报（见 nodes.heartbeat）。
    if node_id and node_id != nodes.LOOPBACK_ID:
        node = nodes.get_node(node_id)
        if not node:
            return _err("not_found", "目标设备不存在", 404)
        if node["kind"] != "connector":
            return _err("bad_target", "目标设备不是数据存储连接器", 400)
        if not nodes.is_online(node_id):
            return _err("node_offline", "目标设备当前离线，无法登记目录", 409)
        # 显式重新添加：先清删除墓碑（若有），否则 ensure_node_storage 会因墓碑跳过登记
        store.clear_deleted_root(node_id, path)
        sid = store.ensure_node_storage(node_id, path, name or None)
        return _ok(store.get_storage_camel(sid))
    # 本机(loopback)：沿用原逻辑，调度中心磁盘上校验 + 本地扫描
    abs_root = os.path.abspath(os.path.expanduser(path))
    if not os.path.isdir(abs_root):
        return _err("not_a_dir", "该路径不是一个存在的目录", 400)
    if not os.access(abs_root, os.R_OK):
        return _err("not_readable", "该目录不可读（权限不足）", 400)
    if not name:
        name = os.path.basename(abs_root.rstrip("/")) or abs_root
    row = store.add_storage(name=name, kind=kind, root_path=abs_root)
    scanner.scan_async(row["id"])  # 后台扫描登记视频
    return _ok(row)


@app.delete("/api/storages/<storage_id>")
@auth.require_auth
def delete_storage(storage_id: str):
    return _ok({"removed": True}) if store.delete_storage(storage_id) \
        else _err("not_found", "存储不存在", 404)


@app.post("/api/storages/<storage_id>/rescan")
@auth.require_auth
def rescan_storage(storage_id: str):
    if not store.get_storage_row(storage_id):
        return _err("not_found", "存储不存在", 404)
    scanner.scan_async(storage_id)
    return _ok({"scanning": True})


# ============================================================
# 设备（节点）列表 + 配对加设备
# ============================================================

@app.get("/api/nodes")
@auth.require_auth
def list_nodes_route():
    """当前接入的设备（含本机 loopback），带角色/在线态/下挂存储。"""
    return _ok(nodes.list_nodes_camel())


@app.get("/api/enroll-info")
@auth.require_auth
def enroll_info():
    """已配对手机取 enroll 凭证，转交给待配对连接器，把它接入本调度中心。

    安全：局域网单用户家用模型——手机已完成配对，向它下发 enrollment token 可接受。
    coordinatorUrl 用手机连上调度中心的地址（同一局域网/Tailscale 下连接器同样可达）。
    """
    coordinator_url = request.host_url.rstrip("/")
    return _ok({"coordinatorUrl": coordinator_url, "enrollToken": auth.enroll_token()})


# ============================================================
# 模块拆分：节点 enroll/heartbeat、作业队列、扫描上报、智能串流、连接器文件服务
# 只有调度中心拥有 DB；连接器/处理器经以下 HTTP 接口协作，绝不直接写库。
# ============================================================

def _snake_body() -> dict:
    return contract.keys_to_snake(_body())


# ---- 智能串流定位（手机 token 鉴权）----

@app.get("/api/media/<media_id>/stream-locate")
@auth.require_auth
def stream_locate(media_id: str):
    row = store.get_media_row(media_id)
    if not row:
        return _err("not_found", "素材不存在", 404)
    node, rel, err = store.locate_media(row)
    if err:
        code = 409 if err in ("storage_offline", "node_offline", "no_file") else 410
        return _err(err, "源不可用", code)
    proxy_url = f"{request.host_url.rstrip('/')}{contract.stream_path(media_id)}"
    if node is None:
        nid = nodes.LOOPBACK_ID
        sk = nodes.node_stream_key(nid)
        base = request.host_url.rstrip('/')
    else:
        nid = node["id"]
        sk = node["stream_key"]
        base = (node["base_url"] or "").rstrip("/")
    ticket, exp = tickets.sign(sk, nid, row["storage_id"], media_id, rel)
    direct = f"{base}{contract.files_stream_path()}?ticket={ticket}"
    return _ok({
        "nodeId": nid,
        "directUrl": direct,
        "proxyUrl": proxy_url,
        "ticket": ticket,
        "expiresAt": exp,
    })


# ---- 节点 enroll / heartbeat ----

@app.post("/api/nodes/enroll")
def node_enroll():
    b = _snake_body()
    if not auth.verify_enroll(request.headers.get("X-Enroll-Token", "")
                              or b.get("enroll_token", "")):
        return _err("enroll_unauthorized", "enrollment token 无效", 401)
    kind = b.get("kind")
    if kind not in ("connector", "processor"):
        return _err("bad_request", "kind 必须是 connector|processor", 400)
    res = nodes.enroll(kind, b.get("name", ""), b.get("base_url"),
                       b.get("capabilities") or {}, b.get("roots") or [])
    return _ok(contract.keys_to_camel(res))


@app.post("/api/nodes/heartbeat")
@nodes.require_node_auth
def node_heartbeat():
    b = _snake_body()
    res = nodes.heartbeat(b.get("node_id"), bool(b.get("online", True)),
                          b.get("roots"), b.get("capabilities"))
    if res is None:
        return _err("not_found", "节点不存在", 404)
    return _ok(contract.keys_to_camel(res))


# ---- 连接器扫描上报 ----

@app.post("/api/nodes/scan-report")
@nodes.require_node_auth
def node_scan_report():
    b = _snake_body()
    storage_id = b.get("root_id")
    st = store.get_storage_row(storage_id)
    if not st:
        return _err("not_found", "存储不存在", 404)
    node_id = st["node_id"] if "node_id" in st.keys() else None
    res = scanner.apply_scan_report(storage_id, b.get("items") or [], node_id=node_id)
    return _ok({"accepted": res["added"], "newMediaIds": res["new_media_ids"]})


# ---- 作业队列：claim / complete ----

def _source_ref(row) -> tuple[dict | None, str | None]:
    """为处理器构造源引用（directUrl + ticket），供其经 HTTP 拉字节。"""
    node, rel, err = store.locate_media(row)
    if err:
        return None, err
    if node is None:
        nid = nodes.LOOPBACK_ID
        sk = nodes.node_stream_key(nid)
        base = request.host_url.rstrip("/")
    else:
        nid = node["id"]
        sk = node["stream_key"]
        base = (node["base_url"] or "").rstrip("/")
    ticket, _exp = tickets.sign(sk, nid, row["storage_id"], row["id"], rel)
    return {
        "directUrl": f"{base}{contract.files_stream_path()}?ticket={ticket}",
        "ticket": ticket, "relPath": rel, "mime": row["mime"],
    }, None


@app.post("/api/jobs/claim")
@nodes.require_node_auth
def job_claim():
    b = _snake_body()
    kinds = b.get("kinds") or ["probe", "thumbnail", "clip"]
    node_id = b.get("node_id")
    job = jobs.claim(kinds, node_id)
    if not job:
        return _ok({"job": None})
    # 附源引用：probe/thumbnail 用素材自身；clip 用母素材，并给出成品上传地址
    row = store.get_media_row(job["media_id"]) if job["media_id"] else None
    if job["kind"] in ("probe", "thumbnail") and row is not None:
        src, err = _source_ref(row)
        if err:
            jobs.complete(job["id"], "failed", {"error": err})
            return _ok({"job": None})
        job["payload"]["source"] = src
    elif job["kind"] == "clip" and row is not None:
        parent = store.get_media_row(row["parent_id"]) if row["parent_id"] else None
        if parent is None:
            jobs.complete(job["id"], "failed", {"error": "parent_missing"})
            return _ok({"job": None})
        src, err = _source_ref(parent)
        if err:
            jobs.complete(job["id"], "failed", {"error": err})
            return _ok({"job": None})
        # 成品上传到调度中心内建 data/clips（loopback），ticket 授权写入
        lb = nodes.LOOPBACK_ID
        out_rel = f"clips/{row['id']}.mp4"
        up_ticket, _e = tickets.sign(nodes.node_stream_key(lb), lb, None, row["id"], out_rel)
        job["payload"].update({
            "source": src,
            "rangeStart": row["range_start"],
            "rangeEnd": row["range_end"],
            "outRelPath": out_rel,
            "uploadUrl": f"{request.host_url.rstrip('/')}{contract.files_upload_path()}?ticket={up_ticket}",
        })
    return _ok({"job": contract.keys_to_camel(job)})


@app.post("/api/jobs/<job_id>/complete")
@nodes.require_node_auth
def job_complete(job_id: str):
    b = _snake_body()
    job = jobs.get(job_id)
    if not job:
        return _err("not_found", "作业不存在", 404)
    status = b.get("status", "completed")
    result = b.get("result") or {}
    if status == "completed" and job["media_id"]:
        mid = job["media_id"]
        if job["kind"] == "probe":
            writes.apply_probe(mid, result.get("duration", 0),
                               mime=result.get("mime"), size=result.get("size"))
        elif job["kind"] == "thumbnail":
            if result.get("poster_path"):
                writes.set_poster(mid, result["poster_path"])
        elif job["kind"] == "clip":
            writes.set_clip_status(mid, "completed",
                                   file_path=result.get("rel_path"),
                                   has_file=True, size=result.get("size"))
    elif status == "failed" and job["media_id"] and job["kind"] == "clip":
        writes.set_clip_status(job["media_id"], "failed")
    jobs.complete(job_id, status, result)
    return _ok({"ok": True})


# ---- 处理器上传缩略图（节点鉴权）----

@app.post("/api/media/<media_id>/poster")
@nodes.require_node_auth
def upload_poster(media_id: str):
    if not store.get_media_row(media_id):
        return _err("not_found", "素材不存在", 404)
    data = request.get_data()
    if not data:
        return _err("bad_request", "空文件", 400)
    rel = f"thumbs/{media_id}.jpg"
    abs_path = config.resolve_asset(rel)
    if not abs_path:
        return _err("bad_path", "非法路径", 400)
    with open(abs_path, "wb") as f:
        f.write(data)
    writes.set_poster(media_id, rel)
    return _ok({"posterPath": rel})


# ============================================================
# 连接器文件服务（ticket 鉴权，不在调度中心业务面）
# monolith 下与调度中心同进程挂载；Phase 3 物理移入 connector/app.py。
# ============================================================

def _verify_ticket() -> tuple[dict | None, str | None]:
    ticket = request.args.get("ticket", "")
    try:
        node_id = ticket.split(".", 1)[0]
        import json as _json
        payload = _json.loads(tickets._b64u_decode(node_id))
        nid = payload.get("n")
    except Exception:
        return None, None
    sk = nodes.node_stream_key(nid)
    return tickets.verify(sk, ticket), sk


def _resolve_ticket_path(claims: dict) -> str | None:
    storage_id = claims.get("storage_id")
    rel = claims.get("rel_path")
    if storage_id:
        st = store.get_storage_row(storage_id)
        if not st:
            return None
        return config.resolve_within_root(st["root_path"], rel)
    return config.resolve_asset(rel)  # 内建 data/ 资产


@app.get("/files/stream")
def files_stream():
    claims, _sk = _verify_ticket()
    if not claims or claims.get("purpose", "stream") != "stream":
        return _err("bad_ticket", "ticket 无效或过期", 403)
    abs_path = _resolve_ticket_path(claims)
    if not abs_path or not os.path.isfile(abs_path):
        return _err("file_missing", "文件不存在", 404)
    return send_file(abs_path, conditional=True)


@app.post("/files/upload")
def files_upload():
    claims, _sk = _verify_ticket()
    if not claims or claims.get("purpose", "stream") != "stream":
        return _err("bad_ticket", "ticket 无效或过期", 403)
    abs_path = _resolve_ticket_path(claims)
    if not abs_path:
        return _err("bad_path", "非法路径", 400)
    data = request.get_data()
    if not data:
        return _err("bad_request", "空文件", 400)
    os.makedirs(os.path.dirname(abs_path), exist_ok=True)
    with open(abs_path, "wb") as f:
        f.write(data)
    return _ok({"size": len(data)})


# ============================================================
# Outbox 回放
# ============================================================

@app.post("/api/outbox/flush")
@auth.require_auth
def outbox_flush():
    b = _body()
    entries = b.get("entries", [])
    since = b.get("since")
    result = outbox.flush(entries, since if isinstance(since, int) else 0)
    return _ok(result)


# ============================================================
# 启动
# ============================================================

def create_app():
    config.ensure_dirs()
    db.get_conn()
    nodes.ensure_loopback()  # 两种模式都需要：内建 clips 的串流/上传 ticket 用 loopback stream_key
    seed.seed_if_empty()
    auth.pair_code()  # 确保配对码/token 生成
    auth.enroll_token()  # 确保模块 enrollment token 生成
    if config.VM_MODE == "monolith":
        clipper.process_pending_async()  # 上线后补切离线期间排队的片段
        worker.wake()  # 起内嵌处理器线程消化排队作业
    return app


if __name__ == "__main__":
    create_app()
    port = int(os.environ.get("VM_PORT", "8787"))
    print(f"[videomanager] PC 后端启动 (VM_MODE={config.VM_MODE}): http://0.0.0.0:{port}")
    print(f"  数据目录: {config.DATA_DIR}")
    print(f"  配对码 (手机输入这个): {auth.pair_code()}")
    if config.VM_MODE != "monolith":
        print(f"  模块 enrollment token (连接器/处理器 enroll 用): {auth.enroll_token()}")
    if os.environ.get("VM_NO_AUTH") == "1":
        print("  [警告] 鉴权已关闭 (VM_NO_AUTH=1)")
    app.run(host="0.0.0.0", port=port, threaded=True)

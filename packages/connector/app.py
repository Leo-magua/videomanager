"""数据连接器主进程（独立部署）。

  GET  /healthz               探活（智能串流可达性探测目标 + 配对状态）
  POST /api/pair              配对模式下由手机接入：{code,coordinatorUrl,enrollToken,roots}
  GET  /files/stream?ticket=  ticket 鉴权，HTTP Range 串流本机文件字节
  POST /files/upload?ticket=  ticket 鉴权，接收上传（如剪辑成品）

启动流程：
  已配置（env 或 state 有调度中心地址+根）→ 注册/复用节点凭证 → 首扫各根并上报 → 起心跳线程 → 起 Flask。
  未配置 → 进入「配对模式」：生成 6 位配对码打印到控制台，只起 Flask 等手机 /api/pair 接入。
只碰文件 + HTTP，不碰 DB、不跑 ffmpeg。
"""
from __future__ import annotations

import os
import secrets
import threading
import time

from flask import Flask, jsonify, request, send_file
from flask_cors import CORS

import client
import config
import tickets
import walker
import filesystem

app = Flask(__name__)
CORS(app)

# 运行期节点身份（启动时填充）
NODE = {"id": None, "token": None, "stream_key": None,
        "roots": {}}          # {root_path: storage_id}
_storage_root: dict[str, str] = {}   # {storage_id: root_path}（ticket 定位用）

# 配对模式：未配置时生成的一次性配对码；已上线后置空
_PAIR_CODE: str | None = None
# 防止 bootstrap/心跳线程被重复启动（配对接口可能被多次调用）
_start_lock = threading.Lock()
_started = False


def _err(code: str, message: str, status: int):
    return jsonify({"ok": False, "error": {"code": code, "message": message}}), status


def _persist_state() -> None:
    """把节点凭证 + 调度中心配置 + 根映射统一持久化，重启后 config 可复用。"""
    config.save_state({
        "nodeId": NODE["id"], "nodeToken": NODE["token"], "streamKey": NODE["stream_key"],
        "roots": NODE["roots"],
        "coordinatorUrl": config.coordinator_url(), "enrollToken": config.enroll_token(),
    })


# ------------------------------------------------------------
# 节点身份：enroll 一次并持久化，之后复用（避免每次重注册产生孤儿存储）
# ------------------------------------------------------------

def _adopt_storage_mapping(storages, removed_roots=None) -> None:
    """采纳调度中心心跳回传的权威信息：root→storageId 映射 + 已删除根（removedRoots）。

    storages: [{root, storageId}]。调度中心侧是权威——
      · storage id 若变化（服务端 storage 被删后重建，media 已空）→ 更新本地缓存并重扫，
        避免用旧 id scan-report 404，也把素材重新报回来；
      · 出现本地没有的新根（如手机在设置里给本设备加了目录）→ 采纳并扫描上报，
        media 随之出现。无需给连接器开「调度中心→连接器」的鉴权推送接口。
    removed_roots: 面板已删除的根（调度中心有墓碑、不再补登记）——
      本地同步移除其根与 sid 映射，之后心跳不再上报它，串流定位也随之失效。
    """
    changed = False
    for root in removed_roots or []:
        sid = NODE["roots"].pop(root, None)
        if sid is not None:
            _storage_root.pop(sid, None)
            changed = True
            print(f"[connector] 根已在面板删除，本地移除: {root}")
    scan_queue: list[tuple[str, str]] = []   # [(root, storage_id)] 待扫描的根
    for it in storages or []:
        root = it.get("root")
        sid = it.get("storageId") or it.get("storage_id")
        if not root or not sid:
            continue
        old_sid = NODE["roots"].get(root)
        if old_sid is None:
            scan_queue.append((root, sid))       # 新根：首扫
        elif old_sid != sid:
            scan_queue.append((root, sid))       # sid 变了：服务端 storage 重建过，兜底重扫
            _storage_root.pop(old_sid, None)
        if old_sid != sid:
            NODE["roots"][root] = sid
            _storage_root[sid] = root
            changed = True
    if changed:
        _persist_state()
        print(f"[connector] 已按调度中心纠正存储映射: {NODE['roots']}")
    for root_path, sid in scan_queue:
        print(f"[connector] 扫描根: {root_path}")
        _scan_one(root_path, sid)


def _handle_rescan_ids(rescan_ids) -> None:
    """调度中心心跳捎带的重扫请求（面板对远程目录点"重新扫描"）：按 sid 反查 root 重扫。"""
    for sid in rescan_ids or []:
        root = _storage_root.get(sid) or next(
            (r for r, s in NODE["roots"].items() if s == sid), None
        )
        if not root:
            print(f"[connector] 重扫请求找不到对应根，跳过: {sid}")
            continue
        print(f"[connector] 按调度中心要求重扫: {root}")
        _scan_one(root, sid)


def _bootstrap() -> None:
    roots = config.roots()
    if not roots:
        raise RuntimeError("未设置任何登记根")
    state = config.load_state()
    if state.get("nodeId") and state.get("nodeToken") and state.get("streamKey"):
        NODE.update(id=state["nodeId"], token=state["nodeToken"],
                    stream_key=state["streamKey"], roots=state.get("roots") or {})
        # 心跳复用凭证：调度中心回传全量权威映射，据此自愈 + 采纳手机新加的根。
        try:
            res = client.heartbeat(NODE["id"], NODE["token"], roots)
            _adopt_storage_mapping(res.get("storages"), res.get("removedRoots"))
            _handle_rescan_ids(res.get("rescanStorageIds"))
        except client.CoordinatorError as e:
            print(f"[connector] 心跳失败（将在后台重试）: {e}")
    else:
        res = client.enroll(roots)
        mapping = {r: sid for r, sid in zip(roots, res.get("storageIds") or [])}
        NODE.update(id=res["nodeId"], token=res["nodeToken"],
                    stream_key=res["streamKey"], roots=mapping)
        _persist_state()
        print(f"[connector] 已注册为节点 {NODE['id']}，登记 {len(mapping)} 个根")
    for root_path, sid in NODE["roots"].items():
        _storage_root[sid] = root_path


def _scan_one(root_path: str, sid: str) -> None:
    if not os.path.isdir(root_path):
        print(f"[connector] 根不可达，跳过: {root_path}")
        return
    items = walker.walk_root(root_path)
    try:
        res = client.scan_report(NODE["id"], NODE["token"], sid, items)
        print(f"[connector] 上报 {root_path}: {len(items)} 个候选，新增 {res.get('accepted')}")
    except client.CoordinatorError as e:
        print(f"[connector] scan-report 失败 {root_path}: {e}")


def _scan_all() -> None:
    for root_path, sid in list(NODE["roots"].items()):
        _scan_one(root_path, sid)


def _heartbeat_loop() -> None:
    while True:
        time.sleep(config.HEARTBEAT_SEC)
        try:
            res = client.heartbeat(NODE["id"], NODE["token"], list(NODE["roots"].keys()))
            _adopt_storage_mapping(res.get("storages"), res.get("removedRoots"))
            _handle_rescan_ids(res.get("rescanStorageIds"))
        except Exception as e:
            print(f"[connector] 心跳失败: {e}")


def _start_online() -> str | None:
    """注册/复用凭证 + 首扫 + 起心跳线程。幂等（重复调用只执行一次）。返回 nodeId。"""
    global _started, _PAIR_CODE
    with _start_lock:
        if _started:
            return NODE["id"]
        _bootstrap()
        _scan_all()
        threading.Thread(target=_heartbeat_loop, daemon=True).start()
        _started = True
        _PAIR_CODE = None   # 已上线，配对码作废
    return NODE["id"]


# ------------------------------------------------------------
# 文件服务（ticket 鉴权）
# ------------------------------------------------------------

def _verify() -> dict | None:
    return tickets.verify(NODE["stream_key"], request.args.get("ticket", ""))


def _resolve(claims: dict) -> str | None:
    sid = claims.get("storage_id")
    root_path = _storage_root.get(sid)
    if not root_path:
        return None
    return config.resolve_within_root(root_path, claims.get("rel_path"))


@app.get("/healthz")
def healthz():
    return jsonify({"ok": True, "nodeId": NODE["id"], "roots": len(NODE["roots"]),
                    "configured": _started, "needsPairing": not _started, "fileOperationsVersion": "1.1.7"})


@app.route("/files/entries", methods=["GET", "DELETE", "PATCH", "POST"])
def file_entries():
    claims = _verify()
    purpose = {"GET": "browse", "DELETE": "delete", "PATCH": "relocate", "POST": "mkdir"}[request.method]
    if not claims or claims.get("purpose") != purpose or claims.get("node_id") != NODE["id"]:
        return _err("unauthorized", "文件操作凭证无效", 403)
    root = _storage_root.get(claims.get("storage_id"))
    if not root:
        return _err("not_found", "存储不存在", 404)
    rel = claims.get("rel_path") or ""
    if not os.path.isdir(root):
        return _err("storage_offline", "存储目录不可达，请连接存储设备后重试", 409)
    try:
        if request.method == "GET":
            return jsonify({"ok": True, "data": filesystem.browse(root, rel)})
        if request.method == "POST":
            return jsonify({"ok": True, "data": filesystem.mkdir(root, rel)})
        if request.method == "PATCH":
            return jsonify({"ok": True, "data": filesystem.relocate(root, rel, claims.get("destination"))})
        filesystem.delete(root, rel)
        return jsonify({"ok": True, "data": {"removed": True}})
    except ValueError as exc:
        return _err("bad_path", str(exc), 400)
    except FileNotFoundError:
        return _err("not_found", "文件或目录不存在", 404)
    except OSError as exc:
        return _err("file_error", str(exc), 409)


@app.put('/files/content')
def upload_file():
    claims = _verify()
    if not claims or claims.get('purpose') != 'upload-file' or claims.get('node_id') != NODE['id']:
        return _err('unauthorized', '上传凭证无效', 403)
    root = _storage_root.get(claims.get('storage_id'))
    if not root:
        return _err('not_found', '存储不存在', 404)
    try:
        if not os.path.isdir(root):
            raise OSError('存储目录不可达')
        return jsonify({'ok': True, 'data': filesystem.upload(root, claims.get('rel_path'), request.stream, request.content_length)})
    except ValueError as exc:
        return _err('bad_path', str(exc), 400)
    except OSError as exc:
        return _err('file_error', str(exc), 409)


@app.post("/api/pair")
def api_pair():
    """配对模式下由手机接入：校验配对码，写入调度中心配置，立即上线。"""
    if _started:
        return _err("already_paired", "该连接器已接入调度中心", 409)
    if not _PAIR_CODE:
        return _err("no_pairing", "当前不在配对模式", 409)
    b = request.get_json(silent=True) or {}
    code = str(b.get("code") or "")
    if not secrets.compare_digest(code, _PAIR_CODE):
        return _err("bad_code", "配对码不正确", 403)
    coordinator_url = str(b.get("coordinatorUrl") or "").strip()
    enroll_token = str(b.get("enrollToken") or "").strip()
    roots = b.get("roots") or []
    if not coordinator_url:
        return _err("bad_request", "缺少调度中心地址", 400)
    if not roots:
        return _err("bad_request", "至少需要一个要登记的目录", 400)
    config.set_coordinator(coordinator_url, enroll_token)
    config.set_roots([str(r) for r in roots])
    try:
        node_id = _start_online()
    except (client.CoordinatorError, RuntimeError) as e:
        # 上线失败：回退配置，允许重试
        return _err("enroll_failed", f"接入调度中心失败: {e}", 502)
    return jsonify({"ok": True, "data": {"nodeId": node_id}})


@app.get("/files/stream")
def files_stream():
    claims = _verify()
    if not claims or claims.get("purpose", "stream") != "stream":
        return _err("bad_ticket", "ticket 无效或过期", 403)
    abs_path = _resolve(claims)
    if not abs_path or not os.path.isfile(abs_path):
        return _err("file_missing", "文件不存在", 404)
    return send_file(abs_path, conditional=True)


@app.post("/files/upload")
def files_upload():
    claims = _verify()
    if not claims or claims.get("purpose", "stream") != "stream":
        return _err("bad_ticket", "ticket 无效或过期", 403)
    abs_path = _resolve(claims)
    if not abs_path:
        return _err("bad_path", "非法路径", 400)
    data = request.get_data()
    if not data:
        return _err("bad_request", "空文件", 400)
    os.makedirs(os.path.dirname(abs_path), exist_ok=True)
    with open(abs_path, "wb") as f:
        f.write(data)
    return jsonify({"ok": True, "data": {"size": len(data)}})


def main() -> None:
    config._load_runtime_from_state()   # 把上次持久化的调度中心配置并入运行期
    global _PAIR_CODE
    if config.is_configured():
        try:
            _start_online()
        except (client.CoordinatorError, RuntimeError) as e:
            # 已配置却上线失败（如调度中心暂时不可达）：退回配对模式等待人工介入
            print(f"[connector] 自动上线失败（{e}），转入配对模式")
    if not _started:
        _PAIR_CODE = "".join(secrets.choice("0123456789") for _ in range(6))
        print("=" * 48)
        print(f"[connector] {config.NAME} 处于配对模式，等待手机接入")
        print(f"[connector]   本机地址: {config.base_url()}")
        print(f"[connector]   配对码 (在手机设置里输入这个): {_PAIR_CODE}")
        print("=" * 48)
    else:
        print(f"[connector] {config.NAME} 启动: {config.base_url()} (监听 0.0.0.0:{config.PORT})")
    app.run(host="0.0.0.0", port=config.PORT, threaded=True)


if __name__ == "__main__":
    main()

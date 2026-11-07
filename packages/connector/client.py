"""连接器 → 调度中心 HTTP 客户端（enroll / heartbeat / scan-report）。

JSON 一律 camelCase（调度中心 _snake_body 会转回 snake，响应本就是 camel）。
凭证：首注册用 X-Enroll-Token；之后调用带 X-Node-Id + Bearer <nodeToken>。
"""
from __future__ import annotations

import requests

import config


class CoordinatorError(RuntimeError):
    pass


def _url(path: str) -> str:
    if not config.coordinator_url():
        raise CoordinatorError("未设置调度中心地址（未配置且未配对）")
    return config.coordinator_url() + path


def _unwrap(r: requests.Response) -> dict:
    try:
        body = r.json()
    except Exception:
        raise CoordinatorError(f"HTTP {r.status_code}: 非 JSON 响应")
    if not body.get("ok"):
        err = body.get("error") or {}
        raise CoordinatorError(f"{err.get('code')}: {err.get('message')}")
    return body.get("data") or {}


def _post(path: str, **kwargs) -> requests.Response:
    """统一发请求：网络层错误（连接拒绝/超时/DNS 等）一律包装成 CoordinatorError，
    让调用方（bootstrap/main）能按「调度中心不可达」优雅降级，而不是被未捕获异常搞崩进程。"""
    try:
        return requests.post(_url(path), timeout=15, **kwargs)
    except requests.RequestException as e:
        raise CoordinatorError(f"调度中心不可达: {e}") from e


def enroll(roots: list[str]) -> dict:
    """首次上线注册；返回 {nodeId, nodeToken, streamKey, storageIds, revision}。"""
    r = _post("/api/nodes/enroll",
              headers={"X-Enroll-Token": config.enroll_token()},
              json={"kind": "connector", "name": config.NAME,
                    "baseUrl": config.base_url(), "capabilities": {}, "roots": roots})
    return _unwrap(r)


def heartbeat(node_id: str, node_token: str, roots: list[str]) -> dict:
    r = _post("/api/nodes/heartbeat",
              headers={"X-Node-Id": node_id, "Authorization": f"Bearer {node_token}"},
              json={"nodeId": node_id, "online": True, "roots": roots})
    return _unwrap(r)


def scan_report(node_id: str, node_token: str, storage_id: str, items: list[dict]) -> dict:
    try:
        r = requests.post(
            _url("/api/nodes/scan-report"),
            headers={"X-Node-Id": node_id, "Authorization": f"Bearer {node_token}"},
            json={"nodeId": node_id, "rootId": storage_id, "items": items, "done": True},
            timeout=60,
        )
    except requests.RequestException as e:
        raise CoordinatorError(f"调度中心不可达: {e}") from e
    return _unwrap(r)

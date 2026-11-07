"""处理器 → 调度中心 HTTP 客户端（enroll / heartbeat / claim / complete / 上传）。"""
from __future__ import annotations

import requests

import config


class CoordinatorError(RuntimeError):
    pass


def _url(path: str) -> str:
    if not config.COORDINATOR_URL:
        raise CoordinatorError("未设置 VM_COORDINATOR_URL")
    return config.COORDINATOR_URL + path


def _unwrap(r: requests.Response) -> dict:
    try:
        body = r.json()
    except Exception:
        raise CoordinatorError(f"HTTP {r.status_code}: 非 JSON 响应")
    if not body.get("ok"):
        err = body.get("error") or {}
        raise CoordinatorError(f"{err.get('code')}: {err.get('message')}")
    return body.get("data") or {}


def _auth(node_id: str, token: str) -> dict:
    return {"X-Node-Id": node_id, "Authorization": f"Bearer {token}"}


def enroll() -> dict:
    r = requests.post(
        _url("/api/nodes/enroll"),
        headers={"X-Enroll-Token": config.ENROLL_TOKEN},
        json={"kind": "processor", "name": config.NAME,
              "capabilities": {"hasFfmpeg": True}},
        timeout=15,
    )
    return _unwrap(r)


def heartbeat(node_id: str, token: str) -> dict:
    r = requests.post(_url("/api/nodes/heartbeat"), headers=_auth(node_id, token),
                      json={"nodeId": node_id, "online": True,
                            "capabilities": {"hasFfmpeg": True}}, timeout=15)
    return _unwrap(r)


def claim(node_id: str, token: str) -> dict | None:
    r = requests.post(_url("/api/jobs/claim"), headers=_auth(node_id, token),
                      json={"nodeId": node_id, "kinds": ["probe", "thumbnail", "clip"]},
                      timeout=30)
    return _unwrap(r).get("job")


def complete(node_id: str, token: str, job_id: str, status: str, result: dict) -> dict:
    r = requests.post(_url(f"/api/jobs/{job_id}/complete"), headers=_auth(node_id, token),
                      json={"status": status, "result": result}, timeout=30)
    return _unwrap(r)


def upload_poster(node_id: str, token: str, media_id: str, jpg_bytes: bytes) -> dict:
    r = requests.post(_url(f"/api/media/{media_id}/poster"),
                      headers={**_auth(node_id, token), "Content-Type": "image/jpeg"},
                      data=jpg_bytes, timeout=30)
    return _unwrap(r)


def upload_file(upload_url: str, data: bytes) -> None:
    """成品上传到 payload 里给定的 uploadUrl（已带 ticket）。"""
    r = requests.post(upload_url, data=data,
                      headers={"Content-Type": "application/octet-stream"}, timeout=120)
    if r.status_code >= 400:
        raise CoordinatorError(f"上传失败 HTTP {r.status_code}")

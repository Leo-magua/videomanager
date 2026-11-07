"""数据连接器配置（独立进程，env 驱动，自带状态持久化）。

连接器职责：持有视频文件的机器上运行，把本机若干根目录「登记引用」给调度中心，
并经 ticket 鉴权对外提供文件字节（HTTP Range 串流）+ 接收剪辑成品上传。
它**不碰 DB**、**不跑 ffmpeg**，只做 walk + 文件 I/O + 心跳。

环境变量：
  VM_COORDINATOR_URL   调度中心基址，如 http://192.168.1.10:8787   （配对模式下可省，改由手机下发）
  VM_ENROLL_TOKEN      模块 enrollment token（调度中心启动时打印）   （配对模式下可省）
  VM_ROOTS             要登记的绝对根目录，多个用 os.pathsep 分隔     （配对模式下可省）
  VM_CONNECTOR_NAME    显示名（默认主机名）
  VM_CONNECTOR_PORT    本进程监听端口（默认 8788）
  VM_CONNECTOR_BASE_URL 对外可达基址（默认自动探测局域网 IP:端口）
  VM_STATE_FILE        节点凭证持久化文件（默认脚本旁 connector_state.json）
  VM_HEARTBEAT_SEC     心跳间隔秒（默认 20）

配置来源优先级：环境变量为初始种子；配对模式下手机下发的 coordinatorUrl/enrollToken/roots
经 set_coordinator()/set_roots() 写入运行期并持久化到 state 文件，重启后复用。
"""
from __future__ import annotations

import json
import os
import socket

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

NAME = (os.environ.get("VM_CONNECTOR_NAME") or socket.gethostname()).strip()
PORT = int(os.environ.get("VM_CONNECTOR_PORT") or "8788")
STATE_FILE = os.environ.get("VM_STATE_FILE") or os.path.join(BASE_DIR, "connector_state.json")
HEARTBEAT_SEC = int(os.environ.get("VM_HEARTBEAT_SEC") or "20")


def _env_roots() -> list[str]:
    raw = os.environ.get("VM_ROOTS") or ""
    out = []
    for p in raw.split(os.pathsep):
        p = p.strip()
        if p:
            out.append(os.path.abspath(os.path.expanduser(p)))
    return out


# ---- 运行期配置（env 种子 → 可被配对下发覆盖，持久化到 state）----
_RUNTIME = {
    "coordinator_url": (os.environ.get("VM_COORDINATOR_URL") or "").strip().rstrip("/"),
    "enroll_token": (os.environ.get("VM_ENROLL_TOKEN") or "").strip(),
    "roots": _env_roots(),
}


def _load_runtime_from_state() -> None:
    """启动时把 state 里持久化的配置并入运行期（env 未显式提供时以 state 为准）。"""
    st = load_state()
    if not _RUNTIME["coordinator_url"] and st.get("coordinatorUrl"):
        _RUNTIME["coordinator_url"] = str(st["coordinatorUrl"]).rstrip("/")
    if not _RUNTIME["enroll_token"] and st.get("enrollToken"):
        _RUNTIME["enroll_token"] = str(st["enrollToken"])
    if not _RUNTIME["roots"]:
        # state 的 roots 是 {root_path: storage_id} 映射；取其键作为登记根
        sr = st.get("roots")
        if isinstance(sr, dict):
            _RUNTIME["roots"] = list(sr.keys())
        elif isinstance(sr, list):
            _RUNTIME["roots"] = list(sr)


def coordinator_url() -> str:
    return _RUNTIME["coordinator_url"]


def enroll_token() -> str:
    return _RUNTIME["enroll_token"]


def roots() -> list[str]:
    return list(_RUNTIME["roots"])


def is_configured() -> bool:
    """是否已具备上线所需的最小配置（调度中心地址 + 至少一个根）。"""
    return bool(_RUNTIME["coordinator_url"]) and bool(_RUNTIME["roots"])


def set_coordinator(url: str, token: str) -> None:
    _RUNTIME["coordinator_url"] = (url or "").strip().rstrip("/")
    _RUNTIME["enroll_token"] = (token or "").strip()


def set_roots(paths: list[str]) -> None:
    norm = []
    for p in paths or []:
        p = (p or "").strip()
        if p:
            norm.append(os.path.abspath(os.path.expanduser(p)))
    _RUNTIME["roots"] = norm


def _detect_lan_ip() -> str:
    """探测本机在到达调度中心那条链路上的出口 IP（不真正发包）。"""
    host = "8.8.8.8"
    if coordinator_url():
        try:
            from urllib.parse import urlparse
            h = urlparse(coordinator_url()).hostname
            if h:
                host = h
        except Exception:
            pass
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect((host, 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def base_url() -> str:
    override = os.environ.get("VM_CONNECTOR_BASE_URL")
    if override:
        return override.rstrip("/")
    return f"http://{_detect_lan_ip()}:{PORT}"


# ---- 节点凭证持久化（enroll 一次，之后靠 heartbeat 复用；切勿每次重注册）----

def load_state() -> dict:
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_state(state: dict) -> None:
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
    os.replace(tmp, STATE_FILE)


def resolve_within_root(root_path: str, rel_path: str) -> str | None:
    """把「根 + 相对子路径」解析成绝对路径，归一化后必须仍落在根内（防目录穿越）。"""
    if not root_path or not rel_path:
        return None
    root = os.path.normpath(root_path)
    rel = rel_path.replace("\\", "/").lstrip("/")
    abs_path = os.path.normpath(os.path.join(root, rel))
    try:
        if os.path.commonpath([abs_path, root]) != root:
            return None
    except ValueError:
        return None
    return abs_path

"""视频处理器配置（独立进程，env 驱动）。

处理器职责：有算力/ffmpeg 的机器上运行，从调度中心领 probe/thumbnail/clip 作业，
经连接器给的带 ticket directUrl 拉源字节跑 ffmpeg/ffprobe，把结果回填调度中心。
它**不碰 DB**、**不持有源文件**（源经 HTTP 拉、成品经 HTTP 传）。

环境变量：
  VM_COORDINATOR_URL   调度中心基址（必填）
  VM_ENROLL_TOKEN      模块 enrollment token（首次注册必填）
  VM_PROCESSOR_NAME    显示名（默认主机名）
  VM_STATE_FILE        凭证持久化（默认脚本旁 processor_state.json）
  VM_SCRATCH           临时产物目录（默认脚本旁 scratch/）
  VM_POLL_SEC          无活时轮询间隔秒（默认 5）
  VM_HEARTBEAT_SEC     心跳间隔秒（默认 20）
"""
from __future__ import annotations

import json
import os
import socket

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

COORDINATOR_URL = (os.environ.get("VM_COORDINATOR_URL") or "").strip().rstrip("/")
ENROLL_TOKEN = (os.environ.get("VM_ENROLL_TOKEN") or "").strip()
NAME = (os.environ.get("VM_PROCESSOR_NAME") or socket.gethostname()).strip()
STATE_FILE = os.environ.get("VM_STATE_FILE") or os.path.join(BASE_DIR, "processor_state.json")
SCRATCH = os.environ.get("VM_SCRATCH") or os.path.join(BASE_DIR, "scratch")
POLL_SEC = int(os.environ.get("VM_POLL_SEC") or "5")
HEARTBEAT_SEC = int(os.environ.get("VM_HEARTBEAT_SEC") or "20")


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


def ensure_scratch() -> None:
    os.makedirs(SCRATCH, exist_ok=True)

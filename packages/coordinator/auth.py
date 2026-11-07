"""配对鉴权：轻量 token。

设计取向：家用工具，不做账号体系。首次启动生成一个配对码（pair code）+
长期 token，存 DB。面板扫码/手输配对码换取 token，之后请求带
`Authorization: Bearer <token>`。局域网信任模型，token 主要防同网陌生设备误连。

可用环境变量 VM_NO_AUTH=1 关闭鉴权（开发用）。
"""
from __future__ import annotations

import functools
import os
import secrets

from flask import jsonify, request

import db

_AUTH_DISABLED = os.environ.get("VM_NO_AUTH") == "1"


def _init_secrets() -> None:
    if db.get_meta("pair_code") is None:
        # 6 位数字配对码，方便手机手输
        code = "".join(secrets.choice("0123456789") for _ in range(6))
        db.set_meta("pair_code", code)
    if db.get_meta("token") is None:
        db.set_meta("token", secrets.token_urlsafe(24))
    db.get_conn().commit()


def pair_code() -> str:
    _init_secrets()
    return db.get_meta("pair_code")


def _token() -> str:
    _init_secrets()
    return db.get_meta("token")


def enroll_token() -> str:
    """模块 enrollment token：连接器/处理器凭它 enroll 换取每节点 node token。

    优先取环境变量 VM_ENROLL_TOKEN；否则首启生成入 meta 并（像 pair_code 一样）打印。
    """
    env = os.environ.get("VM_ENROLL_TOKEN")
    if env:
        return env
    if db.get_meta("enroll_token") is None:
        db.set_meta("enroll_token", secrets.token_urlsafe(24))
        db.get_conn().commit()
    return db.get_meta("enroll_token")


def verify_enroll(token: str) -> bool:
    return bool(token) and secrets.compare_digest(token, enroll_token())


def verify_pair(code: str) -> str | None:
    """配对码正确则返回 token，否则 None。"""
    if code and code == pair_code():
        return _token()
    return None


def _authorized() -> bool:
    if _AUTH_DISABLED:
        return True
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return secrets.compare_digest(auth[7:], _token())
    return False


def require_auth(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        if not _authorized():
            return jsonify({"ok": False, "error": {"code": "unauthorized",
                                                    "message": "需要配对"}}), 401
        return fn(*args, **kwargs)
    return wrapper

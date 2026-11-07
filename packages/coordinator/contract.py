"""把 packages/shared/py 契约包挂载为可导入模块 `shared_py`。

shared/py 用了相对导入（from .domain import ...），必须作为「包」加载。
这里用 importlib 把它注册成顶层包名 shared_py，之后全后端统一：
    from contract import MediaItem, keys_to_camel, ...
或
    import shared_py
"""
from __future__ import annotations

import importlib.util
import os
import sys

# 优先用随本目录部署的 _vendor/shared_py（脱离 monorepo 单独部署调度中心时），
# 否则回落到仓库内的兄弟目录 ../shared/py（monorepo 开发/单机模式）。
_HERE = os.path.dirname(os.path.abspath(__file__))
_VENDOR = os.path.join(_HERE, "_vendor", "shared_py")
_SIBLING = os.path.normpath(os.path.join(_HERE, "..", "shared", "py"))
_SHARED_PY = _VENDOR if os.path.isfile(os.path.join(_VENDOR, "__init__.py")) else _SIBLING

if "shared_py" not in sys.modules:
    spec = importlib.util.spec_from_file_location(
        "shared_py",
        os.path.join(_SHARED_PY, "__init__.py"),
        submodule_search_locations=[_SHARED_PY],
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules["shared_py"] = module
    spec.loader.exec_module(module)

import shared_py  # noqa: E402

# 常用符号转出，方便 `from contract import X`
from shared_py import (  # noqa: E402,F401
    Actor,
    ActorRating,
    ClipStatus,
    CreateClipRequest,
    Event,
    FlushResponse,
    LibraryDelta,
    LibrarySnapshot,
    Mark,
    MediaItem,
    MediaKind,
    OutboxEntry,
    files_stream_path,
    files_upload_path,
    has_local_file,
    keys_to_camel,
    keys_to_snake,
    poster_path,
    stream_path,
    to_camel,
    to_snake,
)

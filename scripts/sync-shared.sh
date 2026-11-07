#!/usr/bin/env bash
# 把 packages/shared/py 契约包 vendored 进调度中心，使其可脱离 monorepo 单独部署。
#
# 用法：
#   scripts/sync-shared.sh            # 默认同步到 packages/coordinator
#   scripts/sync-shared.sh <role_dir> # 同步到指定角色目录（须含 contract.py 的 _vendor 优先逻辑）
#
# 说明：
#   连接器 / 处理器是自包含的（不 import shared_py），无需 vendoring —— 只有调度中心用得上。
#   coordinator/contract.py 优先加载 _vendor/shared_py，缺失时回落到 ../shared/py。
#   本脚本 idempotent：每次全量覆盖 _vendor/shared_py。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/packages/shared/py"
ROLE_DIR="${1:-$REPO_ROOT/packages/coordinator}"
DEST="$ROLE_DIR/_vendor/shared_py"

if [ ! -f "$SRC/__init__.py" ]; then
  echo "error: 找不到共享契约包 $SRC/__init__.py" >&2
  exit 1
fi
if [ ! -f "$ROLE_DIR/contract.py" ]; then
  echo "error: 目标角色目录缺少 contract.py: $ROLE_DIR" >&2
  exit 1
fi

rm -rf "$DEST"
mkdir -p "$DEST"
# 只复制 .py 源码，跳过 __pycache__ 等
( cd "$SRC" && find . -name '*.py' -print0 | while IFS= read -r -d '' f; do
    mkdir -p "$DEST/$(dirname "$f")"
    cp "$f" "$DEST/$f"
  done )

echo "已同步 shared/py -> $DEST"
echo "文件："
( cd "$DEST" && find . -name '*.py' | sort )

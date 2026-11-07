#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$ROOT/config/coordinator.local.env" ]; then
  set -a
  source "$ROOT/config/coordinator.local.env"
  set +a
fi
PYTHON="${PYTHON:-python3}"
if [ -x "$ROOT/.venv/bin/python" ]; then PYTHON="$ROOT/.venv/bin/python"; fi
cd "$ROOT/packages/coordinator"
exec "$PYTHON" app.py

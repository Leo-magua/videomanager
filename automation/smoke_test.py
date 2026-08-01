import argparse
import json
import sys
from pathlib import Path


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--json-args", default="{}", help="JSON args from runner")
    args = p.parse_args()

    try:
        cfg = json.loads(args.json_args or "{}")
    except json.JSONDecodeError:
        cfg = {}

    root = Path(__file__).resolve().parents[1]
    app_py = root / "server" / "app.py"

    ok = app_py.exists() and app_py.stat().st_size > 0
    detail = {
        "project_root": str(root),
        "app_py_exists": app_py.exists(),
        "app_py_size": app_py.stat().st_size if app_py.exists() else 0,
        "args": cfg,
    }
    print(json.dumps({"ok": ok, "detail": detail}, ensure_ascii=False))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())


import argparse
import json
from datetime import datetime, timedelta
from pathlib import Path


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--json-args", default="{}", help="JSON args from runner")
    args = p.parse_args()

    try:
        cfg = json.loads(args.json_args or "{}")
    except json.JSONDecodeError:
        cfg = {}

    keep_days = int(cfg.get("keep_days") or 7)
    cutoff = datetime.now() - timedelta(days=keep_days)

    root = Path(__file__).resolve().parents[1]
    logs_dir = root / "automation" / "logs"
    artifacts_dir = root / "automation" / "artifacts"

    deleted = []
    for d in (logs_dir, artifacts_dir):
        if not d.exists():
            continue
        for pth in d.glob("**/*"):
            if not pth.is_file():
                continue
            try:
                mtime = datetime.fromtimestamp(pth.stat().st_mtime)
            except OSError:
                continue
            if mtime < cutoff:
                try:
                    pth.unlink()
                    deleted.append(str(pth))
                except OSError:
                    pass

    print(json.dumps({"ok": True, "deleted_count": len(deleted), "keep_days": keep_days}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

import argparse
import json
from datetime import datetime, timedelta
from pathlib import Path


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--json-args", default="{}", help="JSON args from runner")
    args = p.parse_args()

    try:
        cfg = json.loads(args.json_args or "{}")
    except json.JSONDecodeError:
        cfg = {}

    keep_days = int(cfg.get("keep_days") or 7)
    cutoff = datetime.now() - timedelta(days=keep_days)

    root = Path(__file__).resolve().parents[1]
    logs_dir = root / "automation" / "logs"
    artifacts_dir = root / "automation" / "artifacts"

    deleted = []
    for d in (logs_dir, artifacts_dir):
        if not d.exists():
            continue
        for pth in d.glob("**/*"):
            if not pth.is_file():
                continue
            try:
                mtime = datetime.fromtimestamp(pth.stat().st_mtime)
            except OSError:
                continue
            if mtime < cutoff:
                try:
                    pth.unlink()
                    deleted.append(str(pth))
                except OSError:
                    pass

    print(json.dumps({"ok": True, "deleted_count": len(deleted), "keep_days": keep_days}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


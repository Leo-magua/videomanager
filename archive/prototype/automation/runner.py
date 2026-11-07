import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, Optional


def _now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _project_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _artifacts_dir() -> Path:
    d = _project_root() / "automation" / "artifacts"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _logs_dir() -> Path:
    d = _project_root() / "automation" / "logs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _read_text(p: Path) -> str:
    return p.read_text(encoding="utf-8")


def _write_jsonl(path: Path, obj: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(obj, ensure_ascii=False) + "\n")


def _safe_int(v: Any, default: int) -> int:
    try:
        return int(v)
    except Exception:
        return default


def _parse_minimal_yaml_tasks(yaml_text: str) -> Dict[str, Any]:
    """
    极简 YAML 解析（只覆盖本项目 tasks.yaml 的结构），避免引入 PyYAML 依赖。
    若你愿意加依赖，可把这里替换为 yaml.safe_load。
    """
    lines = [ln.rstrip("\n") for ln in yaml_text.splitlines()]
    tasks = []
    cur = None
    section_stack = []

    def indent_of(s: str) -> int:
        return len(s) - len(s.lstrip(" "))

    for raw in lines:
        if not raw.strip() or raw.strip().startswith("#"):
            continue
        ind = indent_of(raw)
        line = raw.strip()

        while section_stack and section_stack[-1][0] >= ind:
            section_stack.pop()

        if line.startswith("- "):
            if cur:
                tasks.append(cur)
            cur = {}
            section_stack = [(ind, cur)]
            line = line[2:].strip()
            if ":" in line:
                k, v = [x.strip() for x in line.split(":", 1)]
                cur[k] = v.strip('"')
            continue

        if cur is None:
            continue

        if ":" not in line:
            continue

        k, v = [x.strip() for x in line.split(":", 1)]
        v = v.strip()

        parent = section_stack[-1][1] if section_stack else cur
        if v == "":
            parent[k] = {}
            section_stack.append((ind, parent[k]))
        elif v.startswith("[") and v.endswith("]"):
            inner = v[1:-1].strip()
            if not inner:
                parent[k] = []
            else:
                parts = [p.strip() for p in inner.split(",")]
                parsed = []
                for p in parts:
                    p = p.strip()
                    if p.isdigit():
                        parsed.append(int(p))
                    else:
                        parsed.append(p.strip('"').strip("'"))
                parent[k] = parsed
        elif v.isdigit():
            parent[k] = int(v)
        elif v.lower() in ("true", "false"):
            parent[k] = v.lower() == "true"
        else:
            parent[k] = v.strip('"').strip("'")

    if cur:
        tasks.append(cur)

    return {"tasks": tasks}


def _http_request(method: str, url: str, timeout_seconds: int) -> Dict[str, Any]:
    # 用 curl（Windows 10+ 自带）避免额外依赖 requests
    cmd = [
        "curl",
        "-sS",
        "-o",
        "NUL",
        "-w",
        "%{http_code}",
        "--max-time",
        str(timeout_seconds),
        "-X",
        method,
        url,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    status_text = (proc.stdout or "").strip()
    status = _safe_int(status_text, 0)
    return {
        "ok": proc.returncode == 0 and status != 0,
        "returncode": proc.returncode,
        "http_status": status,
        "stderr": (proc.stderr or "").strip(),
    }


def _run_python_module(module: str, args: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    argv = [sys.executable, "-m", module]
    if args:
        argv += ["--json-args", json.dumps(args, ensure_ascii=False)]
    proc = subprocess.run(argv, capture_output=True, text=True, cwd=str(_project_root()))
    return {
        "ok": proc.returncode == 0,
        "returncode": proc.returncode,
        "stdout": (proc.stdout or "").strip(),
        "stderr": (proc.stderr or "").strip(),
    }


def _run_command(command: str, cwd: Optional[str] = None) -> Dict[str, Any]:
    proc = subprocess.run(command, capture_output=True, text=True, shell=True, cwd=cwd or str(_project_root()))
    return {
        "ok": proc.returncode == 0,
        "returncode": proc.returncode,
        "stdout": (proc.stdout or "").strip(),
        "stderr": (proc.stderr or "").strip(),
    }


@dataclass
class TaskState:
    next_run_at: datetime


def main() -> int:
    root = _project_root()
    tasks_file = root / "automation" / "tasks.yaml"
    if not tasks_file.exists():
        print(f"tasks.yaml not found: {tasks_file}")
        return 2

    cfg = _parse_minimal_yaml_tasks(_read_text(tasks_file))
    tasks = cfg.get("tasks") or []
    if not tasks:
        print("no tasks found")
        return 2

    states: Dict[str, TaskState] = {}
    journal = _logs_dir() / "runner.jsonl"

    # 首次启动：全部立即可跑
    now = datetime.now()
    for t in tasks:
        tid = t.get("id") or f"task-{len(states)+1}"
        states[tid] = TaskState(next_run_at=now)

    print(f"[{_now_iso()}] runner started, tasks={len(tasks)}, root={root}")

    while True:
        loop_now = datetime.now()
        sleep_seconds = 5

        for t in tasks:
            tid = t.get("id") or ""
            if not tid:
                continue
            st = states.get(tid)
            if st is None:
                st = TaskState(next_run_at=loop_now)
                states[tid] = st

            if loop_now < st.next_run_at:
                continue

            schedule = t.get("schedule") or {}
            every_minutes = _safe_int(schedule.get("every_minutes"), 60)
            st.next_run_at = loop_now + timedelta(minutes=every_minutes)

            ttype = t.get("type")
            started = _now_iso()
            result: Dict[str, Any]

            try:
                if ttype == "http":
                    req = t.get("request") or {}
                    method = str(req.get("method") or "GET")
                    url = str(req.get("url") or "")
                    timeout = _safe_int(req.get("timeout_seconds"), 5)
                    r = _http_request(method=method, url=url, timeout_seconds=timeout)
                    expect = req.get("expect_status_any_of") or []
                    if expect and r.get("http_status") not in expect:
                        r["ok"] = False
                        r["expect_status_any_of"] = expect
                    result = r
                elif ttype == "python":
                    run = t.get("run") or {}
                    module = str(run.get("module") or "")
                    args = run.get("args")
                    result = _run_python_module(module=module, args=args if isinstance(args, dict) else None)
                elif ttype == "command":
                    cmd = str(t.get("command") or "")
                    result = _run_command(cmd)
                else:
                    result = {"ok": False, "error": f"unknown task type: {ttype}"}
            except Exception as e:
                result = {"ok": False, "error": repr(e)}

            entry = {
                "ts": started,
                "task_id": tid,
                "task_name": t.get("name"),
                "type": ttype,
                "result": result,
                "next_run_at": st.next_run_at.isoformat(timespec="seconds"),
            }
            _write_jsonl(journal, entry)

            if not result.get("ok"):
                # 把需要人工/AI 介入的信息汇总到 artifacts，方便你集中一次性丢给 Kimi 处理
                fail_path = _artifacts_dir() / "needs_attention.jsonl"
                _write_jsonl(fail_path, entry)

        time.sleep(sleep_seconds)


if __name__ == "__main__":
    raise SystemExit(main())


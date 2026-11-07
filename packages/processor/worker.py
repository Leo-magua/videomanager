"""视频处理器主循环（独立部署）。

注册/复用凭证 → 循环 claim 作业 → 执行 → complete 回填。无活时轮询 + 定期心跳。
"""
from __future__ import annotations

import time

import client
import config
import runner

NODE = {"id": None, "token": None}


def _bootstrap() -> None:
    if not runner.has_ffmpeg():
        raise SystemExit("未检测到 ffmpeg/ffprobe（处理器必须有）")
    config.ensure_scratch()
    state = config.load_state()
    if state.get("nodeId") and state.get("nodeToken"):
        NODE.update(id=state["nodeId"], token=state["nodeToken"])
        try:
            client.heartbeat(NODE["id"], NODE["token"])
        except client.CoordinatorError as e:
            print(f"[processor] 心跳失败（后台重试）: {e}")
    else:
        res = client.enroll()
        NODE.update(id=res["nodeId"], token=res["nodeToken"])
        config.save_state({"nodeId": NODE["id"], "nodeToken": NODE["token"]})
        print(f"[processor] 已注册为节点 {NODE['id']}")


def main() -> None:
    _bootstrap()
    print(f"[processor] {config.NAME} 启动，轮询作业…（Ctrl-C 退出）")
    last_hb = time.time()
    while True:
        try:
            job = client.claim(NODE["id"], NODE["token"])
        except client.CoordinatorError as e:
            print(f"[processor] claim 失败: {e}")
            job = None
        if job:
            kind, mid = job.get("kind"), job.get("mediaId")
            print(f"[processor] 领到 {kind} 作业 {job.get('id')} (media={mid})")
            try:
                status, result = runner.run(NODE, job)
            except Exception as e:  # noqa: BLE001 —— 兜底，任何异常都回报 failed
                status, result = "failed", {"error": f"unexpected: {e}"}
            try:
                client.complete(NODE["id"], NODE["token"], job["id"], status, result)
                print(f"[processor]   → {status} {result}")
            except client.CoordinatorError as e:
                print(f"[processor]   complete 失败: {e}")
            continue  # 立刻领下一个
        # 无活：定期心跳 + 轮询等待
        now = time.time()
        if now - last_hb >= config.HEARTBEAT_SEC:
            try:
                client.heartbeat(NODE["id"], NODE["token"])
            except client.CoordinatorError:
                pass
            last_hb = now
        time.sleep(config.POLL_SEC)


if __name__ == "__main__":
    main()

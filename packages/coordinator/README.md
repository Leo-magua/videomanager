# 调度中心

Flask + SQLite 的资料权威与任务调度入口，默认端口 8787。

在仓库根目录安装 Python 依赖后，运行 `scripts/start-coordinator.sh`；也可在本目录自行导出环境变量后执行 `python app.py`。默认 monolith 模式内置本地文件服务和处理线程，coordinator 模式用于独立多设备部署。

关键模块：`app.py` HTTP 路由，`db.py` 数据库，`store.py` 读快照，`writes.py` 资料事务，`storage_files.py` 文件操作路由，`jobs.py` 任务，`nodes.py` 节点，`tickets.py` 短期凭证。

运行时数据在 `data/`，不要提交。独立复制本目录时，先从根目录运行 `scripts/sync-shared.sh`。

[当前架构](../../docs/architecture.md) · [部署指南](../../docs/deployment.md)

# @vm/shared —— 共享契约（S1 领域模型 + S2 协议）

前后端**唯一的类型真相来源**。改字段先改这里，两端同步。

```
shared/
├── ts/            前端(panel) 用
│   ├── domain.ts      S1 领域模型：MediaItem / Mark / Actor / ClipStatus
│   ├── protocol.ts    S2 协议：REST DTO / 模块协议(Node/Job/enroll/ticket) / Outbox 操作
│   └── index.ts       总出口
└── py/            后端(coordinator) 用
    ├── domain.py      S1（与 domain.ts 对齐，snake_case）
    ├── protocol.py    S2（含 camelCase↔snake_case 转换）
    └── __init__.py
```

> 契约用「手工镜像」保持两端一致（TS 与 Python 各一份，改字段两边都要改）。
> 调度中心通过 `coordinator/contract.py` 把 `py/` 挂成 `shared_py` 导入；连接器/处理器自包含，不依赖本包。

## 引用方式

**前端（TS）**
```ts
// 面板当前保留自己的类型镜像（src/types + src/lib/adapter.ts 的 Srv* 结构），
// 以本包 ts/ 为权威手工对齐；如接线 workspace alias 亦可直接 import：
import type { MediaItem, OutboxEntry, ServerEvent } from './ts'
```

**后端（Python，仅调度中心）**
```python
from shared_py import MediaItem, OutboxEntry, keys_to_camel
```

## 约定

- **命名**：TS 用 camelCase，Python 内部用 snake_case；JSON 传输统一 camelCase，Python 端用 `protocol.py` 的 `keys_to_camel/keys_to_snake` 在边界转换。
- **四种核心数据**：素材(Media)、标记(Mark)、演员(Actor)、片段(clip=kind:'clip')。详见 `docs/后端数据结构.md`。
- **大文件不进模型**：视频/缩略图/照片用路径字段（`filePath`/`posterPath`/`photoPath`）指向磁盘。

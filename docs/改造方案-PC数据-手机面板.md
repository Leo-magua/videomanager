> 历史设计资料；当前实现与部署请以 [当前架构](architecture.md) 和 [部署指南](deployment.md) 为准。

# 视频素材管理器 · 改造方案（PC 数据 + 手机面板 · 离线优先）

> **⚠️ 状态说明（阅读前必看）**：本文是**最初的产品/架构决策记录**，写于后端拆分之前，把后端当作单个 `server`(Flask) 包、并规划了 WebSocket 推送。
> **当前实现已演进**：① 后端已拆成三个模块（调度中心 coordinator / 数据连接器 connector / 视频处理器 processor），单机模式内嵌前两者保持行为不变；② 实时同步用的是 **revision + 轮询增量**（家用 LAN 够用），**WebSocket 未实现**（协议里保留了事件类型定义备用）。
> **要看当前后端实际形态，读《架构-模块化后端.md》**。本文保留作决策依据与离线优先设计的权威说明——这部分仍然有效。

> 目标：把现有「纯前端 + 浏览器 IndexedDB」的移动端原型（Kimi 版），改造成
> **PC 端持有数据（视频文件 + 完整数据库 + 媒体处理），手机端作为面板（只缓存元数据，视频流式播放）**。
> 手机通过 **局域网（LAN）** 或 **Tailscale** 连回 PC。
> **约束：PC 不保证常开机 → 架构必须「离线优先」，PC 离线时面板仍可浏览元数据、写入排队待同步。**

两个来源：
- **Kimi 原型**（`Kimi_Agent_视频素材管理器`）：移动优先 UI + 丰富领域模型（演员目录、标签互通、片段一等公民、评分）。→ 提供**面板 UI 与领域模型**。
- **参考仓库**（`github.com/Leo-magua/videomanager`）：Flask + MoviePy 后端 + API 客户端。→ 提供**后端地基与传输层**。

---

## 0. 选定拓扑（2026-07-31 定）

**采用「无云 · 直连精简版，10 模块」。** 依据使用画像：主力在家、电脑开着用；离线仅偶尔在手机上补点素材信息。

- **PC = 唯一权威**：SQLite 元数据 + 视频文件 + ffmpeg 算力。
- **手机 = 元数据缓存 + Outbox 离线写队列**；离线补的信息回家开机自动同步。
- **连接：家里 LAN 直连为主**；Tailscale 为可选（偶尔在外连开着的电脑），非核心。
- **阿里云中枢（Y1–Y3）延后为可选升级**：真需要「在外随时看全量 / 多设备」时增量加，不返工。第 9 节保留其设计备用。

**模块（10）**：契约 S1/S2；PC P1 文件仓 / P2 媒体处理 / P3 元数据权威库(SQLite) / P4 API+WS+连接鉴权；手机 M1 传输层 / M2 元数据缓存 / M3 Outbox / M4 UI+配对+离线态。

---

## 1. 现状快照

### Kimi 原型（面板来源）
- React 19 + Vite 7 + TS + Tailwind 3 + shadcn/ui，纯前端 SPA，移动优先（底部 Tab：素材库/演员/剪辑）。
- 数据全在浏览器 IndexedDB（`marker-studio` v3）：`meta`/`blobs`/`cloud`(mock)/`actors`/`kv`。
- 媒体处理在浏览器（canvas/MediaRecorder），是 mock。
- 领域亮点：演员⇄标签双向互通、片段带 `clipStatus`(pending/cutting/completed/failed)、评分/打点。

### 参考仓库（后端来源）
- Flask + MoviePy，单端口托管 `dist/`。已实现的可复用 API：
  - `/stream-video`：视频 **Range 流式**（`send_file conditional=True`）。
  - `/api/marks` GET/POST：打点持久化（按视频路径存）。
  - `/api/clip/segment`、`/batch-clip`：**真实剪辑**（MoviePy），支持 **NVENC GPU 编码**、CQ、线程配置。
  - `/upload`、`/register-local`：上传 / 注册本地已有文件。
  - `/api/videos/all-saved`、`/api/videos/list`、`/api/config/folders`：**素材目录白名单**浏览。
  - `/download/<filename>`：下载产物。
- 前端 `src/lib/api.ts` 已有 `API_BASE`/`apiFetch`/`streamVideoUrl` —— **可配置 base URL 的传输接缝**。
- 缺口：无 SQLite（打点按文件存 JSON）、无演员/标签领域、无鉴权、无离线、非移动面板。

**结论**：后端地基 80% 在参考仓库里；面板 UI 与领域模型在 Kimi 原型里。改造 = 两者缝合 + 补「离线优先」与「多端点连接」。

---

## 2. 目标架构

```
┌───────────────── PC（数据权威，不保证常开）─────────────────┐
│  Flask 服务（沿用参考仓库）                                  │
│   • SQLite(元数据领域库：素材/标记/演员/标签/片段)  ← 新增    │
│   • 磁盘(视频文件 / 缩略图 / 剪辑产物)                        │
│   • MoviePy + ffmpeg + NVENC(探测/缩略图/切片)  ← 复用       │
│   • REST + Range 流式 + WebSocket(进度/变更推送)  ← 补 WS    │
│   • 配对 token 鉴权  ← 新增                                  │
└───────────────────────┬─────────────────────────────────────┘
                        │  LAN(192.168.x.x)  或  Tailscale(100.x / MagicDNS)
                        │  ——— PC 离线时此链路断，面板转本地缓存 ———
┌───────────────────────┴─────────────────────────────────────┐
│                手机（面板，离线优先）                         │
│  IndexedDB(只存元数据缓存，硬需求)                            │
│  传输层(LAN↔Tailscale 探活 + 健康检查)                       │
│  Outbox 离线写队列(PC 上线后按序回放)  ← 新增                 │
│  Kimi 现有 UI(基本保留) + 离线态                             │
│  视频不落地：在线时 <video src> 直连流式；离线仅海报+占位     │
└──────────────────────────────────────────────────────────────┘
```

**权威原则**：PC 是唯一数据源；手机元数据是缓存，冲突时服务端赢。写操作走 Outbox，保证 PC 离线也能操作、上线自动追平。

---

## 3. 模块划分（后续按模块推进开发）

Monorepo：`packages/shared`、`packages/coordinator`(Python 调度中心)、`packages/connector`(数据连接器)、`packages/processor`(视频处理器)、`packages/panel`(手机前端)。

### 包 A：`shared` —— 共享契约
- **A1 领域类型**：`MediaItem/Mark/ActorEntry/ClipStatus/CloudFolder`（取自 Kimi `src/types/index.ts`）。
- **A2 API DTO**：REST 请求/响应结构（对齐参考仓库 `videoEditorClient.ts` 的接口，再扩展演员/标签）。
- **A3 WS 消息协议**：`library.changed` / `clip.progress` / `clip.done` / `clip.failed`。
- **A4 Outbox 操作协议**：离线写操作的规范化格式（op 类型 + 载荷 + 单调 seq + 幂等 key）。

### 包 B：`server`（PC 端，Flask，沿用参考仓库）
- **B1 持久化层**：**新增 SQLite** 领域库（素材/标记/演员/标签/片段），替代参考仓库的「按文件 JSON 打点」；磁盘存视频/缩略图/产物。
- **B2 媒体处理**（**复用**）：MoviePy/ffmpeg/NVENC —— 探测、缩略图、切片、GPU 导出。参考仓库 `_process_single_segment`、`batch_clip`、`ExportSettings` 直接用。
- **B3 API 层**：REST（复用 marks/clip/upload/stream；**新增**演员/标签/评分/片段 CRUD）+ Range 流式（复用 `/stream-video`）+ **新增 WebSocket** 推送（替代 Kimi 的 1.5s 轮询）。
- **B4 业务域**（**新增**）：演员⇄标签互通、片段生命周期、改名同步子片段——从 Kimi `store/library.tsx` 上移为服务端权威。
- **B5 连接与鉴权**（**新增**）：绑 `0.0.0.0`；兼容 Tailscale（同一 HTTP 端点，仅主机名不同）；配对 token（LAN/Tailscale 都在网络暴露，必须鉴权）；启动输出连接地址 + 二维码；`/healthz` 健康探针（供面板探活）。

### 包 C：`panel`（手机端，Kimi UI 改造，离线优先）
- **C1 传输层**（**扩参考 `api.ts`**）：多候选端点（LAN IP / Tailscale 名），健康探活优先 LAN、回退 Tailscale；断线重连、在线/离线状态机；WS 客户端。
- **C2 元数据缓存**（**硬需求**）：手机 IndexedDB **只存 meta**（不存 blob），含海报小图；启动即从缓存渲染；在线时按 `updatedAt` 增量同步。
- **C3 状态 store**（改造 Kimi `store/library.tsx`）：数据源改为「缓存 + 传输层」；**删 1.5s 轮询**改 WS；对上层组件接口尽量不变，降低 UI 改动。
- **C4 Outbox 离线写队列**（**新增**）：所有写操作乐观更新本地缓存 + 入队；PC 上线按 seq 回放，服务端 ack 后清「待同步」角标；剪辑请求离线时落 `clipStatus:'pending'`，PC 醒来执行。
- **C5 界面**：Kimi `sections/*`、`components/*` **基本保留**；改动点：播放从 `objectURL(blob)`→流式 URL；导入从「写本地 blob」→「上传 PC」；新增**离线态/待同步**视觉。
- **C6 配对与连接设置**（**新增**）：输入/扫码 PC 地址，测连通，记忆 LAN + Tailscale 双端点；离线时提示 + （可选）Wake-on-LAN 唤醒入口。

---

## 4. 离线优先设计（应对 PC 不常开机）

| 场景 | 行为 |
|---|---|
| 启动（PC 状态未知） | 立即用 C2 缓存渲染全部元数据；后台探活 PC |
| PC 在线 | 增量同步元数据；flush Outbox；视频可流式播放；剪辑实时执行 + WS 进度 |
| PC 离线 | 顶部「PC 离线」条；元数据照常浏览；写操作乐观生效 + 入 Outbox；视频区显示海报 + 「PC 离线，暂不可播」；新剪辑落 `pending` |
| PC 由离线→上线 | 自动 flush Outbox（按 seq、幂等），服务端权威落库并回推最新态；`pending` 剪辑开始执行；清「待同步」角标 |
| 冲突 | 服务端赢；被覆盖的本地改动给出提示（保留最小可撤销信息） |
| 唤醒 PC（可选进阶） | 同 LAN：Wake-on-LAN 魔法包（浏览器不能直发，需常开小盒子/路由器中转）；Tailscale 跨网唤醒较难，列为后续 |

**关键对齐**：Kimi 模型已有的 `clipStatus:'pending'` 天然承载「离线排队的剪辑」，无需新造状态。

---

## 5. 关键设计决策

| 议题 | 决策 | 理由 |
|---|---|---|
| 后端语言 | **Python/Flask（沿用参考仓库）** | 已有 GPU 剪辑/Range 流式/打点/上传，重写 Node 是浪费 |
| PC 元数据存储 | **SQLite（新增）** | 领域比参考仓库丰富（演员/标签/片段），JSON 撑不住；事务、可查询 |
| 视频存储 | 磁盘 + Range 流式（复用） | 大文件不进库；Range 让手机拖进度秒开、省流量 |
| 手机存什么 | **只存元数据**（含海报小图） | 你的核心诉求 + 离线浏览硬需求 |
| 同步策略 | 服务端权威 + Outbox 回放 | 单数据源；离线可写、上线追平 |
| 实时性 | WebSocket（新增） | 取代 Kimi 轮询；剪辑进度真实推送 |
| 连接 | LAN 优先，Tailscale 回退 | 同一 HTTP API，探活自动切 |
| 鉴权 | 配对 token（首次扫码） | LAN/Tailscale 均网络可达，必须鉴权 |
| 离线可用性 | **离线优先（硬需求）** | PC 不常开机 |

---

## 6. 现有代码去留映射

| 来源文件 | 去向 |
|---|---|
| Kimi `src/types/index.ts` | → `shared` A1（前后端共用） |
| Kimi `src/lib/db.ts` | 手机侧瘦身为「只存 meta」缓存(C2)；PC 侧被 SQLite(B1) 取代 |
| Kimi `src/lib/media.ts` | 废弃（浏览器 mock）；改用参考仓库服务端 MoviePy(B2) |
| Kimi `src/store/library.tsx` | 逻辑上移服务端(B4)；手机侧改为 缓存+传输+Outbox 的薄封装(C3/C4) |
| Kimi `src/sections/*`、`components/*`、`components/ui/*` | **基本保留**(C5) |
| 参考 `server/app.py` | → B 后端地基；补 SQLite/演员标签/WS/鉴权 |
| 参考 `src/lib/api.ts` | → C1 传输层种子，扩多端点探活 |
| 参考 `src/api/videoEditorClient.ts` | → C1/C3 客户端封装 |
| 参考 `src/hooks/useClipQueue.ts`、`ClipQueuePanel.tsx` | → 剪辑队列/进度 UI 参考 |
| 参考 `ExportSettingsPanel.tsx` | → GPU 导出设置 |
| 参考 `automation/*` | → PC 侧后台任务/自测（可选） |

---

## 7. 分阶段开发路线（每阶段可独立验证）

> 因后端地基已存在，重心在「缝合 + 离线优先 + 领域扩展」。

- **阶段 0 · 骨架与契约**：建 monorepo；抽 `shared`(A1–A4)；参考仓库后端跑起来、Kimi 前端照旧跑（暂不联动）。
- **阶段 1 · SQLite 领域库 + 读 API**：B1 建库并从 Kimi seed 灌数据；B3 只读接口（列素材/元数据/流式播放，复用 `/stream-video`）。验证：浏览器访问 PC 能列素材、播视频。
- **阶段 2 · 面板接管读路径 + 缓存**：C1 传输层（含健康探针）+ C2 元数据缓存 + C3 store 改造。验证：手机浏览 PC 素材库/演员/片段并流式播放；**拔网线仍能浏览元数据**。
- **阶段 3 · 写路径 + Outbox**：打点/评分/标签/演员互通/改名走 API(B4)；C4 Outbox。验证：**PC 离线时手机打点→入队；PC 上线→自动落库**；WS 实时同步到第二设备。
- **阶段 4 · 剪辑闭环**：接参考仓库 `/batch-clip`+MoviePy(B2)；离线排 `pending`、上线执行、WS 进度。验证：手机选区间→PC 出片段文件。
- **阶段 5 · 连接与鉴权**：B5 + C6——配对 token、二维码、LAN/Tailscale 探活回退、离线态 UI、（可选）WoL 入口。验证：换 WiFi / 走 Tailscale 都能连且需配对。
- **阶段 6 · 打磨**：增量同步、冲突提示、导入去重（迁移 Kimi 逻辑）、上传断点续传。

---

## 9. 阿里云三层拓扑与数据分布（可选后续，非当前选定）

> 当前选定「无云直连版」（见第 0 节）。本节保留云中枢设计，供日后需要「在外随时看全量 / 多设备」时增量升级。

引入常开的阿里云服务器，专职「元数据中枢」（不存大视频），化解「PC 不常开机」：手机永远只跟阿里云同步元数据，PC 醒来再与阿里云对账；**手机与 PC 无需同时在线**。

### 数据分布

| 数据 | 体量 | PC(间歇) | 阿里云(常开) | 手机(面板) |
|---|---|---|---|---|
| 元数据(素材/标记/演员/标签/评分/片段区间) | 小KB | 本地镜像(SQLite) | **权威+同步中枢** | 只读缓存 |
| 海报/缩略图 | ~几十KB | 生成源 | 缓存(常开可见) | 缓存(离线可见) |
| 演员照片 | 小 | 存 | 缓存 | 缓存 |
| 视频文件本体 | 大MB-GB | **唯一权威** | 不存(可选中继) | 不存(流式) |
| 剪辑产物 | 大 | 权威 | 不存 | 不存(流式/下载) |
| 处理任务队列 | 小 | 执行者 | 队列存储 | 提交者 |
| Outbox 写操作 | 小 | 消费 | 暂存中转 | 产生 |

原则：小数据三层皆有、阿里云权威；大数据只在 PC；手机永不落视频。

### 模块总表（13 个 = S2 + Y3 + P4 + M4；不采云则去 Y 层 = 10 个）

**契约 shared**：S1 领域模型（TS+Python 双语）；S2 协议（REST DTO + WS 事件 + Outbox 格式）。
**阿里云中枢（常开）**：Y1 元数据权威库(PG/MySQL)；Y2 同步中枢 API(增量同步/Outbox/WS 广播)；Y3 会合与中继(PC 地址登记/视频中继/唤醒信号)。
**PC(沿用 Flask)**：P1 文件仓(磁盘+Range 流式)；P2 媒体处理(ffmpeg/MoviePy/NVENC)；P3 本地元数据镜像(SQLite，与 Y1 对账)；P4 任务执行器+连接鉴权。
**手机面板**：M1 传输层(多端点探活/状态机/WS)；M2 元数据缓存(IndexedDB 只存 meta+海报)；M3 Outbox 写队列；M4 UI/配对/离线态(复用 Kimi)。

> 不采用阿里云时：元数据权威退回 PC(P3)，手机靠 M2 缓存 + M3 Outbox 等 PC 上线；Y 层职责并入「PC 直连」，代价是手机与 PC 必须先后在线才能追平。

---

## 8. 待确认 / 风险点

1. **「Telnet」= Tailscale** 已按此理解；若真是裸 Telnet/TCP 请纠正（不适合传视频）。
2. **PC 唤醒**：WoL 需要常开中转设备；你是否有 NAS/路由器/树莓派可常驻？否则默认「PC 自己开机后追平」。
3. **PC 服务常驻形态**：开机自启 / 托盘 / 手动？影响 B5 交付。
4. **手机 App 形态**：手机浏览器(PWA) 还是原生壳(Capacitor，便于扫码/后台/WoL)？
5. **上传大文件**：LAN 可行；Tailscale 看带宽，是否要断点续传。
6. **多设备并发看板**：是否多手机同时用（影响 WS 广播与冲突）。
7. **参考仓库鉴权缺失**：现为素材目录白名单、无 token；对外暴露前必须补 B5 鉴权。

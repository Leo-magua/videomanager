// S2 协议（TypeScript）
// REST 请求/响应 DTO + WebSocket 事件 + Outbox 离线写操作格式。
// 与 Python 版 protocol.py 严格对齐。
import type { Actor, ClipStatus, Mark, MediaItem, Node, NodeKind, Storage } from './domain'

// ============================================================
// REST 接口 DTO
// ============================================================

/** 通用响应包裹 */
export interface ApiResult<T> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

/** GET /api/library —— 全量元数据快照（手机首次同步/缓存重建） */
export interface LibrarySnapshot {
  media: MediaItem[]
  /** 打点独立成表；面板按 mediaId 归拢到各素材 */
  marks: Mark[]
  actors: Actor[]
  /** 已登记的存储设备（登记引用） */
  storages: Storage[]
  /** 服务端当前逻辑时钟，用于增量同步 */
  revision: number
}

/** GET /api/library/delta?since=<revision> —— 增量同步 */
export interface LibraryDelta {
  upsertMedia: MediaItem[]
  deleteMediaIds: string[]
  /** 变更/新增的打点（按 mediaId 覆盖归拢） */
  upsertMarks: Mark[]
  deleteMarkIds: string[]
  upsertActors: Actor[]
  deleteActorNames: string[]
  revision: number
}

/** POST /api/media/:id/rename */
export interface RenameRequest { name: string }

/** POST /api/media/:id/marks —— 新增打点（服务端补 id/color/createdAt） */
export interface AddMarkRequest { time: number; label?: string; note?: string }

/** POST /api/media/:id/tags —— 覆盖式设置标签（触发演员标签互通写回） */
export interface SetTagsRequest { tags: string[] }

/** POST /api/media/:id/cast —— 增删关联演员 */
export interface SetCastRequest { cast: string[] }

/** POST /api/clips —— 请求切片段（PC 在线立即执行；离线落 pending） */
export interface CreateClipRequest {
  parentId: string
  rangeStart: number
  rangeEnd: number
  name: string
}

/** 视频流式播放 URL（前端拼接，走 HTTP Range） */
export const streamPath = (id: string) => `/api/media/${id}/stream`
/** 缩略图/海报 URL */
export const posterPath = (id: string) => `/api/media/${id}/poster`

/** GET /healthz —— 面板探活 */
export interface HealthResponse { ok: true; revision: number; version: string }

// ============================================================
// 存储设备管理（在线操作，不入 Outbox —— 登记引用需后端直达磁盘）
// ============================================================

/** POST /api/storages —— 注册一个存储设备并触发扫描登记 */
export interface AddStorageRequest {
  /** 后端可直达的绝对目录路径 */
  path: string
  /** 显示名（省略则取目录名） */
  name?: string
  kind?: import('./domain').StorageKind
  /** 目标设备节点 id；省略/loopback=调度中心本机，否则登记到该远程连接器上 */
  nodeId?: string | null
}

/** GET /api/storages —— 返回带 scanning 标记的存储列表 */
export type ListStoragesResponse = Storage[]

/** 存储设备相关 URL */
export const storagesPath = () => `/api/storages`
export const rescanPath = (id: string) => `/api/storages/${id}/rescan`

// ============================================================
// 设备（节点）列表 + 配对加设备
// ============================================================

/** GET /api/nodes —— 当前接入的设备（含 loopback 本机），带角色与在线态 */
export type ListNodesResponse = Node[]
export const nodesPath = () => `/api/nodes`

/** GET /api/enroll-info —— 已配对手机取 enroll 凭证，转交给待配对连接器 */
export interface EnrollInfoResponse {
  coordinatorUrl: string
  enrollToken: string
}
export const enrollInfoPath = () => `/api/enroll-info`

/** POST {connectorBaseUrl}/api/pair —— 手机把配对好的连接器接入调度中心（连接器侧接口） */
export interface ConnectorPairRequest {
  code: string
  coordinatorUrl: string
  enrollToken: string
  roots?: string[]
}
export interface ConnectorPairResponse {
  ok: boolean
  nodeId?: string
}

// ============================================================
// 模块拆分：节点 enroll/heartbeat、作业队列、扫描上报、智能串流定位
// 只有调度中心拥有 DB；连接器/处理器通过以下 DTO 经 HTTP 与调度中心通信。
// ============================================================

export type JobKind = 'probe' | 'thumbnail' | 'clip'
export type JobStatus = 'queued' | 'claimed' | 'running' | 'completed' | 'failed'

export interface Job {
  id: string
  kind: JobKind
  status: JobStatus
  mediaId?: string | null
  /** 源文件所属连接器节点 */
  nodeId?: string | null
  payload: Record<string, unknown>
  result?: Record<string, unknown> | null
  attempts: number
  createdAt: number
  updatedAt: number
}

/** POST /api/nodes/enroll —— 连接器/处理器上线注册（用 enrollment token 鉴权） */
export interface EnrollRequest {
  kind: NodeKind
  name?: string
  baseUrl?: string | null
  capabilities?: { hasFfmpeg?: boolean }
  /** 连接器登记的绝对根路径列表 */
  roots?: string[]
}
export interface EnrollResponse {
  nodeId: string
  /** 后续调用的 Bearer；服务端只存哈希 */
  nodeToken: string
  /** 该节点签流 ticket 的 HMAC 密钥 */
  streamKey: string
  revision: number
  /** 连接器各 root 对应的存储 id（与请求 roots 对齐） */
  storageIds?: string[]
}

export interface HeartbeatRequest {
  nodeId: string
  online?: boolean
  roots?: string[]
  capabilities?: { hasFfmpeg?: boolean }
}
export interface HeartbeatResponse {
  revision: number
  /** 有多少可领作业 */
  pendingJobHint: number
}

export interface ScanReportItem {
  relPath: string
  size: number
  mtime: number
}
/** 连接器 walk 完一个根后上报候选文件 */
export interface ScanReportRequest {
  nodeId: string
  /** 存储 id */
  rootId: string
  items: ScanReportItem[]
  done?: boolean
}
export interface ScanReportResponse {
  accepted: number
  newMediaIds: string[]
}

export interface ClaimRequest {
  nodeId: string
  kinds: JobKind[]
}
export interface ClaimResponse {
  /** 一个 Job（含 payload：源 directUrl + ticket 等）；null=无活 */
  job: Job | null
}

/** POST /api/jobs/:id/complete —— 处理器回填结果 */
export interface CompleteRequest {
  status: 'completed' | 'failed'
  result?: Record<string, unknown>
}

/** GET /api/media/:id/stream-locate —— 智能串流：先直连连接器，连不上回落代理 */
export interface StreamLocateResponse {
  nodeId: string
  /** 连接器直连地址（带签名 ticket） */
  directUrl: string
  /** 调度中心代理转发地址（回落） */
  proxyUrl: string
  ticket: string
  expiresAt: number
}

// 模块 API 路径（与 py 镜像）
export const streamLocatePath = (id: string) => `/api/media/${id}/stream-locate`
export const nodeEnrollPath = () => `/api/nodes/enroll`
export const heartbeatPath = () => `/api/nodes/heartbeat`
export const scanReportPath = () => `/api/nodes/scan-report`
export const jobClaimPath = () => `/api/jobs/claim`
export const jobCompletePath = (id: string) => `/api/jobs/${id}/complete`
export const posterUploadPath = (id: string) => `/api/media/${id}/poster`
// 连接器侧路径（ticket 鉴权，不在调度中心）
export const filesStreamPath = () => `/files/stream`
export const filesUploadPath = () => `/files/upload`

// ============================================================
// WebSocket 事件（服务端 → 面板推送，取代轮询）
// ============================================================

export type ServerEvent =
  | { type: 'library.changed'; revision: number }
  | { type: 'media.upserted'; item: MediaItem }
  | { type: 'media.deleted'; id: string }
  | { type: 'actor.upserted'; actor: Actor }
  | { type: 'clip.progress'; id: string; status: ClipStatus; percent: number }
  | { type: 'clip.done'; item: MediaItem }
  | { type: 'clip.failed'; id: string; reason: string }

// ============================================================
// Outbox 离线写操作（面板离线时入队，PC 上线按 seq 回放）
// ============================================================

/** 每个写操作对应一种 op；载荷复用上面的 REST 请求体 */
export type OutboxOp =
  | { kind: 'media.rename'; mediaId: string; payload: RenameRequest }
  | { kind: 'media.setRating'; mediaId: string; payload: { rating: number } }
  | { kind: 'media.setTags'; mediaId: string; payload: SetTagsRequest }
  | { kind: 'media.setCast'; mediaId: string; payload: SetCastRequest }
  | { kind: 'mark.add'; mediaId: string; payload: AddMarkRequest }
  | { kind: 'mark.update'; mediaId: string; markId: string; payload: Partial<Mark> }
  | { kind: 'mark.remove'; mediaId: string; markId: string }
  | { kind: 'clip.create'; payload: CreateClipRequest }
  | { kind: 'actor.upsert'; payload: Actor }

/** 队列条目：单调 seq 保序，opId 幂等去重 */
export interface OutboxEntry {
  /** 幂等键（客户端生成，服务端据此去重） */
  opId: string
  /** 单调递增序号，回放按此排序 */
  seq: number
  op: OutboxOp
  /** 乐观写入本地缓存的时间 */
  createdAt: number
}

/** POST /api/outbox/flush —— 面板上线批量回放；服务端返回处理结果 + 最新 delta */
export interface FlushRequest { entries: OutboxEntry[] }
export interface FlushResponse {
  /** 已成功处理（可从队列清除）的 opId */
  ackedOpIds: string[]
  /** 冲突/失败的 opId 及原因（服务端权威，客户端据此提示） */
  rejected: Array<{ opId: string; reason: string }>
  /** 回放后最新增量，供面板刷新缓存 */
  delta: LibraryDelta
}

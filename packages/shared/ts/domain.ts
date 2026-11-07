// S1 领域模型（TypeScript）
// 与《后端数据结构》文档、Python 版 domain.py 严格对齐。
// 四种核心数据：素材(Media) / 标记(Mark) / 演员(Actor) / 片段(Clip=kind:'clip' 的 Media)

/** 素材类别：source 原始素材 / clip 剪辑片段 */
export type MediaKind = 'source' | 'clip'

/** 剪辑执行状态；离线排队的剪辑为 pending，PC 开机后执行 */
export type ClipStatus = 'pending' | 'cutting' | 'completed' | 'failed'

/** 标记：挂在素材某个时间点上的打点，独立于文件（改名/换文件不影响） */
export interface Mark {
  id: string
  /** 属于哪条素材 */
  mediaId: string
  /** 时间点（秒），如 83.5 = 1:23.5 */
  time: number
  label: string
  /** 颜色（6 色轮换） */
  color: string
  note?: string
  createdAt: number
}

/** 演员三维评分（各 0–5） */
export interface ActorRating {
  /** 身材 */ figure: number
  /** 颜值 */ looks: number
  /** 演技 */ acting: number
}

/** 演员：全库共享目录，name 为主键。携带标签，与素材双向互通（见 S2 outbox 协议） */
export interface Actor {
  /** 演员名（主键，全局唯一） */
  name: string
  /** 携带的标签（“标签背包”） */
  tags: string[]
  ratings?: ActorRating
  bio?: string
  /** 照片文件路径（相对 data/actors/），非 base64 */
  photoPath?: string
  updatedAt: number
}

/**
 * 素材 / 片段。片段 = kind:'clip'，比原始素材多 parentId/range*/clipStatus。
 * 大文件不进 DB：视频用 filePath 指向磁盘，缩略图用 posterPath 指向磁盘。
 */
export interface MediaItem {
  id: string
  /** 显示名（= 文件名，可改） */
  name: string
  kind: MediaKind
  /** 时长（秒），未下载为 0 */
  duration: number
  /** 文件大小（字节） */
  size: number
  mime: string
  /** 缩略图/海报文件路径（相对 data/thumbs/） */
  posterPath?: string
  /** 星级 0–5 */
  rating: number
  /** 标签 */
  tags: string[]
  /** 关联演员名 */
  cast: string[]
  year?: string
  synopsis?: string
  /** 归属文件夹（斜杠分层，如 "电影/科幻"）；空串=根 */
  folder: string
  /** 视频文件是否已在本地（false=有信息、文件未下载） */
  hasFile: boolean
  /** 视频在 PC 磁盘的路径（相对 data/videos|clips/，或相对某存储根）；未下载为 null */
  filePath?: string | null
  originalPath?: string | null
  sourceKind?: 'local' | 'remote' | 'nas' | 'cloud'
  storageName?: string | null
  /** 所属存储设备 id（登记引用的外部存储）；null=内建 data/ 目录 */
  storageId?: string | null

  // ===== 仅片段(clip) =====
  /** 从哪条素材切出 */
  parentId?: string
  /** 母素材名（母素材改名会同步） */
  parentName?: string
  /** 区间起点（秒） */
  rangeStart?: number
  /** 区间终点（秒） */
  rangeEnd?: number
  clipStatus?: ClipStatus

  createdAt: number
  updatedAt: number
}

/** 素材来源判定：本地=已下载文件；未下载=仅有元数据 */
export function hasLocalFile(item: MediaItem): boolean {
  return item.hasFile && !!item.filePath
}

/** 存储设备类型：本机目录 / 网络存储 / 远程 */
export type StorageKind = 'local' | 'nas' | 'remote'

/**
 * 存储设备：后端是唯一大脑，视频文件可散在多个存储上（登记引用，不搬动）。
 * 部分存储可能离线，此时其下素材元数据仍可浏览，但流式播放会返回 storage_offline。
 */
export interface Storage {
  id: string
  /** 显示名 */
  name: string
  kind: StorageKind
  /** 后端可直达的绝对根路径 */
  rootPath: string
  /** 当前是否在线（根目录可达） */
  online: boolean
  /** 是否正在扫描登记（仅 GET /api/storages 附带） */
  scanning?: boolean
  /** 持有该存储的连接器节点 id；null=调度中心本地(loopback) */
  nodeId?: string | null
  addedAt: number
}

// ============================================================
// 模块拆分：节点（连接器 / 处理器）
// ============================================================

/** 节点类别：connector 持有文件并串流；processor 跑 ffmpeg 探测/缩略图/剪辑 */
export type NodeKind = 'connector' | 'processor'

/** 节点能力声明（连接器一般 hasFfmpeg=false，处理器为 true） */
export interface NodeCapabilities {
  hasFfmpeg: boolean
}

/**
 * 模块拆分后的节点。只有调度中心拥有 DB；节点通过 HTTP enroll/heartbeat/回调，
 * 绝不直接写库。token 不进该对象（仅 enroll 响应下发一次，服务端只存哈希）。
 */
export interface Node {
  id: string
  kind: NodeKind
  name: string
  online: boolean
  /** 连接器对外可达地址（直连串流用） */
  baseUrl?: string | null
  lastSeen?: number | null
  capabilities: NodeCapabilities
  /** 连接器持有的存储（id + 显示名），供设置页展开设备下挂的目录 */
  roots: NodeRoot[]
  enrolledAt: number
  /** 是否为调度中心本机(loopback)：兼具存储 + 处理器角色，恒在线 */
  isCoordinator?: boolean
}

/** 节点下挂的一个存储引用（设备卡展开用） */
export interface NodeRoot {
  id: string
  name: string
}

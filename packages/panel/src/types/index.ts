// 数据模型：标记与素材绑定（mark 挂在 MediaItem 上，重命名/换文件不影响标记）

export type MediaKind = 'source' | 'clip'

export interface Mark {
  id: string
  /** 秒 */
  time: number
  label: string
  color: string
  note?: string
  createdAt: number
}

export interface MediaItem {
  id: string
  /** 显示名 = 文件名，可重命名 */
  name: string
  kind: MediaKind
  /** 秒；无本地文件时为 0 */
  duration: number
  /** 字节 */
  size: number
  mime: string
  /** 海报/缩略图 dataURL */
  poster?: string
  /** 0-5 星 */
  rating: number
  tags: string[]
  marks: Mark[]
  createdAt: number
  updatedAt: number
  /** 是否已绑定本地文件（素材在云盘、尚未下载到本地时为 false） */
  hasFile: boolean
  /** 关联的云端记录 id（素材与云盘文件的对应关系） */
  filePath?: string | null
  originalPath?: string | null
  sourceKind?: 'local' | 'nas' | 'remote' | 'cloud'
  storageName?: string | null
  cloudId?: string
  /** 归属文件夹（斜杠分层，如「电影/科幻」）；PC 后端下发 */
  folder?: string
  /** 归属存储设备 id；PC 后端下发（NULL=调度中心本地内建资产）。侧边栏按此分组。 */
  storageId?: string | null

  // 电影类素材
  cast?: string[]
  year?: string
  synopsis?: string

  // 剪辑产物
  parentId?: string
  parentName?: string
  rangeStart?: number
  rangeEnd?: number
  /** 剪辑执行状态（仅片段；缺省视为已完成） */
  clipStatus?: ClipStatus
}

/** 剪辑执行状态：completed 已剪辑 / cutting 剪辑中 / failed 剪辑失败 / pending 待剪辑 */
export type ClipStatus = 'completed' | 'cutting' | 'failed' | 'pending'

export const MARK_COLORS = [
  '#f43f5e', // 红
  '#f59e0b', // 橙
  '#22c55e', // 绿
  '#3b82f6', // 蓝
  '#a855f7', // 紫
  '#ec4899', // 粉
]

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36)

export function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0
  const s = Math.floor(sec % 60)
  const m = Math.floor(sec / 60) % 60
  const h = Math.floor(sec / 3600)
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

export function formatSize(bytes: number): string {
  if (!bytes) return ''
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

// ===== 云端-本地联动 =====
/** 云端记录：代表云盘中的对应文件（模拟云盘元数据层，接入真实云盘 API 时替换实现即可） */
export interface CloudRecord {
  id: string
  /** 云端文件名 */
  name: string
  /** 关联的素材 id */
  itemId: string
  /** 云盘文件夹路径段，如 ['电影', '科幻']；空数组 = 根目录 */
  folder: string[]
  /** 云端侧是否仍存在（本地删除且保留云端时不受影响；云端删除后为 false） */
  exists: boolean
  updatedAt: number
}

// ===== 全局互通协议：演员 / 标签 =====
/** 演员目录：演员携带标签，全库共享。
 * 规则：把演员添加到任一视频 → 演员已有标签自动并入该视频；
 * 在任一视频上为该演员新增标签 → 写回目录，之后添加到其他视频时自动携带。 */
export interface ActorRating {
  /** 身材 */ figure: number
  /** 颜值 */ looks: number
  /** 演技 */ acting: number
}

export interface ActorEntry {
  name: string
  tags: string[]
  /** 照片 dataURL */
  photo?: string
  /** 三维评分（0-5 星） */
  ratings?: ActorRating
  /** 介绍 */
  bio?: string
  updatedAt: number
}

/** 素材来源：本地 = 已下载到本设备；云端 = 云盘中有记录 */
export function sourceOf(item: MediaItem): 'local' | 'cloud' {
  return item.sourceKind === 'remote' || item.sourceKind === 'cloud' || item.sourceKind === 'nas' || !item.hasFile ? 'cloud' : 'local'
}

/** 云端文件夹视图节点 */
export interface CloudFolder {
  name: string
  path: string[]
}

export interface FileEntry {
  name: string
  path: string
  kind: 'directory' | 'file'
  isVideo: boolean
  size: number
}
export interface DirectoryListing {
  path: string
  entries: FileEntry[]
  directoryCount: number
  fileCount: number
}

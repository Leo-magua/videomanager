// 服务端 DTO ⇄ 面板 MediaItem 适配。
// 服务端：marks 独立成表、poster/file 是磁盘相对路径、hasFile=PC 上有文件。
// 面板：marks 内嵌在 item、poster 是可显示 URL、hasFile 语义沿用（有文件=可播放）。
import type { ActorEntry, MediaItem, Mark } from '@/types'
import { transport } from '@/lib/transport'

// 服务端返回的 media（camelCase），marks 分离
export interface SrvMedia {
  id: string
  name: string
  kind: 'source' | 'clip'
  duration: number
  size: number
  mime: string
  posterPath?: string | null
  rating: number
  tags: string[]
  cast: string[]
  year?: string
  synopsis?: string
  folder: string
  hasFile: boolean
  filePath?: string | null
  originalPath?: string | null
  sourceKind?: MediaItem['sourceKind']
  storageName?: string | null
  storageId?: string | null
  parentId?: string
  parentName?: string
  rangeStart?: number
  rangeEnd?: number
  clipStatus?: MediaItem['clipStatus']
  createdAt: number
  updatedAt: number
}

export interface SrvMark {
  id: string
  mediaId: string
  time: number
  label: string
  color: string
  note?: string | null
  createdAt: number
}

export interface SrvActor {
  name: string
  tags: string[]
  ratings?: { figure: number; looks: number; acting: number }
  bio?: string | null
  photoPath?: string | null
  updatedAt: number
}

/** 存储设备（登记引用的真实 PC 目录），与后端 Storage 契约对齐 */
export interface SrvStorage {
  id: string
  name: string
  kind: 'local' | 'nas' | 'remote'
  rootPath: string
  online: boolean
  scanning?: boolean
  /** 持有该存储的连接器节点 id；null=调度中心本机(loopback) */
  nodeId?: string | null
  addedAt: number
}

/** 节点下挂的存储引用（设备卡展开用） */
export interface SrvNodeRoot {
  id: string
  name: string
}

/** 接入的设备（连接器 / 处理器 / 调度中心本机），与后端 Node 契约对齐 */
export interface SrvNode {
  id: string
  kind: 'connector' | 'processor'
  name: string
  online: boolean
  baseUrl?: string | null
  lastSeen?: number | null
  capabilities: { hasFfmpeg: boolean }
  roots: SrvNodeRoot[]
  enrolledAt: number
  /** 是否为调度中心本机(loopback)：兼具存储 + 处理器角色 */
  isCoordinator?: boolean
}

/** 把服务端 media + marks 合成面板 MediaItem。 */
export function toMediaItem(m: SrvMedia, marks: SrvMark[]): MediaItem {
  return {
    id: m.id,
    name: m.name,
    kind: m.kind,
    duration: m.duration,
    size: m.size,
    mime: m.mime,
    // 面板用 poster 显示；有海报就指向服务端 URL（离线时 <img> 加载失败自动隐藏）
    poster: m.posterPath ? transport.posterUrl(m.id) : undefined,
    rating: m.rating,
    tags: m.tags ?? [],
    marks: marks
      .filter((k) => k.mediaId === m.id)
      .map<Mark>((k) => ({
        id: k.id,
        time: k.time,
        label: k.label,
        color: k.color,
        note: k.note ?? undefined,
        createdAt: k.createdAt,
      }))
      .sort((a, b) => a.time - b.time),
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    hasFile: m.hasFile,
    filePath: m.filePath,
    originalPath: m.originalPath,
    sourceKind: m.sourceKind,
    storageName: m.storageName,
    // 手机侧：folder 作为「云盘」路径来源；cloudId 复用为「PC 有此文件」标记之外的占位
    cast: m.cast ?? [],
    year: m.year,
    synopsis: m.synopsis,
    parentId: m.parentId,
    parentName: m.parentName,
    rangeStart: m.rangeStart,
    rangeEnd: m.rangeEnd,
    clipStatus: m.clipStatus,
    // folder 存到 item 上，供库页构建目录树（扩展字段）
    folder: m.folder,
    // storageId 供侧边栏按登记的存储目录分组
    storageId: m.storageId ?? null,
  } as MediaItem & { folder: string }
}

export function toActorEntry(a: SrvActor): ActorEntry {
  return {
    name: a.name,
    tags: a.tags ?? [],
    ratings: a.ratings,
    bio: a.bio ?? undefined,
    photo: a.photoPath ?? undefined,
    updatedAt: a.updatedAt,
  }
}

// M3 store：面板数据源从 IndexedDB 假数据切换为 PC 后端。
// 设计：保持 useLibrary() 接口不变（各 section 组件零改动）。
//   - 读：启动探活 → 在线拉快照写入缓存；离线用缓存（离线优先）。
//   - 写：乐观改缓存 + 入 Outbox 队列 + 在线立即 flush；离线留队列，上线回放。
//   - 视频：objectURL 返回 PC 流式 URL；poster 指向 PC。
// 手机侧「本地/云盘」语义：本地=PC 已有文件(hasFile)，云盘=按 folder 浏览全部素材。
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { db } from '@/lib/db'
import { transport } from '@/lib/transport'
import { deleteBatch, type BatchDeleteResult, type DeleteProgress } from '@/lib/batch-delete'
import { toActorEntry, toMediaItem } from '@/lib/adapter'
import type { SrvActor, SrvMedia, SrvMark, SrvNode, SrvStorage } from '@/lib/adapter'
import type { OutboxEntry, OutboxOp } from '@/lib/outboxTypes'
import { uid } from '@/types'
import type { ActorEntry, CloudRecord, Mark, MediaItem } from '@/types'

interface Snapshot {
  media: SrvMedia[]
  marks: SrvMark[]
  actors: SrvActor[]
  storages?: SrvStorage[]
  revision: number
}

export interface ConnectionState {
  online: boolean
  paired: boolean
  baseUrl: string | null
  pendingWrites: number
  lastSync: number | null
  pair: (base: string, code: string) => Promise<{ ok: boolean; error?: string }>
  reconnect: () => Promise<boolean>
  streamUrl: (id: string) => Promise<string>
  unpair: () => void
  // 存储设备管理（在线操作，直连后端，不入 Outbox）
  storages: SrvStorage[]
  addStorage: (path: string, name?: string, nodeId?: string | null) => Promise<{ ok: boolean; error?: string }>
  removeStorage: (id: string) => Promise<{ ok: boolean; error?: string }>
  rescanStorage: (id: string) => Promise<{ ok: boolean; error?: string }>
  refreshStorages: () => Promise<void>
  // 设备（节点）管理
  nodes: SrvNode[]
  refreshNodes: () => Promise<void>
  pairDevice: (address: string, code: string, roots: string[]) => Promise<{ ok: boolean; error?: string }>
}

export interface LibraryState {
  items: MediaItem[]
  actors: ActorEntry[]
  loading: boolean
  connection: ConnectionState
  /** 登记的存储目录（PC 上被引用的真实目录），侧边栏顶层按此呈现 */
  storages: SrvStorage[]
  get: (id: string) => MediaItem | undefined
  clipsOf: (parentId: string) => MediaItem[]
  importFiles: (files: FileList | File[]) => Promise<{ imported: MediaItem[]; bound: string[] }>
  bindFile: (id: string, file: File) => Promise<void>
  patch: (id: string, p: Partial<MediaItem>) => Promise<void>
  rename: (id: string, name: string) => Promise<{ cloudSynced: boolean }>
  remove: (id: string, alsoCloud?: boolean) => Promise<void>
  removeMany: (ids: string[], onProgress?: DeleteProgress) => Promise<BatchDeleteResult>
  addMark: (id: string, time: number, label?: string) => Promise<Mark | undefined>
  updateMark: (id: string, markId: string, p: Partial<Mark>) => Promise<void>
  removeMark: (id: string, markId: string) => Promise<void>
  createClip: (parentId: string, start: number, end: number, name: string) => Promise<MediaItem | undefined>
  objectURL: (id: string) => Promise<string | undefined>
  addActorToItem: (id: string, name: string) => Promise<string[]>
  addActorsToItems: (ids: string[], names: string[]) => Promise<void>
  removeActorFromItem: (id: string, name: string) => Promise<void>
  setItemTags: (id: string, tags: string[]) => Promise<void>
  actorOf: (name: string) => ActorEntry | undefined
  registerActor: (name: string, tags?: string[], itemIds?: string[]) => Promise<void>
  deleteActors: (names: string[]) => Promise<void>
  renameActor: (name: string, newName: string) => Promise<void>
  patchActor: (name: string, p: Partial<ActorEntry>) => Promise<void>
  cloudRecords: CloudRecord[]
  cloudFoldersAt: (path: string[]) => string[]
  cloudItemsAt: (path: string[]) => MediaItem[]
  downloadFromCloud: (itemId: string, file: File) => Promise<void>
  removeCloud: (cloudId: string) => Promise<void>
}

const Ctx = createContext<LibraryState | null>(null)

// eslint-disable-next-line react-refresh/only-export-components -- Provider and its context hook share this module.
export function useLibrary(): LibraryState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useLibrary outside provider')
  return v
}

let seqCounter = Date.now()
const nextSeq = () => ++seqCounter

export function LibraryProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<MediaItem[]>([])
  const [actors, setActors] = useState<ActorEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [online, setOnline] = useState(false)
  const [paired, setPaired] = useState(transport.isPaired)
  const [pendingWrites, setPendingWrites] = useState(0)
  const [lastSync, setLastSync] = useState<number | null>(null)
  const [storages, setStorages] = useState<SrvStorage[]>([])
  const [nodes, setNodes] = useState<SrvNode[]>([])
  const revisionRef = useRef(0)
  const pollTimer = useRef<number | null>(null)

  // ---- 从缓存渲染 ----
  const renderFromCache = useCallback(async () => {
    const [metas, acts] = await Promise.all([db.allMeta(), db.allActors()])
    metas.sort((a, b) => b.createdAt - a.createdAt)
    setItems(metas)
    acts.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    setActors(acts)
    setPendingWrites(await db.outboxCount())
  }, [])

  // ---- 应用一份快照到缓存 ----
  const applySnapshot = useCallback(async (snap: Snapshot) => {
    const media = snap.media.map((m) => toMediaItem(m, snap.marks))
    await db.replaceMeta(media)
    await db.replaceActors(snap.actors.map(toActorEntry))
    if (snap.storages) setStorages(snap.storages)
    revisionRef.current = snap.revision
    await db.setKV('revision', snap.revision)
    setLastSync(Date.now())
  }, [])

  // ---- 拉全量快照 ----
  const fullSync = useCallback(async () => {
    const snap = await transport.get<Snapshot>('/api/library')
    await applySnapshot(snap)
    await renderFromCache()
  }, [applySnapshot, renderFromCache])

  // ---- Outbox 回放 ----
  const flushOutbox = useCallback(async () => {
    const entries = await db.allOutbox()
    if (!entries.length) return
    try {
      const res = await transport.send<{ ackedOpIds: string[]; rejected: unknown[] }>(
        '/api/outbox/flush',
        'POST',
        { entries, since: revisionRef.current },
      )
      for (const opId of res.ackedOpIds) await db.deleteOutbox(opId)
      setPendingWrites(await db.outboxCount())
      await fullSync()
    } catch {
      /* 仍离线，保留队列 */
    }
  }, [fullSync])

  // ---- 探活 + 同步 ----
  const reconnect = useCallback(async () => {
    if (!transport.isPaired) return false
    const ok = await transport.discover()
    setOnline(ok)
    if (ok) {
      try {
        await flushOutbox()
        await fullSync()
      } catch {
        setOnline(false)
      }
    }
    return ok
  }, [flushOutbox, fullSync])

  // ---- 入队一个写操作（乐观） ----
  const enqueue = useCallback(async (op: OutboxOp) => {
    const entry: OutboxEntry = { opId: uid(), seq: nextSeq(), op, createdAt: Date.now() }
    await db.putOutbox(entry)
    setPendingWrites(await db.outboxCount())
    if (transport.online) flushOutbox()
  }, [flushOutbox])

  // 乐观改一条 item 缓存并刷新
  const patchLocal = useCallback(async (id: string, mut: (m: MediaItem) => MediaItem) => {
    const all = await db.allMeta()
    const cur = all.find((m) => m.id === id)
    if (!cur) return
    await db.putMeta(mut({ ...cur }))
    await renderFromCache()
  }, [renderFromCache])

  // ---- 生命周期 ----
  useEffect(() => {
    let alive = true
    const off = transport.onStatus((o) => alive && setOnline(o))
    ;(async () => {
      revisionRef.current = (await db.getKV<number>('revision')) ?? 0
      setLastSync((await db.getKV<number>('lastSync')) ?? null)
      await renderFromCache() // 先离线渲染
      setLoading(false)
      if (transport.isPaired) {
        setPaired(true)
        await reconnect()
      }
      // 轮询增量（在线时）：家用 LAN 足够，替代 WebSocket
      pollTimer.current = window.setInterval(async () => {
        if (!transport.isPaired) return
        try {
          const snap = await transport.get<Snapshot>('/api/library')
          if (snap.revision !== revisionRef.current) {
            await applySnapshot(snap)
            await renderFromCache()
          }
          setOnline(true)
          await flushOutbox()
        } catch {
          setOnline(false)
        }
      }, 4000)
    })()
    return () => {
      alive = false
      off()
      if (pollTimer.current) window.clearInterval(pollTimer.current)
    }
  }, [renderFromCache, reconnect, applySnapshot, flushOutbox])

  // ---- 查询 ----
  const get = useCallback((id: string) => items.find((i) => i.id === id), [items])
  const clipsOf = useCallback(
    (parentId: string) => items.filter((i) => i.kind === 'clip' && i.parentId === parentId),
    [items],
  )
  const actorOf = useCallback((name: string) => actors.find((a) => a.name === name), [actors])

  // 云盘记录：由 items 的 folder 合成（供 LibraryPage 目录树 & 浏览）
  const cloudRecords: CloudRecord[] = items
    .filter((i) => i.kind === 'source')
    .map((i) => ({
      id: i.id,
      name: i.name,
      itemId: i.id,
      folder: (i.folder ?? '').split('/').filter(Boolean),
      exists: true,
      updatedAt: i.updatedAt,
    }))

  const cloudFoldersAt = useCallback(
    (path: string[]) => {
      const names = new Set<string>()
      for (const c of cloudRecords) {
        if (c.folder.length <= path.length) continue
        if (path.every((p, i) => c.folder[i] === p)) names.add(c.folder[path.length])
      }
      return Array.from(names).sort((a, b) => a.localeCompare(b, 'zh'))
    },
    [cloudRecords],
  )

  const cloudItemsAt = useCallback(
    (path: string[]) => {
      const ids = cloudRecords
        .filter((c) => c.folder.length === path.length && path.every((p, i) => c.folder[i] === p))
        .map((c) => c.itemId)
      return items
        .filter((i) => ids.includes(i.id))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    },
    [cloudRecords, items],
  )

  // ---- 写操作（乐观 + 入队） ----
  const patch = useCallback(
    async (id: string, p: Partial<MediaItem>) => {
      const cur = items.find((i) => i.id === id)
      await patchLocal(id, (m) => ({ ...m, ...p, updatedAt: Date.now() }))
      // 把已知字段映射为后端写操作
      if ('rating' in p && typeof p.rating === 'number')
        await enqueue({ kind: 'media.setRating', mediaId: id, payload: { rating: p.rating } })
      if ('tags' in p && p.tags) await enqueue({ kind: 'media.setTags', mediaId: id, payload: { tags: p.tags } })
      if ('synopsis' in p || 'year' in p) {
        // 简介/年份后端暂无独立字段写入接口，靠 rename 之外的补丁忽略（保留本地缓存）
        void cur
      }
    },
    [items, patchLocal, enqueue],
  )

  const rename = useCallback(
    async (id: string, name: string) => {
      await patchLocal(id, (m) => ({ ...m, name, updatedAt: Date.now() }))
      // 片段 parentName 同步（乐观）
      const children = (await db.allMeta()).filter((m) => m.parentId === id)
      for (const c of children) await db.putMeta({ ...c, parentName: name })
      await renderFromCache()
      await enqueue({ kind: 'media.rename', mediaId: id, payload: { name } })
      return { cloudSynced: true }
    },
    [patchLocal, renderFromCache, enqueue],
  )

  const remove = useCallback(
    async (id: string) => {
      await transport.send(`/api/media/${id}`, 'DELETE')
      await fullSync()
    },
    [fullSync],
  )

  const removeMany = useCallback(async (ids: string[], onProgress?: DeleteProgress): Promise<BatchDeleteResult> => {
    await flushOutbox()
    if ((await db.allOutbox()).length) throw new Error('仍有待同步更改，请同步完成后批量删除')
    const result = await deleteBatch(ids, async id => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 45000)
      try {await transport.request(`/api/media/${encodeURIComponent(id)}`, {method: 'DELETE', signal: controller.signal})}
      finally {clearTimeout(timeout)}
    }, onProgress)
    try {await fullSync()}
    catch {
      // A failed refresh must not turn acknowledged deletes into apparent failures.
      const removed = new Set(result.removed)
      setItems(previous => previous.filter(item => !removed.has(item.id) && !(item.parentId && removed.has(item.parentId))))
      try {
        const cached = await db.allMeta()
        await Promise.all(cached.filter(item => removed.has(item.id) || item.parentId && removed.has(item.parentId)).map(item => db.deleteMeta(item.id)))
      } catch { /* Keep the in-memory result; the next successful sync repairs the cache. */ }
      result.syncWarning = '删除结果已返回，列表同步暂未完成；重新连接后会自动刷新。'
    }
    return result
  }, [flushOutbox, fullSync])

  const addMark = useCallback(
    async (id: string, time: number, label?: string) => {
      const cur = items.find((i) => i.id === id)
      if (!cur) return
      const colors = ['#f43f5e', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#ec4899']
      const mark: Mark = {
        id: uid(),
        time: Math.max(0, time),
        label: label || `标记 ${cur.marks.length + 1}`,
        color: colors[cur.marks.length % 6],
        createdAt: Date.now(),
      }
      await patchLocal(id, (m) => ({ ...m, marks: [...m.marks, mark].sort((a, b) => a.time - b.time) }))
      await enqueue({ kind: 'mark.add', mediaId: id, payload: { time: mark.time, label: mark.label } })
      return mark
    },
    [items, patchLocal, enqueue],
  )

  const updateMark = useCallback(
    async (id: string, markId: string, p: Partial<Mark>) => {
      await patchLocal(id, (m) => ({
        ...m,
        marks: m.marks.map((k) => (k.id === markId ? { ...k, ...p } : k)).sort((a, b) => a.time - b.time),
      }))
      await enqueue({ kind: 'mark.update', mediaId: id, markId, payload: p as Record<string, unknown> })
    },
    [patchLocal, enqueue],
  )

  const removeMark = useCallback(
    async (id: string, markId: string) => {
      await patchLocal(id, (m) => ({ ...m, marks: m.marks.filter((k) => k.id !== markId) }))
      await enqueue({ kind: 'mark.remove', mediaId: id, markId })
    },
    [patchLocal, enqueue],
  )

  const createClip = useCallback(
    async (parentId: string, start: number, end: number, name: string) => {
      const parent = items.find((i) => i.id === parentId)
      if (!parent || end <= start) return undefined
      const clip: MediaItem = {
        id: uid(),
        name,
        kind: 'clip',
        duration: end - start,
        size: 0,
        mime: parent.mime,
        poster: parent.poster,
        rating: 0,
        tags: [...parent.tags],
        cast: parent.cast ? [...parent.cast] : undefined,
        marks: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        hasFile: false,
        parentId,
        parentName: parent.name,
        rangeStart: start,
        rangeEnd: end,
        clipStatus: 'pending',
        folder: parent.folder,
      }
      await db.putMeta(clip)
      await renderFromCache()
      await enqueue({ kind: 'clip.create', payload: { parentId, rangeStart: start, rangeEnd: end, name } })
      return clip
    },
    [items, renderFromCache, enqueue],
  )

  // 视频/海报：返回 PC 流式 URL（有文件才可播）
  const objectURL = useCallback(async (id: string) => {
    const cur = items.find((i) => i.id === id)
    if (!cur || !cur.hasFile) return undefined
    return await transport.streamUrl(id)
  }, [items])

  // ---- 演员 ⇄ 标签互通（乐观，后端也会算一遍以服务端为准） ----
  const addActorToItem = useCallback(
    async (id: string, name: string) => {
      const item = items.find((i) => i.id === id)
      if (!item) return []
      const cast = item.cast ?? []
      if (cast.includes(name)) return []
      const entry = actors.find((a) => a.name === name)
      const carry = entry?.tags ?? []
      const mergedTags = Array.from(new Set([...item.tags, ...carry]))
      await patchLocal(id, (m) => ({ ...m, cast: [...cast, name], tags: mergedTags }))
      await enqueue({ kind: 'media.setCast', mediaId: id, payload: { cast: [...cast, name] } })
      return carry
    },
    [items, actors, patchLocal, enqueue],
  )

  const addActorsToItems = useCallback(async (mediaIds: string[], names: string[]) => {
    // Commit earlier edits before this atomic batch; never claim success while offline.
    await flushOutbox()
    if ((await db.allOutbox()).length) throw new Error('仍有待同步更改，请同步完成后批量设置演员')
    await transport.send('/api/media/batch-cast', 'POST', {mediaIds, names})
    await fullSync()
  }, [flushOutbox, fullSync])

  const removeActorFromItem = useCallback(
    async (id: string, name: string) => {
      const item = items.find((i) => i.id === id)
      if (!item) return
      const next = (item.cast ?? []).filter((c) => c !== name)
      await patchLocal(id, (m) => ({ ...m, cast: next }))
      await enqueue({ kind: 'media.setCast', mediaId: id, payload: { cast: next } })
    },
    [items, patchLocal, enqueue],
  )

  const setItemTags = useCallback(
    async (id: string, tags: string[]) => {
      await patchLocal(id, (m) => ({ ...m, tags }))
      await enqueue({ kind: 'media.setTags', mediaId: id, payload: { tags } })
    },
    [patchLocal, enqueue],
  )

  const registerActor = useCallback(
    async (name: string, tags: string[] = [], itemIds: string[] = []) => {
      const entry: ActorEntry = { name, tags, updatedAt: Date.now() }
      await db.putActor(entry)
      await renderFromCache()
      await enqueue({ kind: 'actor.upsert', payload: entry })
      for (const id of itemIds) await addActorToItem(id, name)
    },
    [renderFromCache, enqueue, addActorToItem],
  )

  const patchActor = useCallback(
    async (name: string, p: Partial<ActorEntry>) => {
      const cur = actors.find((a) => a.name === name) ?? { name, tags: [], updatedAt: Date.now() }
      const next: ActorEntry = { ...cur, ...p, name, updatedAt: Date.now() }
      await db.putActor(next)
      await renderFromCache()
      await enqueue({ kind: 'actor.upsert', payload: next })
    },
    [actors, renderFromCache, enqueue],
  )

  const renameActor = useCallback(async (name: string, newName: string) => {
    if (!transport.online) throw new Error('请先连接 PC 再修改姓名')
    await flushOutbox()
    if (await db.outboxCount()) throw new Error('尚有修改未同步，请同步完成后再改名')
    await transport.send('/api/actors/rename', 'POST', {name, newName})
    await fullSync()
  }, [flushOutbox, fullSync])

  const deleteActors = useCallback(async (names: string[]) => {
    await flushOutbox()
    if ((await db.allOutbox()).length) throw new Error('仍有待同步更改，请同步完成后删除演员')
    await transport.send('/api/actors/delete', 'POST', { names })
    await fullSync()
  }, [flushOutbox, fullSync])

  // ---- 存储设备管理（在线操作：登记引用需后端直达磁盘，不入 Outbox） ----
  const refreshStorages = useCallback(async () => {
    try {
      const list = await transport.get<SrvStorage[]>('/api/storages')
      setStorages(list)
    } catch {
      /* 离线：保留上次快照里的 storages */
    }
  }, [])

  const addStorage = useCallback(
    async (path: string, name?: string, nodeId?: string | null) => {
      try {
        await transport.send<SrvStorage>('/api/storages', 'POST', { path, name, nodeId })
        await refreshStorages()
        return { ok: true }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : '添加失败（需 PC 在线）' }
      }
    },
    [refreshStorages],
  )

  const removeStorage = useCallback(
    async (id: string) => {
      try {
        await transport.send(`/api/storages/${id}`, 'DELETE')
        await refreshStorages()
        await fullSync() // 该存储下素材已移除，刷新库
        return { ok: true }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : '删除失败（需 PC 在线）' }
      }
    },
    [refreshStorages, fullSync],
  )

  const rescanStorage = useCallback(
    async (id: string) => {
      try {
        await transport.send(`/api/storages/${id}/rescan`, 'POST')
        await refreshStorages()
        return { ok: true }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : '扫描失败（需 PC 在线）' }
      }
    },
    [refreshStorages],
  )

  // ---- 设备（节点）管理 ----
  const refreshNodes = useCallback(async () => {
    try {
      const list = await transport.get<SrvNode[]>('/api/nodes')
      setNodes(list)
    } catch {
      /* 离线：保留上次列表 */
    }
  }, [])

  const pairDevice = useCallback(
    async (address: string, code: string, roots: string[]) => {
      const r = await transport.pairDevice(address, code, roots)
      if (r.ok) await refreshNodes()
      return r
    },
    [refreshNodes],
  )

  // ---- 文件相关：视频住在 PC，手机不导入/绑定本地文件 ----
  const importFiles = useCallback(async () => {
    // 手机端不导入本地文件：素材在 PC 上管理。返回空结果，UI 会提示。
    return { imported: [] as MediaItem[], bound: [] as string[] }
  }, [])

  const bindFile = useCallback(async () => {
    /* 手机端不绑定本地文件 */
  }, [])

  const downloadFromCloud = useCallback(async () => {
    /* 「下载到本地」是 PC 侧动作，手机不处理 */
  }, [])

  const removeCloud = useCallback(
    async (cloudId: string) => {
      // 合成的 cloudId == itemId，等同删除该素材
      await remove(cloudId)
    },
    [remove],
  )

  const connection: ConnectionState = {
    online,
    paired,
    baseUrl: transport.baseUrl,
    pendingWrites,
    lastSync,
    pair: async (base, code) => {
      const r = await transport.pair(base, code)
      if (r.ok) {
        setPaired(true)
        await reconnect()
      }
      return r
    },
    reconnect,
    streamUrl: (id) => transport.streamUrl(id),
    unpair: () => {
      transport.unpair()
      setOnline(false)
      setPaired(false)
    },
    storages,
    addStorage,
    removeStorage,
    rescanStorage,
    refreshStorages,
    nodes,
    refreshNodes,
    pairDevice,
  }

  return (
    <Ctx.Provider
      value={{
        items,
        actors,
        loading,
        connection,
        storages,
        get,
        clipsOf,
        importFiles,
        bindFile,
        patch,
        rename,
        remove,
        removeMany,
        addMark,
        updateMark,
        removeMark,
        createClip,
        objectURL,
        addActorToItem,
        removeActorFromItem,
        addActorsToItems,
        setItemTags,
        actorOf,
        registerActor,
        patchActor,
        deleteActors,
        renameActor,
        cloudRecords,
        cloudFoldersAt,
        cloudItemsAt,
        downloadFromCloud,
        removeCloud,
      }}
    >
      {children}
    </Ctx.Provider>
  )
}

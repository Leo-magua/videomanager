// M2 缓存层：IndexedDB 只存元数据（素材/打点/演员）+ Outbox 写队列 + kv。
// 不再存视频 blob —— 视频永远从 PC 流式播放。
// 缓存让 PC 关机/断网时仍能浏览已同步的元数据（离线优先硬约束）。
import type { ActorEntry, MediaItem } from '@/types'
import type { OutboxEntry } from '@/lib/outboxTypes'

const DB_NAME = 'vm-panel'
const DB_VERSION = 1

let dbPromise: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' })
        if (!db.objectStoreNames.contains('actors')) db.createObjectStore('actors', { keyPath: 'name' })
        if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'opId' })
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv')
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return dbPromise
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (dbi) =>
      new Promise<T>((resolve, reject) => {
        const t = dbi.transaction(store, mode)
        const req = fn(t.objectStore(store))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

async function clear(store: string): Promise<void> {
  await tx(store, 'readwrite', (s) => s.clear())
}

export const db = {
  // ===== 素材元数据缓存 =====
  async allMeta(): Promise<MediaItem[]> {
    return tx('meta', 'readonly', (s) => s.getAll() as IDBRequest<MediaItem[]>)
  },
  async putMeta(item: MediaItem): Promise<void> {
    await tx('meta', 'readwrite', (s) => s.put(item))
  },
  async deleteMeta(id: string): Promise<void> {
    await tx('meta', 'readwrite', (s) => s.delete(id))
  },
  async replaceMeta(items: MediaItem[]): Promise<void> {
    await clear('meta')
    for (const it of items) await tx('meta', 'readwrite', (s) => s.put(it))
  },

  // ===== 演员目录缓存 =====
  async allActors(): Promise<ActorEntry[]> {
    return tx('actors', 'readonly', (s) => s.getAll() as IDBRequest<ActorEntry[]>)
  },
  async putActor(entry: ActorEntry): Promise<void> {
    await tx('actors', 'readwrite', (s) => s.put(entry))
  },
  async replaceActors(entries: ActorEntry[]): Promise<void> {
    await clear('actors')
    for (const a of entries) await tx('actors', 'readwrite', (s) => s.put(a))
  },

  // ===== Outbox 写队列（离线时入队，上线回放） =====
  async allOutbox(): Promise<OutboxEntry[]> {
    const all = await tx('outbox', 'readonly', (s) => s.getAll() as IDBRequest<OutboxEntry[]>)
    return all.sort((a, b) => a.seq - b.seq)
  },
  async putOutbox(entry: OutboxEntry): Promise<void> {
    await tx('outbox', 'readwrite', (s) => s.put(entry))
  },
  async deleteOutbox(opId: string): Promise<void> {
    await tx('outbox', 'readwrite', (s) => s.delete(opId))
  },
  async outboxCount(): Promise<number> {
    return tx('outbox', 'readonly', (s) => s.count())
  },

  // ===== k-v =====
  async getKV<T>(key: string): Promise<T | undefined> {
    return tx('kv', 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>)
  },
  async setKV(key: string, value: unknown): Promise<void> {
    await tx('kv', 'readwrite', (s) => s.put(value, key))
  },
}

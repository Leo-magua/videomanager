import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronRight, Cloud, File, Folder, FolderInput, FolderOpen, FolderPlus, Upload, HardDrive, Loader2, RefreshCw, Search, Trash2, Users, X } from 'lucide-react'
import { toast } from 'sonner'
import { useLibrary } from '@/store/library'
import { isClipBusy, runClip } from '@/lib/clipper'
import { useDragSelection } from '@/lib/useDragSelection'
import { sortFileEntries, sortMedia } from '@/lib/rating-sort'
import { useRatingSort } from '@/lib/useRatingSort'
import { RatingSortControl } from '@/components/RatingSortControl'
import { transport } from '@/lib/transport'
import { ConnectionBar } from '@/components/ConnectionBar'
import { BatchDeleteDialog, type DeleteTarget } from '@/components/BatchDeleteDialog'
import { MediaRowCard } from '@/components/MediaRowCard'
import { FileEntryMenu } from '@/components/FileEntryMenu'
import { FileOperationDialog, type FileOperation } from '@/components/FileOperationDialog'
import { BatchMoveDialog } from '@/components/BatchMoveDialog'
import { UploadDialog, type UploadDestination } from '@/components/UploadDialog'
import { deleteBatch, type BatchDeleteResult, type DeleteProgress } from '@/lib/batch-delete'
import { RenameDialog } from '@/components/RenameDialog'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import type { DirectoryListing, FileEntry, MediaItem } from '@/types'
import { formatSize } from '@/types'

export type Region = {kind: 'local'} | {kind: 'storage'; storageId: string; folder: string[]}
interface Props { onOpenDetail: (id: string) => void; region: Region; onRegionChange: (region: Region) => void }
type Deletion = {item: MediaItem} | {storageId: string; entry: FileEntry}
const keyOf = (id: string, path: string) => `${id}\u0000${path}`
const normalize = (path: string) => path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')

export function LibraryPage({onOpenDetail, region, onRegionChange}: Props) {
  const lib = useLibrary()
  const [sortOrder, setSortOrder] = useRatingSort()
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [batchDeletion, setBatchDeletion] = useState<DeleteTarget[]>([])
  const [moving, setMoving] = useState<FileEntry[] | null>(null)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const uploadTarget = useRef<UploadDestination | null>(null)
  const [uploading, setUploading] = useState<{destination: UploadDestination; files: File[]} | null>(null)
  const uploadRef = useRef<HTMLInputElement>(null)
  const [assigning, setAssigning] = useState(false)
  const [actorNames, setActorNames] = useState<string[]>([])
  const [typingActor, setTypingActor] = useState(false)
  const [newActor, setNewActor] = useState('')
  const [assignBusy, setAssignBusy] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const toggleActor = (name: string) => setActorNames(prev => prev.includes(name) ? prev.filter(value => value !== name) : [...prev, name])
  const stageActor = () => {const name = newActor.trim(); if (name) setActorNames(prev => [...new Set([...prev, name])]); setNewActor(''); setTypingActor(false)}
  useEffect(() => {
    const back = (event: Event) => {
      if (!selecting || assigning || document.querySelector('[role="dialog"][data-state="open"],[role="alertdialog"][data-state="open"]') || rootRef.current?.closest('[hidden]')) return
      event.preventDefault(); setSelecting(false); setSelected(new Set())
    }
    window.addEventListener('vm-back', back)
    return () => window.removeEventListener('vm-back', back)
  }, [selecting, assigning])
  const [batchBusy, setBatchBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const swipe = useRef<{x: number; y: number; open: boolean} | null>(null)
  const suppressSwipeClickUntil = useRef(0)
  useEffect(() => {if (searchOpen) searchRef.current?.focus()}, [searchOpen])
  const [treeOpen, setTreeOpen] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [listings, setListings] = useState<Record<string, DirectoryListing>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [refresh, setRefresh] = useState(0)
  const [fileOperation, setFileOperation] = useState<FileOperation | null>(null)
  const [renaming, setRenaming] = useState<MediaItem | null>(null)
  const [deleting, setDeleting] = useState<Deletion | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [importing, setImporting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const bindRef = useRef<HTMLInputElement>(null)
  const bindTarget = useRef<string | null>(null)
  const pending = useRef(new Set<string>())
  const currentPath = region.kind === 'storage' ? region.folder.join('/') : ''
  const currentId = region.kind === 'storage' ? region.storageId : ''
  const currentKey = keyOf(currentId, currentPath)
  const storage = lib.storages.find(s => s.id === currentId)
  const load = useCallback(async (id: string, path: string) => {
    const key = keyOf(id, path)
    if (pending.current.has(key)) return
    pending.current.add(key); setBusy(prev => ({...prev, [key]: true}))
    try {
      const data = await transport.get<DirectoryListing>(`/api/storages/${encodeURIComponent(id)}/entries?path=${encodeURIComponent(path)}`)
      setListings(prev => ({...prev, [key]: data})); setErrors(prev => ({...prev, [key]: ''}))
    } catch (error) {setErrors(prev => ({...prev, [key]: error instanceof Error ? error.message : '无法读取目录，请检查设备连接'}))}
    finally {pending.current.delete(key); setBusy(prev => ({...prev, [key]: false}))}
  }, [])
  useEffect(() => {if (currentId && lib.connection.online) void load(currentId, currentPath)}, [currentId, currentPath, refresh, lib.connection.online, load])
  // Storage snapshots change on each poll; only reload roots when their identities change.
  const storageIds = lib.storages.map(s => s.id).join(',')
  useEffect(() => {if (treeOpen) for (const id of storageIds.split(',').filter(Boolean)) void load(id, '')}, [treeOpen, storageIds, load])
  useEffect(() => {
    if (!treeOpen) return
    const escape = (e: KeyboardEvent) => {if (e.key === 'Escape') setTreeOpen(false)}
    const back = (e: Event) => {if (deleting) return; e.preventDefault(); setTreeOpen(false)}
    document.addEventListener('keydown', escape); window.addEventListener('vm-back', back)
    return () => {document.removeEventListener('keydown', escape); window.removeEventListener('vm-back', back)}
  }, [treeOpen, deleting])
  useEffect(() => {setQuery(''); setSearchOpen(false); setSelecting(false); setSelected(new Set())}, [currentId, currentPath])
  const indexedListing = (id: string, path: string): DirectoryListing => {
    const children = new Map<string, FileEntry>()
    const prefix = path ? `${path}/` : ''
    for (const item of lib.items) {
      if (item.kind !== 'source' || item.storageId !== id) continue
      const relative = normalize(item.filePath || `${item.folder ? `${item.folder}/` : ''}${item.name}`)
      if (!relative.startsWith(prefix)) continue
      const parts = relative.slice(prefix.length).split('/')
      const directory = parts.length > 1
      const name = parts[0]
      children.set(name, {name, path: prefix + name, kind: directory ? 'directory' : 'file', isVideo: !directory, size: directory ? 0 : item.size})
    }
    const entries = [...children.values()].sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name, 'zh'))
    return {path, entries, fileCount: entries.filter(e => e.kind === 'file').length, directoryCount: entries.filter(e => e.kind === 'directory').length}
  }
  const listingAt = (id: string, path: string) => listings[keyOf(id, path)] ?? indexedListing(id, path)
  const currentListing = listingAt(currentId, currentPath)
  const q = query.trim().toLocaleLowerCase()
  const indexedItems = useMemo(() => new Map(lib.items.filter(item => item.kind === 'source' && item.storageId).map(item => [keyOf(item.storageId!, normalize(item.filePath || `${item.folder ? `${item.folder}/` : ''}${item.name}`)), item])), [lib.items])
  const itemFor = (id: string, entry: FileEntry) => indexedItems.get(keyOf(id, entry.path))
  const entries = sortFileEntries(currentListing.entries.filter(entry => {
    const item = itemFor(currentId, entry)
    return !q || entry.name.toLocaleLowerCase().includes(q) || item?.tags.some(t => t.toLocaleLowerCase().includes(q)) || item?.cast?.some(c => c.toLocaleLowerCase().includes(q))
  }), entry => itemFor(currentId, entry)?.rating, sortOrder)
  const desktopItems = sortMedia(lib.items.filter(item => item.kind === 'source' && !item.storageId && (!q || item.name.toLocaleLowerCase().includes(q) || item.tags.some(t => t.toLocaleLowerCase().includes(q)) || item.cast?.some(c => c.toLocaleLowerCase().includes(q)))), sortOrder)
  const selectableIds = region.kind === 'local' ? desktopItems.map(item => item.id) : entries.map(entry => entry.path)
  const selectedEntries = entries.filter(entry => selected.has(entry.path))
  const selectedVideoIds = region.kind === 'local' ? [...selected] : selectedEntries.flatMap(entry => {
    const item = itemFor(currentId, entry)
    return entry.kind === 'file' && item ? [item.id] : []
  })
  const refreshFiles = async () => {
    setListings({}); setErrors({}); setRefresh(value => value + 1)
    await lib.connection.reconnect()
  }
  const deleteSelected = async (ids: string[], onProgress: DeleteProgress): Promise<BatchDeleteResult> => {
    if (region.kind === 'local') return lib.removeMany(ids, onProgress)
    const result = await deleteBatch(ids, path => transport.send(`/api/storages/${encodeURIComponent(currentId)}/entries`, 'DELETE', {path}), onProgress)
    try {await refreshFiles()} catch {result.syncWarning = '操作已完成，列表同步失败，请稍后刷新'}
    return result
  }
  const dragSelection = useDragSelection({root: rootRef, ids: selectableIds, selected, selecting, setSelected, setSelecting, scope: `${currentKey}\u0000${query}\u0000${sortOrder}`, disabled: !!moving || creatingFolder || !!uploading || assigning || treeOpen || !!deleting || !!renaming || !!fileOperation || batchDeletion.length > 0})
  const enter = (id: string, path: string) => {onRegionChange({kind: 'storage', storageId: id, folder: path.split('/').filter(Boolean)}); setTreeOpen(false)}
  const openFile = (id: string, entry: FileEntry) => {
    const item = itemFor(id, entry)
    if (item) {setTreeOpen(false); onOpenDetail(item.id)}
    else toast.info(entry.isVideo ? '视频尚未建立索引，请点刷新扫描' : '普通文件支持浏览名称和删除')
  }
  const isExpanded = (id: string, path: string) => !collapsed.has(keyOf(id, path)) && (path === '' || !!listings[keyOf(id, path)] || (id === currentId && (path === currentPath || currentPath.startsWith(path + '/'))))
  const toggleFolder = (id: string, path: string) => {
    const key = keyOf(id, path)
    setCollapsed(prev => {const next = new Set(prev); if (isExpanded(id, path)) next.add(key); else next.delete(key); return next})
    void load(id, path)
  }
  const entryMenu = (storageId: string, entry: FileEntry) => <FileEntryMenu name={entry.name}
    onRename={() => {setTreeOpen(false); setFileOperation({storageId, entry, action: 'rename'})}}
    onMove={() => {setTreeOpen(false); setFileOperation({storageId, entry, action: 'move'})}}
    onDelete={() => {setTreeOpen(false); setDeleting({storageId, entry})}} />
  const renderTree = (id: string, path: string, name: string, depth: number): React.ReactNode => {
    const key = keyOf(id, path), listing = listingAt(id, path), open = isExpanded(id, path)
    return <div key={key}>
      <div style={{paddingLeft: depth * 14 + 4}} className={`flex items-center gap-1 rounded-lg py-1 ${key === currentKey ? 'bg-sky-500/15 text-sky-300' : 'text-zinc-300'}`}>
        <button aria-label={`${open ? '收起' : '展开'} ${name}`} onClick={() => toggleFolder(id, path)} className="grid h-9 w-7 shrink-0 place-items-center"><ChevronRight size={14} className={open ? 'rotate-90' : ''} /></button>
        <button onClick={() => enter(id, path)} className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left text-sm">
          {open ? <FolderOpen size={16} className="shrink-0 text-sky-400" /> : <Folder size={16} className="shrink-0 text-sky-400" />}
          <span className="truncate">{name}</span>
          {listings[key] && <span className="ml-auto shrink-0 pr-2 text-[10px] text-zinc-500" title="直接子目录数 / 直接文件数">{listing.directoryCount}目录 / {listing.fileCount}文件</span>}
          {busy[key] && <Loader2 size={12} className="shrink-0 animate-spin" />}
        </button>
        {path && entryMenu(id, {name, path, kind: 'directory', isVideo: false, size: 0})}
      </div>
      {open && listing.entries.map(entry => entry.kind === 'directory' ? renderTree(id, entry.path, entry.name, depth + 1) :
        <div key={entry.path} style={{paddingLeft: (depth + 1) * 14 + 12}} className="flex items-center gap-2 py-1 text-xs text-zinc-400">
          <File size={14} className="shrink-0" /><button onClick={() => openFile(id, entry)} className="min-w-0 flex-1 truncate py-2 text-left">{entry.name}</button>
          {entryMenu(id, entry)}
        </div>)}
    </div>
  }
  const onImport = async (files: FileList | null) => {
    if (!files?.length) return
    setImporting(true)
    try {const result = await lib.importFiles(files); toast.success(`已导入 ${result.imported.length} 个视频，绑定 ${result.bound.length} 个现有素材`)}
    catch (error) {toast.error(error instanceof Error ? error.message : '导入失败')}
    finally {setImporting(false); if (fileRef.current) fileRef.current.value = ''}
  }
  const cutAll = async (item: MediaItem) => {
    if (!item.hasFile) {
      toast.error('素材尚未下载到本地，请先绑定本地文件')
      return
    }
    if (batchBusy || isClipBusy()) {
      toast.error('已有剪辑任务在执行，请稍候')
      return
    }
    const todo = lib
      .clipsOf(item.id)
      .filter((c) => (c.clipStatus ?? 'completed') !== 'completed' && (c.clipStatus ?? 'completed') !== 'cutting')
    if (!todo.length) {
      toast.info('没有待剪辑的片段')
      return
    }
    setBatchBusy(true)
    let done = 0
    let failed = 0
    const src = await lib.objectURL(item.id)
    for (const clip of todo) {
      await lib.patch(clip.id, { clipStatus: 'cutting' })
      try {
        if (!src) throw new Error('母素材文件不可用')
        await runClip({ src, start: clip.rangeStart ?? 0, end: clip.rangeEnd ?? 0 })
        await lib.patch(clip.id, { clipStatus: 'completed' })
        done++
      } catch {
        await lib.patch(clip.id, { clipStatus: 'failed' })
        failed++
      }
    }
    setBatchBusy(false)
    if (failed) toast.warning(`剪辑完成 ${done} 个，失败 ${failed} 个（已标红，可重试）`)
    else toast.success(`${done} 个片段剪辑完成`)
  }

  const card = (item: MediaItem, entry?: FileEntry) => <div className="flex items-center gap-2 select-none" {...dragSelection.itemProps(entry?.path ?? item.id)}>
    {selecting && <button data-drag-select-handle style={{touchAction: 'none'}} type="button" role="checkbox" aria-checked={selected.has(entry?.path ?? item.id)} aria-label={`选择 ${entry?.name ?? item.name}`} className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg border ${selected.has(entry?.path ?? item.id) ? 'border-amber-500 bg-amber-500 text-black' : 'border-zinc-600'}`}>{selected.has(entry?.path ?? item.id) && <Check size={17} />}</button>}
    <div className={`min-w-0 flex-1 rounded-2xl ${selecting && selected.has(entry?.path ?? item.id) ? 'ring-1 ring-amber-500' : ''}`}>
      <MediaRowCard item={item} onOpen={() => onOpenDetail(item.id)} onDetail={() => onOpenDetail(item.id)} onRename={() => entry ? setFileOperation({storageId: currentId, entry, action: 'rename'}) : setRenaming(item)} onMove={entry ? () => setFileOperation({storageId: currentId, entry, action: 'move'}) : undefined} onBind={!item.hasFile ? () => {bindTarget.current = item.id; bindRef.current?.click()} : undefined} onCutAll={() => void cutAll(item)} onDelete={() => setDeleting({item})} />
    </div>
  </div>
  const deleteName = deleting ? 'item' in deleting ? deleting.item.name : deleting.entry.name : ''
  const storageLabel = storage?.name ? storage.name.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || storage.name : '存储目录'
  return <div ref={rootRef} data-library-page style={{touchAction: 'pan-y'}}
    className="mx-auto min-h-dvh w-full max-w-6xl px-3 pb-24 pt-2 min-[640px]:px-6"
    onPointerDownCapture={event => {
      if (dragSelection.active.current || !event.isPrimary || event.button !== 0 || (event.target as HTMLElement).closest('input,textarea,[role="slider"],[data-swipe-ignore]') || document.querySelector('[role="alertdialog"],[role="dialog"][data-state="open"]')) {swipe.current = null; return}
      swipe.current = {x: event.clientX, y: event.clientY, open: treeOpen}
    }}
    onPointerMoveCapture={event => {
      if (dragSelection.active.current) {swipe.current = null; return}
      const start = swipe.current
      if (!start) return
      const dx = event.clientX - start.x, dy = event.clientY - start.y
      if (Math.abs(dy) > 40 && Math.abs(dy) > Math.abs(dx)) {swipe.current = null; return}
      if (Math.abs(dx) < 64 || Math.abs(dx) < Math.abs(dy) * 1.5) return
      if ((!start.open && dx > 0) || (start.open && dx < 0)) {
        dragSelection.cancel()
        suppressSwipeClickUntil.current = Date.now() + 500
        swipe.current = null; setTreeOpen(!start.open)
      }
    }}
    onPointerUpCapture={() => {swipe.current = null}}
    onPointerCancelCapture={() => {swipe.current = null}}
    onClickCapture={event => {
      if (Date.now() < suppressSwipeClickUntil.current && !(event.target as HTMLElement).closest('[data-file-tree]')) {event.preventDefault(); event.stopPropagation()}
    }}>
    <header className="mb-2 flex items-center gap-2" data-swipe-ignore>
      <nav aria-label="目录路径" className="flex min-h-11 min-w-0 flex-1 flex-wrap items-center gap-x-1 text-sm text-sky-300">
        <button onClick={() => onRegionChange({kind: 'local'})} className="min-h-10 px-1 hover:text-sky-200" aria-current={region.kind === 'local' ? 'page' : undefined}>素材库</button>
        {region.kind === 'storage' && <>
          <ChevronRight size={13} className="shrink-0 text-sky-500/60" />
          <button onClick={() => enter(currentId, '')} title={storage?.rootPath} className="min-h-10 max-w-36 truncate px-1 hover:text-sky-200" aria-current={!region.folder.length ? 'page' : undefined}>{storageLabel}</button>
          {region.folder.map((part, index) => <span key={index} className="inline-flex min-w-0 items-center gap-1">
            <ChevronRight size={13} className="shrink-0 text-sky-500/60" />
            <button className="min-h-10 max-w-32 truncate px-1 hover:text-sky-200" aria-current={index === region.folder.length - 1 ? 'page' : undefined} onClick={() => enter(currentId, region.folder.slice(0, index + 1).join('/'))}>{part}</button>
          </span>)}
        </>}
      </nav>
      <div className="flex shrink-0 items-center gap-1">
        <ConnectionBar compact />
        {region.kind === 'storage' && <>
          <button aria-label="新建文件夹" title="新建文件夹" disabled={!lib.connection.online} onClick={() => setCreatingFolder(true)} className="grid h-10 w-10 place-items-center rounded-full bg-zinc-900 text-sky-300 disabled:opacity-40"><FolderPlus size={18}/></button>
          <button aria-label="上传文件到当前目录" title="上传到当前目录" disabled={!lib.connection.online} onClick={() => {
            uploadTarget.current = {storageId: currentId, path: currentPath, label: [storage?.rootPath ?? storage?.name ?? '', currentPath].filter(Boolean).join('/')}
            uploadRef.current?.click()
          }} className="grid h-10 w-10 place-items-center rounded-full bg-amber-500 text-black disabled:opacity-40"><Upload size={18}/></button>
        </>}
        {region.kind === 'local' ? <button aria-label="导入视频" onClick={() => fileRef.current?.click()} disabled={importing} className="grid h-10 w-10 place-items-center rounded-full bg-amber-500 text-black">{importing ? <Loader2 size={18} className="animate-spin" /> : <FolderInput size={18} />}</button> :
          <button aria-label="刷新目录并扫描视频" onClick={async () => {setRefresh(n => n + 1); const result = await lib.connection.rescanStorage(currentId); if (!result.ok) toast.error(result.error ?? '扫描失败')}} className="grid h-10 w-10 place-items-center rounded-full bg-zinc-900"><RefreshCw size={18} className={busy[currentKey] ? 'animate-spin' : ''} /></button>}
        <button aria-label={searchOpen ? '关闭搜索' : '搜索素材'} title={searchOpen ? '关闭搜索' : '搜索素材'} aria-expanded={searchOpen}
          onClick={() => {setSearchOpen(open => !open); if (searchOpen) setQuery('')}}
          className={`grid h-10 w-10 place-items-center rounded-full ${searchOpen ? 'bg-sky-500 text-black' : 'bg-zinc-900 text-sky-300'}`}><Search size={19} /></button>
      </div>
    </header>
    {searchOpen && <div className="relative mb-3" data-swipe-ignore>
      <Search size={16} className="absolute left-3 top-3 text-zinc-500" />
      <input ref={searchRef} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => {if (event.key === 'Escape') {setQuery(''); setSearchOpen(false)}}}
        placeholder="搜索当前目录名称 / 标签 / 演员" className="w-full rounded-full border border-sky-500/50 bg-zinc-900 py-2 pl-9 pr-11 text-sm outline-none" />
      <button aria-label="清空并关闭搜索" onClick={() => {setQuery(''); setSearchOpen(false)}} className="absolute right-1 top-0.5 grid h-9 w-9 place-items-center text-zinc-400"><X size={17} /></button>
    </div>}
    <div className="sticky top-0 z-20 mb-3 flex min-h-11 flex-wrap items-center justify-end gap-2 rounded-xl bg-zinc-950/95 px-2 text-sm backdrop-blur">
      {selecting ? <>
        <span className="mr-auto basis-full pt-2 text-xs text-zinc-400" aria-label={`已选 ${selected.size} 项`}>已选 {selected.size} 个</span>
        <button aria-label="全选当前文件" onClick={() => setSelected(new Set(selectableIds))} className="shrink-0 text-xs text-zinc-300">全选</button>
        <button disabled={!selectedVideoIds.length} onClick={() => {setActorNames([]); setTypingActor(false); setNewActor(''); setAssigning(true)}} title="仅应用于所选视频" className="flex items-center gap-1 text-amber-400 disabled:opacity-40"><Users size={18} /><span className="text-xs">添加演员</span></button>
        {region.kind === 'storage' && <button aria-label="批量移动文件" disabled={!selectedEntries.length} onClick={() => setMoving(selectedEntries)} className="flex min-h-10 shrink-0 items-center gap-1 text-sky-300 disabled:opacity-40"><FolderInput size={17}/><span className="text-xs">移动</span></button>}
        <button aria-label="批量删除素材" disabled={!selected.size} onClick={() => setBatchDeletion([...selected].map(id => ({id, name: region.kind === 'storage' ? entries.find(entry => entry.path === id)?.name ?? id : lib.get(id)?.name ?? id})))} className="flex min-h-10 shrink-0 items-center gap-1 text-rose-400 disabled:opacity-40"><Trash2 size={17} /><span className="text-xs">删除</span></button>
        <button aria-label="退出文件多选" onClick={() => {setSelecting(false); setSelected(new Set())}} className="p-2"><X size={18} /></button>
      </> : <>
        <span className="mr-auto text-xs text-zinc-500">{region.kind === 'storage' ? `${currentListing.directoryCount} 个文件夹 · ${currentListing.fileCount} 个文件` : '左向右滑打开文件树'}{q && ` · 匹配 ${entries.length} 项`}</span>
        <RatingSortControl value={sortOrder} onChange={setSortOrder} />
        <button disabled={!selectableIds.length} onClick={() => setSelecting(true)} className="min-h-10 shrink-0 text-xs text-zinc-400 disabled:opacity-40">多选文件</button></>}
    </div>
    {selecting && <p className="mb-3 text-xs text-zinc-500">长按后滑动连选，或沿左侧勾选框滑动；从已选项开始可取消选择</p>}
    {region.kind === 'storage' && <>
      {(errors[currentKey] || !lib.connection.online) && <div role="status" className="mb-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-300">{errors[currentKey] || '服务器未连接'}{!listings[currentKey] && '；下面暂时显示已索引的视频和目录，普通文件需连接新版连接器后读取。'}<button className="ml-2 underline" onClick={() => void load(currentId, currentPath)}>重试</button></div>}
      {busy[currentKey] && !listings[currentKey] && <p role="status" className="mb-3 flex gap-2 text-xs text-zinc-500"><Loader2 size={14} className="animate-spin" />正在读取目录…</p>}
      <ul className="grid gap-2 min-[700px]:grid-cols-2">{entries.map(entry => {
        const item = itemFor(currentId, entry)
        return <li key={entry.path}>{entry.kind === 'file' && item ? card(item, entry) : <div {...dragSelection.itemProps(entry.path)} className={`flex select-none items-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-3 ${selecting && selected.has(entry.path) ? 'ring-1 ring-amber-500' : ''}`}>
          {selecting && <button data-drag-select-handle style={{touchAction: 'none'}} type="button" role="checkbox" aria-checked={selected.has(entry.path)} aria-label={`选择 ${entry.name}`} className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg border ${selected.has(entry.path) ? 'border-amber-500 bg-amber-500 text-black' : 'border-zinc-600'}`}>{selected.has(entry.path) && <Check size={17}/>}</button>}
          <button onClick={() => entry.kind === 'directory' ? enter(currentId, entry.path) : openFile(currentId, entry)} className="flex min-h-14 min-w-0 flex-1 items-center gap-3 text-left">
            {entry.kind === 'directory' ? <Folder size={32} className="shrink-0 text-sky-400" /> : <File size={28} className="shrink-0 text-zinc-500" />}
            <span className="min-w-0"><span className="block truncate text-sm">{entry.name}</span><span className="text-xs text-zinc-500">{entry.kind === 'directory' ? '文件夹 · 点击进入' : `${formatSize(entry.size)}${entry.isVideo ? ' · 等待视频索引' : ' · 普通文件'}`}</span></span>
          </button>{entryMenu(currentId, entry)}
        </div>}</li>
      })}</ul>
      {!entries.length && !busy[currentKey] && <p className="my-16 text-center text-sm text-zinc-500">{q ? '当前目录没有匹配项' : errors[currentKey] ? '暂时无法读取目录' : '此目录为空'}</p>}
    </>}
    {region.kind === 'local' && <>
      <ul className="mb-5 grid gap-2 min-[700px]:grid-cols-2">{lib.storages.filter(st => !q || st.name.toLocaleLowerCase().includes(q) || st.rootPath.toLocaleLowerCase().includes(q)).map(st => <li key={st.id}>
        <button onClick={() => enter(st.id, '')} className="flex min-h-20 w-full items-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-3 text-left">
          {st.kind === 'remote' || st.kind === 'nas' ? <Cloud size={28} className="shrink-0 text-sky-400" /> : <HardDrive size={28} className="shrink-0 text-amber-400" />}
          <span className="min-w-0 flex-1"><span className="block truncate text-sm">{st.name}</span><span className="block truncate text-xs text-zinc-500">{st.rootPath}</span><span className="text-[11px] text-zinc-500">{st.online ? '在线' : '离线'} · {st.kind === 'remote' ? '远程设备' : st.kind === 'nas' ? '网络存储' : '本机目录'}</span></span><ChevronRight size={16} />
        </button>
      </li>)}</ul>
      {desktopItems.length > 0 && <><p className="mb-3 text-xs text-zinc-500">其他素材 · {desktopItems.length}</p><ul className="grid gap-2 min-[700px]:grid-cols-2">{desktopItems.map(item => <li key={item.id}>{card(item)}</li>)}</ul></>}
      {!lib.storages.length && !desktopItems.length && <p className="my-16 text-center text-sm text-zinc-500">暂无文件，请在设置中添加存储目录或导入视频。</p>}
    </>}
    {treeOpen && <div data-file-tree className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="文件树目录">
      <button aria-label="关闭文件树遮罩" className="absolute inset-0 bg-black/60" onClick={() => setTreeOpen(false)} />
      <aside className="absolute inset-y-2 left-2 flex w-[min(85vw,380px)] flex-col rounded-2xl border border-zinc-700 bg-zinc-900 shadow-2xl">
        <header className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-3 py-2"><span className="text-sm font-semibold">文件树目录</span><button aria-label="关闭文件树" onClick={() => setTreeOpen(false)} className="p-3"><X size={20} /></button></header>
        <div className="min-h-0 flex-1 overflow-y-auto p-2"><button onClick={() => {onRegionChange({kind: 'local'}); setTreeOpen(false)}} className="mb-2 flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-sm text-amber-300"><HardDrive size={16} />桌面</button>
          {lib.storages.map(st => renderTree(st.id, '', st.name, 0))}{!lib.storages.length && <p className="p-3 text-xs text-zinc-500">到设置中添加存储目录</p>}
        </div>
      </aside>
    </div>}
    {batchDeletion.length > 0 && <BatchDeleteDialog targets={batchDeletion} onClose={() => setBatchDeletion([])} files={region.kind === 'storage'} onDelete={deleteSelected} onComplete={result => {
      setSelected(new Set(result.failures.map(failure => failure.id)))
      setListings({}); setRefresh(value => value + 1)
      if (!result.failures.length) {
        setSelecting(false); setBatchDeletion([])
        toast.success(`已删除 ${result.removed.length} 个素材`)
        if (result.syncWarning) toast.warning(result.syncWarning)
      }
    }} />}
    <Dialog open={assigning} onOpenChange={open => {if (!assignBusy) setAssigning(open)}}>
      <DialogContent onOpenAutoFocus={event => event.preventDefault()} className="max-h-[85dvh] max-w-[92vw] overflow-y-auto rounded-2xl border-zinc-700 bg-zinc-900 text-zinc-100">
        <DialogHeader><DialogTitle>为 {selectedVideoIds.length} 个视频添加演员</DialogTitle><DialogDescription>可选择多位演员，保留每个视频已有的演员和标签。需连接 PC 后应用。</DialogDescription></DialogHeader>
        <div className="max-h-[40dvh] space-y-1 overflow-y-auto">
          {[...new Set([...lib.actors.map(actor => actor.name), ...actorNames])].map(name => <button key={name} role="checkbox" disabled={assignBusy} aria-checked={actorNames.includes(name)} onClick={() => toggleActor(name)} className="flex min-h-12 w-full items-center gap-3 rounded-xl bg-zinc-800 px-3 text-left text-sm">
            <span className={`grid h-5 w-5 shrink-0 place-items-center rounded border ${actorNames.includes(name) ? 'border-amber-500 bg-amber-500 text-black' : 'border-zinc-500'}`}>{actorNames.includes(name) && <Check size={14} />}</span><span>{name}</span>
          </button>)}
          {!lib.actors.length && !actorNames.length && <p className="py-4 text-sm text-zinc-500">暂无演员，可在下面输入姓名。</p>}
        </div>
        <div className="border-t border-zinc-700 pt-3">
          {typingActor ? <form className="flex gap-2" onSubmit={event => {event.preventDefault(); stageActor()}}>
            <input autoFocus value={newActor} onChange={event => setNewActor(event.target.value)} placeholder="输入演员姓名" className="min-w-0 flex-1 rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-2 text-sm" />
            <button type="submit" disabled={!newActor.trim()} className="rounded-lg bg-zinc-700 px-3 text-xs disabled:opacity-40">加入待选</button>
          </form> : <button onClick={() => setTypingActor(true)} className="min-h-11 w-full text-right text-sm text-amber-400">＋ 输入演员姓名</button>}
        </div>
        <Button disabled={assignBusy || (!actorNames.length && !newActor.trim())} className="w-full bg-amber-500 text-black hover:bg-amber-400" onClick={async () => {
          const names = [...new Set([...actorNames, ...(newActor.trim() ? [newActor.trim()] : [])])]
          setAssignBusy(true)
          try {await lib.addActorsToItems(selectedVideoIds, names); toast.success(`已为 ${selectedVideoIds.length} 个视频添加 ${names.length} 位演员`); setAssigning(false); setSelecting(false); setSelected(new Set())}
          catch (error) {toast.error(error instanceof Error ? error.message : '批量设置失败，请连接 PC 后重试')}
          finally {setAssignBusy(false)}
        }}>{assignBusy ? '正在应用…' : `应用到 ${selectedVideoIds.length} 个视频`}</Button>
      </DialogContent>
    </Dialog>
    {moving && <BatchMoveDialog storageId={currentId} entries={moving} parent={currentPath} onClose={() => setMoving(null)} onComplete={result => {
      setSelected(new Set(result.failures.map(failure => failure.id)))
      void refreshFiles()
      if (!result.failures.length) {setMoving(null); setSelecting(false); toast.success(`已移动 ${result.removed.length} 项`)}
    }}/ >}
    <RenameDialog open={creatingFolder} initial="" title="新建文件夹" onClose={() => setCreatingFolder(false)} onSave={async name => {
      await transport.send(`/api/storages/${encodeURIComponent(currentId)}/entries`, 'POST', {path: [currentPath, name].filter(Boolean).join('/')})
      setCreatingFolder(false); await refreshFiles(); toast.success('文件夹已创建')
    }}/>
    <input ref={uploadRef} type="file" multiple hidden onChange={event => {
      const files = Array.from(event.target.files ?? [])
      if (files.length && uploadTarget.current) setUploading({destination: uploadTarget.current, files})
      event.target.value = ''
    }}/>
    {uploading && <UploadDialog destination={uploading.destination} files={uploading.files} onClose={() => setUploading(null)} onComplete={refreshFiles}/ >}
    <input ref={fileRef} type="file" accept="video/*" multiple hidden onChange={e => void onImport(e.target.files)} />
    <input ref={bindRef} type="file" accept="video/*" hidden onChange={async e => {const file = e.target.files?.[0]; if (file && bindTarget.current) {try {await lib.bindFile(bindTarget.current, file); toast.success('已绑定文件')} catch {toast.error('绑定失败')}} if (bindRef.current) bindRef.current.value = ''}} />
    <FileOperationDialog operation={fileOperation} onClose={() => setFileOperation(null)} onDone={(operation, path) => {
      setFileOperation(null); setListings({}); setErrors({}); setRefresh(value => value + 1)
      if (currentId === operation.storageId && (currentPath === operation.entry.path || currentPath.startsWith(operation.entry.path + '/'))) {
        enter(currentId, path + currentPath.slice(operation.entry.path.length))
      }
      void lib.connection.reconnect()
      toast.success(operation.action === 'rename' ? '已重命名' : '已移动')
    }} />
    <RenameDialog open={!!renaming} initial={renaming?.name ?? ''} onClose={() => setRenaming(null)} onSave={async name => {if (renaming) await lib.rename(renaming.id, name); setRenaming(null)}} />
    <AlertDialog open={!!deleting} onOpenChange={open => {if (!open && !deleteBusy) setDeleting(null)}}>
      <AlertDialogContent className="max-w-[92vw] rounded-2xl border-zinc-700 bg-zinc-900 text-zinc-100"><AlertDialogHeader><AlertDialogTitle>删除「{deleteName}」？</AlertDialogTitle><AlertDialogDescription className="break-all text-zinc-400">
        {deleting && 'entry' in deleting && deleting.entry.kind === 'directory' ? '将删除此文件夹及其中的全部文件，并移除关联视频、标记和剪辑记录。此操作不可恢复。' : '将删除原始文件，并移除关联的视频记录、标记和剪辑记录。此操作不可恢复。'}
      </AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={deleteBusy}>取消</AlertDialogCancel><Button className="bg-rose-600 hover:bg-rose-500" disabled={deleteBusy} onClick={async () => {
        if (!deleting) return
        setDeleteBusy(true)
        try {
          if ('item' in deleting) await lib.remove(deleting.item.id)
          else {await transport.send(`/api/storages/${encodeURIComponent(deleting.storageId)}/entries`, 'DELETE', {path: deleting.entry.path}); await lib.connection.reconnect()}
          setDeleting(null); setListings({}); setRefresh(n => n + 1)
          if (treeOpen) for (const st of lib.storages) void load(st.id, '')
          toast.success('已删除')
        } catch (error) {toast.error(error instanceof Error ? error.message : '删除失败，请重试')}
        finally {setDeleteBusy(false)}
      }}>{deleteBusy ? '删除中…' : '确认删除'}</Button></AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
  </div>
}

import {useEffect, useState} from 'react'
import {ChevronRight, Folder, Loader2} from 'lucide-react'
import {transport} from '@/lib/transport'
import {Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog'
import {Button} from '@/components/ui/button'
import {Input} from '@/components/ui/input'
import type {DirectoryListing, FileEntry} from '@/types'

export type FileOperation = {storageId: string; entry: FileEntry; action: 'rename' | 'move'}
export function FileOperationDialog({operation, onClose, onDone}: {operation: FileOperation | null; onClose: () => void; onDone: (operation: FileOperation, path: string) => void}) {
  const [name, setName] = useState('')
  const [directory, setDirectory] = useState('')
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const parent = operation?.entry.path.split('/').slice(0, -1).join('/') ?? ''
  useEffect(() => {
    if (operation) {setName(operation.entry.name); setDirectory(operation.entry.path.split('/').slice(0, -1).join('/')); setError(''); setListing(null)}
  }, [operation])
  useEffect(() => {
    if (!operation || operation.action !== 'move') return
    let cancelled = false
    setLoading(true); setError(''); setListing(null)
    transport.get<DirectoryListing>(`/api/storages/${encodeURIComponent(operation.storageId)}/entries?path=${encodeURIComponent(directory)}`)
      .then(result => {if (!cancelled) setListing(result)})
      .catch(reason => {if (!cancelled) setError(reason instanceof Error ? reason.message : '无法读取文件夹')})
      .finally(() => {if (!cancelled) setLoading(false)})
    return () => {cancelled = true}
  }, [operation, directory, retry])
  const submit = async () => {
    if (!operation || busy) return
    setBusy(true); setError('')
    try {
      const result = await transport.send<{path: string}>(`/api/storages/${encodeURIComponent(operation.storageId)}/entries`, 'PATCH', {
        path: operation.entry.path, action: operation.action, ...(operation.action === 'rename' ? {name: name.trim()} : {directory}),
      })
      onDone(operation, result.path)
    } catch (reason) {setError(reason instanceof Error ? reason.message : '操作失败，请重试')}
    finally {setBusy(false)}
  }
  return <Dialog open={!!operation} onOpenChange={open => {if (!open && !busy) onClose()}}>
    <DialogContent onEscapeKeyDown={event => {if (busy) event.preventDefault()}} onPointerDownOutside={event => {if (busy) event.preventDefault()}} className="max-h-[85dvh] max-w-[92vw] overflow-y-auto rounded-2xl border-zinc-700 bg-zinc-900 text-zinc-100">
      <DialogHeader><DialogTitle>{operation?.action === 'rename' ? '重命名' : '移动到文件夹'}</DialogTitle><DialogDescription className="break-all">{operation?.entry.name} · {operation?.action === 'rename' ? '修改原始文件名称，视频资料会保留。文件请保留扩展名。' : '选择此存储目录内的目标文件夹，视频资料会保留。'}</DialogDescription></DialogHeader>
      {operation?.action === 'rename' ? <Input aria-label="新名称" autoFocus value={name} disabled={busy} onChange={event => setName(event.target.value)} onKeyDown={event => {if (event.key === 'Enter' && name.trim() && name.trim() !== operation.entry.name) void submit()}} className="border-zinc-600 bg-zinc-800" /> : <>
        <nav aria-label="移动目标路径" className="flex flex-wrap items-center gap-1 text-sm text-sky-300">
          <button disabled={busy} className="min-h-10 px-1" onClick={() => setDirectory('')}>存储根目录</button>
          {directory.split('/').filter(Boolean).map((part, index, parts) => <span key={index} className="inline-flex items-center gap-1"><ChevronRight size={13} /><button disabled={busy} className="min-h-10 px-1" onClick={() => setDirectory(parts.slice(0, index + 1).join('/'))}>{part}</button></span>)}
        </nav>
        <div className="max-h-[40dvh] space-y-2 overflow-y-auto">
          {loading && <p role="status" className="flex gap-2 py-4 text-sm text-zinc-400"><Loader2 size={16} className="animate-spin" />读取文件夹…</p>}
          {listing?.entries.filter(entry => entry.kind === 'directory' && !(operation?.entry.kind === 'directory' && (entry.path === operation.entry.path || entry.path.startsWith(operation.entry.path + '/')))).map(entry => <button key={entry.path} disabled={busy} onClick={() => setDirectory(entry.path)} className="flex min-h-14 w-full items-center gap-3 rounded-xl bg-zinc-800 px-3 text-left text-sm"><Folder size={22} className="shrink-0 text-sky-400" /><span className="min-w-0 flex-1 truncate">{entry.name}</span><ChevronRight size={16} /></button>)}
          {listing && !listing.entries.some(entry => entry.kind === 'directory' && entry.path !== operation?.entry.path) && <p className="py-4 text-sm text-zinc-500">没有可进入的子文件夹，可选择当前目录。</p>}
        </div>
      </>}
      {error && <p role="alert" className="break-all text-sm text-rose-400">{error}{operation?.action === 'move' && !listing && <button onClick={() => setRetry(value => value + 1)} className="ml-2 underline">重试</button>}</p>}
      <DialogFooter className="flex-row justify-end gap-2"><Button variant="ghost" disabled={busy} onClick={onClose}>取消</Button><Button className="bg-amber-500 text-black hover:bg-amber-400" disabled={busy || (operation?.action === 'rename' ? !name.trim() || name.trim() === operation.entry.name : loading || !listing || directory === parent)} onClick={() => void submit()}>{busy ? '正在处理…' : operation?.action === 'rename' ? '保存' : '移动到这里'}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}

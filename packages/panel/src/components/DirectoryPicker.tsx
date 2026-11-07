import {useEffect, useState} from 'react'
import {ChevronRight, Folder, Loader2} from 'lucide-react'
import {transport} from '@/lib/transport'
import type {DirectoryListing} from '@/types'

export function DirectoryPicker({storageId, directory, onChange, excluded = [], disabled, onReady}: {
  storageId: string; directory: string; onChange: (path: string) => void
  excluded?: string[]; disabled?: boolean; onReady: (ready: boolean) => void
}) {
  const [retry, setRetry] = useState(0)
  const [response, setResponse] = useState<{key: string; listing?: DirectoryListing; error?: string} | null>(null)
  const key = `${storageId}\u0000${directory}\u0000${retry}`
  const listing = response?.key === key ? response.listing : null
  const error = response?.key === key ? response.error : ''
  useEffect(() => {
    let cancelled = false
    transport.get<DirectoryListing>(`/api/storages/${encodeURIComponent(storageId)}/entries?path=${encodeURIComponent(directory)}`)
      .then(result => {if (!cancelled) {setResponse({key, listing: result}); onReady(true)}})
      .catch(reason => {if (!cancelled) {setResponse({key, error: reason instanceof Error ? reason.message : '无法读取目录'}); onReady(false)}})
    return () => {cancelled = true}
  }, [storageId, directory, key, onReady])
  const folders = listing?.entries.filter(entry => entry.kind === 'directory' && !excluded.some(path => entry.path === path || entry.path.startsWith(path + '/')))
  return <>
    <nav aria-label="移动目标路径" className="flex flex-wrap items-center gap-1 text-sm text-sky-300">
      <button disabled={disabled} className="min-h-10" onClick={() => onChange('')}>存储根目录</button>
      {directory.split('/').filter(Boolean).map((part, index, parts) => <span key={index} className="inline-flex items-center gap-1"><ChevronRight size={13}/><button disabled={disabled} className="min-h-10" onClick={() => onChange(parts.slice(0, index + 1).join('/'))}>{part}</button></span>)}
    </nav>
    <div className="max-h-[35dvh] space-y-2 overflow-y-auto">
      {!listing && !error && <p role="status" className="flex gap-2 py-3 text-sm text-zinc-400"><Loader2 size={16} className="animate-spin"/>读取文件夹…</p>}
      {folders?.map(entry => <button key={entry.path} disabled={disabled} onClick={() => onChange(entry.path)} className="flex min-h-12 w-full items-center gap-3 rounded-xl bg-zinc-800 px-3 text-left text-sm"><Folder size={20} className="text-sky-400"/><span className="min-w-0 flex-1 truncate">{entry.name}</span><ChevronRight size={16}/></button>)}
      {listing && !folders?.length && <p className="py-3 text-sm text-zinc-500">没有可进入的子文件夹，可选择当前目录。</p>}
    </div>
    {error && <p role="alert" className="text-sm text-rose-400">{error}<button disabled={disabled} onClick={() => {onReady(false); setRetry(value => value + 1)}} className="ml-2 underline">重试</button></p>}
  </>
}

import {useRef, useState} from 'react'
import {transport} from '@/lib/transport'
import {type BatchDeleteResult} from '@/lib/batch-delete'
import {DirectoryPicker} from '@/components/DirectoryPicker'
import {Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog'
import {Button} from '@/components/ui/button'
import type {FileEntry} from '@/types'

export function BatchMoveDialog({storageId, entries, parent, onClose, onComplete}: {
  storageId: string; entries: FileEntry[]; parent: string; onClose: () => void
  onComplete: (result: BatchDeleteResult) => void
}) {
  const [directory, setDirectory] = useState(parent)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [result, setResult] = useState<BatchDeleteResult | null>(null)
  const completed = useRef(new Set<string>())
  const lock = useRef(false)
  const start = async () => {
    if (lock.current) return
    lock.current = true; setBusy(true)
    try {
      const ids = result ? result.failures.map(failure => failure.id) : entries.map(entry => entry.path)
      const latest: BatchDeleteResult = {removed: [], failures: []}
      for (const [index, path] of ids.entries()) {
        try {
          await transport.send(`/api/storages/${encodeURIComponent(storageId)}/entries`, 'PATCH', {path, action: 'move', directory})
          latest.removed.push(path)
        } catch (reason) {
          latest.failures.push({id: path, message: reason instanceof Error ? reason.message : '移动失败，请重试'})
          if (reason instanceof TypeError) {
            latest.failures.push(...ids.slice(index + 1).map(id => ({id, message: '连接中断，尚未移动'})))
            break
          }
        }
        setProgress(`${index + 1} / ${ids.length}`)
      }
      latest.removed.forEach(id => completed.current.add(id))
      const merged = {...latest, removed: [...completed.current]}
      setResult(merged); onComplete(merged)
    } finally {lock.current = false; setBusy(false)}
  }
  return <Dialog open onOpenChange={open => {if (!open && !lock.current) onClose()}}>
    <DialogContent onEscapeKeyDown={event => {if (lock.current) event.preventDefault()}} onPointerDownOutside={event => {if (lock.current) event.preventDefault()}} className="max-h-[85dvh] max-w-[92vw] overflow-y-auto rounded-2xl border-zinc-700 bg-zinc-900 text-zinc-100">
      <DialogHeader><DialogTitle>{result ? `已移动 ${result.removed.length} 项，${result.failures.length} 项未移动` : `移动选中的 ${entries.length} 项`}</DialogTitle><DialogDescription>选择同一存储内的目标文件夹。视频资料会保留，同名项目不会覆盖。</DialogDescription></DialogHeader>
      <DirectoryPicker storageId={storageId} directory={directory} onChange={path => {setDirectory(path); setReady(false)}} disabled={busy || !!result} onReady={setReady} excluded={entries.filter(entry => entry.kind === 'directory').map(entry => entry.path)} />
      {result && <ul className="max-h-40 space-y-2 overflow-y-auto text-sm">{result.failures.map(failure => <li key={failure.id} className="break-all">{entries.find(entry => entry.path === failure.id)?.name}<p className="text-xs text-rose-400">{failure.message}</p></li>)}</ul>}
      {busy && <p role="status" className="text-sm text-zinc-400">正在移动 {progress}</p>}
      <DialogFooter className="flex-row justify-end gap-2"><Button variant="ghost" disabled={busy} onClick={onClose}>{result ? '关闭' : '取消'}</Button><Button disabled={busy || !ready || directory === parent || (result !== null && !result.failures.length)} onClick={() => void start()} className="bg-amber-500 text-black hover:bg-amber-400">{busy ? '移动中…' : result ? '重试未移动项目' : '移动到这里'}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}

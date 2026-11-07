import {useRef, useState} from 'react'
import {Loader2, Trash2} from 'lucide-react'
import {Button} from '@/components/ui/button'
import {AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle} from '@/components/ui/alert-dialog'
import type {BatchDeleteResult, DeleteProgress} from '@/lib/batch-delete'

export interface DeleteTarget {id: string; name: string}
export function BatchDeleteDialog({targets, onClose, onDelete, onComplete, files = false}: {
  files?: boolean
  targets: DeleteTarget[]
  onClose: () => void
  onDelete: (ids: string[], onProgress: DeleteProgress) => Promise<BatchDeleteResult>
  onComplete: (result: BatchDeleteResult) => void
}) {
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const [progress, setProgress] = useState({done: 0, total: targets.length})
  const [result, setResult] = useState<BatchDeleteResult | null>(null)
  const [error, setError] = useState('')
  const completed = useRef(new Set<string>())
  const start = async () => {
    if (lock.current) return
    const ids = result ? result.failures.map(failure => failure.id) : targets.map(target => target.id)
    if (!ids.length) return
    lock.current = true; setBusy(true); setError(''); setProgress({done: 0, total: ids.length})
    try {
      const latest = await onDelete(ids, (done, total) => setProgress({done, total}))
      latest.removed.forEach(id => completed.current.add(id))
      const merged = {...latest, removed: [...completed.current]}
      setResult(merged); onComplete(merged)
    } catch (reason) {setError(reason instanceof Error ? reason.message : '删除失败，请重试')}
    finally {lock.current = false; setBusy(false)}
  }
  return <AlertDialog open onOpenChange={open => {if (!open && !lock.current) onClose()}}>
    <AlertDialogContent onEscapeKeyDown={event => {if (lock.current) event.preventDefault()}} className="max-h-[85dvh] max-w-[92vw] overflow-y-auto rounded-2xl border-zinc-700 bg-zinc-900 text-zinc-100">
      <AlertDialogHeader>
        <AlertDialogTitle>{result ? `已删除 ${result.removed.length} 个，${result.failures.length} 个未删除` : `删除选中的 ${targets.length} 个素材？`}</AlertDialogTitle>
        <AlertDialogDescription className="text-zinc-400">{result ? '未删除的素材仍保留选中状态。可以查看原因，或仅重试未删除的项目。' : files ? '将删除原始文件；文件夹会连同全部内容一起删除，关联的视频记录、标记和剪辑记录也会移除。此操作不可恢复。' : '将删除原始视频文件，并移除关联的素材记录、标记和剪辑记录。此操作不可恢复。'}</AlertDialogDescription>
      </AlertDialogHeader>
      <ul className="max-h-52 space-y-2 overflow-y-auto rounded-xl bg-zinc-950/60 p-3 text-sm">
        {result ? result.failures.map(failure => <li key={failure.id} className="break-all"><span>{targets.find(target => target.id === failure.id)?.name ?? failure.id}</span><p className="mt-0.5 text-xs text-rose-400">{failure.message}</p></li>) : targets.map(target => <li key={target.id} className="break-all">{target.name}</li>)}
      </ul>
      {busy && <div role="status" className="flex items-center gap-2 text-sm text-zinc-300"><Loader2 size={16} className="animate-spin" />正在删除 {progress.done} / {progress.total}</div>}
      {error && <p role="alert" className="break-all text-sm text-rose-400">{error}</p>}
      {result?.syncWarning && <p role="status" className="text-xs text-amber-300">{result.syncWarning}</p>}
      <AlertDialogFooter className="flex-row justify-end gap-2">
        <AlertDialogCancel disabled={busy}>{result ? '关闭' : '取消'}</AlertDialogCancel>
        <Button disabled={busy || (result ? !result.failures.length : !targets.length)} onClick={() => void start()} className="gap-2 bg-rose-600 text-white hover:bg-rose-500">
          <Trash2 size={16} />{busy ? '删除中…' : result ? `重试未删除的 ${result.failures.length} 个` : `确认删除 ${targets.length} 个素材`}
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
}

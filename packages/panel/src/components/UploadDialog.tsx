import {useRef, useState} from 'react'
import {transport} from '@/lib/transport'
import {Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog'
import {Button} from '@/components/ui/button'

export type UploadDestination = {storageId: string; path: string; label: string}
export function UploadDialog({destination, files, onClose, onComplete}: {
  destination: UploadDestination; files: File[]; onClose: () => void; onComplete: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [finished, setFinished] = useState(false)
  const [progress, setProgress] = useState('')
  const [failures, setFailures] = useState<{index: number; message: string}[]>([])
  const completed = useRef(new Set<number>())
  const lock = useRef(false)
  const start = async () => {
    if (lock.current) return
    lock.current = true; setBusy(true)
    const errors: typeof failures = []
    try {
      for (let index = 0; index < files.length; index++) {
        if (completed.current.has(index)) continue
        const file = files[index]
        const path = [destination.path, file.name].filter(Boolean).join('/')
        try {
          setProgress(`${file.name} · 0%`)
          await transport.uploadFile(`/api/storages/${encodeURIComponent(destination.storageId)}/files?path=${encodeURIComponent(path)}`, file,
            percent => setProgress(`${file.name} · ${percent}%${percent === 100 ? ' · 正在保存到目标目录' : ''}`))
          completed.current.add(index)
        } catch (reason) {errors.push({index, message: reason instanceof Error ? reason.message : '上传失败'})}
      }
      setFailures(errors); setFinished(true)
      await onComplete()
    } finally {lock.current = false; setBusy(false)}
  }
  return <Dialog open onOpenChange={open => {if (!open && !lock.current) onClose()}}>
    <DialogContent onEscapeKeyDown={event => {if (lock.current) event.preventDefault()}} onPointerDownOutside={event => {if (lock.current) event.preventDefault()}} className="max-h-[85dvh] max-w-[92vw] overflow-y-auto rounded-2xl border-zinc-700 bg-zinc-900 text-zinc-100">
      <DialogHeader><DialogTitle>{finished ? `已上传 ${completed.current.size} 个，${failures.length} 个未上传` : `上传 ${files.length} 个文件`}</DialogTitle><DialogDescription className="break-all">上传到：{destination.label}。同名文件不会覆盖。</DialogDescription></DialogHeader>
      <ul className="max-h-52 space-y-2 overflow-y-auto text-sm">{(finished ? failures : files.map((_, index) => ({index, message: ''}))).map(({index, message}) => <li key={index} className="break-all">{files[index].name}{message && <p className="text-xs text-rose-400">{message}</p>}</li>)}</ul>
      {busy && <p role="status" className="break-all text-sm text-sky-300">{progress}</p>}
      <DialogFooter className="flex-row justify-end gap-2"><Button variant="ghost" disabled={busy} onClick={onClose}>{finished ? '关闭' : '取消'}</Button><Button disabled={busy || (finished && !failures.length)} onClick={() => void start()} className="bg-amber-500 text-black hover:bg-amber-400">{busy ? '上传中…' : finished ? '重试未上传文件' : '上传到此目录'}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}

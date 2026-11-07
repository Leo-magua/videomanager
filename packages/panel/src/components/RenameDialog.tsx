import { useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface Props {
  open: boolean
  initial: string
  onClose: () => void
  onSave: (name: string) => void | Promise<void>
  title?: string
}

export function RenameDialog({ open, initial, onClose, onSave, title = '重命名' }: Props) {
  const [name, setName] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const lock = useRef(false)
  const save = async () => {
    if (lock.current || !name.trim() || name.trim() === initial) return
    lock.current = true; setBusy(true); setError('')
    try {await onSave(name.trim())} catch (reason) {setError(reason instanceof Error ? reason.message : '保存失败，请重试')}
    finally {lock.current = false; setBusy(false)}
  }
  useEffect(() => {
    if (open) {setName(initial); setError('')}
  }, [open, initial])

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !lock.current && onClose()}>
      <DialogContent onEscapeKeyDown={event => {if (lock.current) event.preventDefault()}} onPointerDownOutside={event => {if (lock.current) event.preventDefault()}} className="bg-zinc-900 border-zinc-700 text-zinc-100 max-w-[90vw] rounded-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <Input
          aria-label={title}
          disabled={busy}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void save()}
          className="bg-zinc-800 border-zinc-600 text-zinc-100"
          autoFocus
        />
        {error && <p role="alert" className="text-sm text-rose-400">{error}</p>}
        <DialogFooter className="flex-row justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose} className="text-zinc-400">
            取消
          </Button>
          <Button
            disabled={busy || !name.trim() || name.trim() === initial}
            onClick={() => void save()}
            className="bg-amber-500 text-zinc-950 hover:bg-amber-400"
          >
            {busy ? '保存中…' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

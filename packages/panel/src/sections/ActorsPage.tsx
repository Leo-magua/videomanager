import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Pencil, Plus, Search, Trash2, Users, X } from 'lucide-react'
import { toast } from 'sonner'
import { useDragSelection } from '@/lib/useDragSelection'
import { useLibrary } from '@/store/library'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { TagEditor } from '@/components/TagEditor'
import { RenameDialog } from '@/components/RenameDialog'
import { RatingBar } from '@/components/RatingBar'
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from '@/components/ui/alert-dialog'
import { sourceOf } from '@/types'
import type { ActorRating } from '@/types'

interface Props {
  onOpenActor: (name: string) => void
}

const RATING_DIMS: { key: keyof ActorRating; label: string }[] = [
  { key: 'looks', label: '颜值' },
  { key: 'figure', label: '身材' },
  { key: 'acting', label: '演技' },
]

/** 演员 Tab：演员总数、每位演员携带的标签、出现在哪些素材中 */
export function ActorsPage({ onOpenActor }: Props) {
  const { actors, items, registerActor, patchActor, deleteActors, renameActor } = useLibrary()
  const [query, setQuery] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState<string[]>([])
  const [deleteBusy, setDeleteBusy] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const back = (e: Event) => {
      if (!selecting || deleting.length) return
      e.preventDefault(); setSelecting(false); setSelected(new Set())
    }
    window.addEventListener('vm-back', back)
    return () => window.removeEventListener('vm-back', back)
  }, [selecting, deleting.length])

  // 创建演员表单
  const [newName, setNewName] = useState('')
  const [newTags, setNewTags] = useState<string[]>([])
  const [newItemIds, setNewItemIds] = useState<string[]>([])

  const sources = useMemo(() => {
    const all = items.filter((i) => i.kind === 'source')
    const local = all.filter((i) => sourceOf(i) === 'local')
    const cloud = all.filter((i) => sourceOf(i) === 'cloud')
    return { local, cloud }
  }, [items])

  const list = useMemo(() => {
    if (!query.trim()) return actors
    const q = query.trim().toLowerCase()
    return actors.filter((a) => a.name.toLowerCase().includes(q) || a.tags.some((t) => t.toLowerCase().includes(q)))
  }, [actors, query])

  const dragSelection = useDragSelection({root: rootRef, ids: list.map(actor => actor.name), selected, selecting, setSelected, setSelecting, scope: query, disabled: creating || !!renaming || deleting.length > 0})

  const toggleExpand = (name: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  const resetForm = () => {
    setNewName('')
    setNewTags([])
    setNewItemIds([])
  }

  const submit = async () => {
    const t = newName.trim()
    if (!t) return
    if (actors.some((a) => a.name === t)) {
      toast.error(`演员「${t}」已在目录中`)
      return
    }
    await registerActor(t, newTags, newItemIds)
    toast.success(
      newItemIds.length
        ? `已收录「${t}」，标签并入 ${newItemIds.length} 个关联素材`
        : `已收录演员「${t}」`,
    )
    resetForm()
    setCreating(false)
  }

  const toggleItem = (id: string) =>
    setNewItemIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  const sourceGroup = (title: string, list: typeof sources.local) =>
    list.length > 0 && (
      <div className="mb-3">
        <p className="mb-1.5 text-[11px] text-zinc-500">{title}（{list.length}）</p>
        <div className="max-h-40 space-y-1 overflow-y-auto pr-1">
          {list.map((i) => {
            const checked = newItemIds.includes(i.id)
            return (
              <button
                key={i.id}
                type="button"
                onClick={() => toggleItem(i.id)}
                className={`flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-left transition-colors ${
                  checked ? 'border-amber-500/70 bg-amber-500/10' : 'border-zinc-800 bg-zinc-900'
                }`}
              >
                {i.poster ? (
                  <img src={i.poster} alt="" className="h-8 w-6 shrink-0 rounded object-cover" />
                ) : (
                  <span className="h-8 w-6 shrink-0 rounded bg-zinc-800" />
                )}
                <span className="min-w-0 flex-1 truncate text-xs text-zinc-200">{i.name}</span>
                <span
                  className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border ${
                    checked ? 'border-amber-500 bg-amber-500 text-zinc-950' : 'border-zinc-600'
                  }`}
                >
                  {checked && <Check size={11} />}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    )

  return (
    <div ref={rootRef} className="mx-auto w-full max-w-4xl px-3 pb-24 pt-4 min-[640px]:px-6">
      <RenameDialog open={renaming !== null} initial={renaming ?? ''} title="编辑演员姓名" onClose={() => setRenaming(null)} onSave={async value => {
        if (renaming !== null) {await renameActor(renaming, value); setExpanded(prev => {const next = new Set(prev); if (next.delete(renaming)) next.add(value); return next}); setRenaming(null); toast.success('演员姓名已更新')}
      }} />
      <header className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-zinc-50">
            演员
            <span className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs font-normal text-zinc-300">
              {actors.length} 位
            </span>
          </h1>
          <p className="mt-0.5 text-xs text-zinc-500">长按后滑动连选，或沿勾选框滑动；可批量删除</p>
        </div>
        <button
          onClick={() => {
            resetForm()
            setCreating(true)
          }}
          aria-label="收录新演员"
          title="收录新演员"
          className="grid h-10 w-10 place-items-center rounded-full bg-amber-500 text-zinc-950 active:bg-amber-400"
        >
          <Plus size={18} />
        </button>
      </header>

      <div className="mb-3 flex items-center justify-end gap-3 text-sm">
        {selecting ? <>
          <span className="mr-auto text-zinc-400">已选 {selected.size} 位</span>
          <button onClick={() => setSelected(new Set(list.map(a => a.name)))}>全选当前结果</button>
          <button aria-label="删除所选演员" disabled={!selected.size} className="text-rose-400 disabled:opacity-40" onClick={() => setDeleting([...selected])}><Trash2 size={18} /></button>
          <button aria-label="退出多选" onClick={() => {setSelecting(false); setSelected(new Set())}}><X size={18} /></button>
        </> : <button onClick={() => setSelecting(true)} className="text-zinc-400">多选</button>}
      </div>
      <div className="relative mb-4">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索演员 / 标签"
          className="w-full rounded-full bg-zinc-900 border border-zinc-800 py-2 pl-9 pr-4 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-amber-500/60"
        />
      </div>

      {list.length === 0 ? (
        <div className="mt-20 text-center text-sm text-zinc-500">
          <Users size={36} className="mx-auto mb-3 text-zinc-700" />
          <p>{query ? '没有匹配的演员' : '演员目录为空，点右上角收录第一位演员'}</p>
        </div>
      ) : (
        <ul className="grid gap-2.5 min-[700px]:grid-cols-2">
          {list.map((a) => {
            const open = expanded.has(a.name)
            const ratings = a.ratings ?? { figure: 0, looks: 0, acting: 0 }
            return (
              <li key={a.name} className="rounded-2xl border border-zinc-800 bg-zinc-900 p-3 transition-colors">
                <div className="flex items-center gap-3">
                  <button
                    {...dragSelection.itemProps(a.name)}
                    onClick={() => onOpenActor(a.name)}
                    className="flex min-w-0 flex-1 select-none items-center gap-3 text-left"
                    aria-pressed={selecting ? selected.has(a.name) : undefined}>
                    {selecting && <span data-drag-select-handle style={{touchAction: 'none'}} className={`grid h-6 w-6 shrink-0 place-items-center rounded border ${selected.has(a.name) ? 'border-amber-500 bg-amber-500 text-black' : 'border-zinc-500'}`}>{selected.has(a.name) && <Check size={16} />}</span>}
                    <span className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-full bg-gradient-to-br from-amber-500/30 to-amber-700/20 text-base font-bold text-amber-300">
                      {a.photo ? (
                        <img src={a.photo} alt={a.name} className="h-full w-full object-cover" />
                      ) : (
                        a.name.slice(0, 1)
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-zinc-100">{a.name}</span>
                      {a.tags.length > 0 && (
                        <span className="mt-0.5 block truncate text-[11px] text-zinc-500">{a.tags.join('、')}</span>
                      )}
                    </span>
                  </button>
                  {!selecting && <button onClick={() => setRenaming(a.name)} aria-label={`编辑演员姓名 ${a.name}`} className="rounded-full p-2 text-zinc-400"><Pencil size={17} /></button>}
                  {!selecting && <button onClick={() => setDeleting([a.name])} aria-label={`删除演员 ${a.name}`} className="rounded-full p-2 text-rose-400"><Trash2 size={17} /></button>}
                  {/* 右侧下箭头：展开/折叠 图片 + 三维评分 */}
                  <button
                    onClick={() => toggleExpand(a.name)}
                    aria-label={open ? '折叠' : '展开'}
                    aria-expanded={open}
                    className="shrink-0 rounded-full p-2 text-zinc-400 hover:bg-zinc-800"
                  >
                    <ChevronDown size={18} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
                  </button>
                </div>
                {open && (
                  <div className="mt-3 space-y-2.5 border-t border-zinc-800 pt-3">
                    {a.photo && (
                      <img src={a.photo} alt={a.name} className="max-h-48 w-full rounded-xl object-cover" />
                    )}
                    {RATING_DIMS.map(({ key, label }) => (
                      <RatingBar
                        key={key}
                        label={label}
                        value={ratings[key]}
                        onChange={(v) => patchActor(a.name, { ratings: { ...ratings, [key]: v } })}
                      />
                    ))}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <AlertDialog open={deleting.length > 0} onOpenChange={open => { if (!open && !deleteBusy) setDeleting([]) }}>
        <AlertDialogContent className="max-w-[92vw] rounded-2xl border-zinc-700 bg-zinc-900 text-zinc-100">
          <AlertDialogHeader><AlertDialogTitle>删除 {deleting.length} 位演员？</AlertDialogTitle>
            <AlertDialogDescription>移除演员资料及其与视频、片段的关联。视频文件、标记和已有标签会保留。</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel disabled={deleteBusy}>取消</AlertDialogCancel>
            <Button disabled={deleteBusy} className="bg-rose-600" onClick={async () => {
              setDeleteBusy(true)
              try {await deleteActors(deleting); toast.success(`已删除 ${deleting.length} 位演员`); setDeleting([]); setSelected(new Set()); setSelecting(false)}
              catch (error) {toast.error(error instanceof Error ? error.message : '删除失败，请连接服务器后重试')}
              finally {setDeleteBusy(false)}
            }}>{deleteBusy ? '删除中…' : '删除'}</Button></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {/* 创建演员弹窗：名字 + 标签 + 关联素材（本地/云端） */}
      <Dialog open={creating} onOpenChange={(o) => !o && setCreating(false)}>
        <DialogContent className="max-w-[92vw] max-h-[85dvh] overflow-y-auto rounded-2xl border-zinc-700 bg-zinc-900 text-zinc-100 min-[560px]:max-w-md">
          <DialogHeader>
            <DialogTitle>收录新演员</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <p className="mb-1.5 text-xs text-zinc-500">姓名</p>
              <Input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="演员姓名"
                className="border-zinc-600 bg-zinc-800 text-zinc-100"
              />
            </div>
            <div>
              <p className="mb-1.5 text-xs text-zinc-500">携带标签（添加到素材时自动并入）</p>
              <TagEditor tags={newTags} onChange={setNewTags} placeholder="如：动作、喜剧" />
            </div>
            <div>
              <p className="mb-1.5 text-xs text-zinc-500">
                关联素材（可选{newItemIds.length > 0 && `，已选 ${newItemIds.length} 个`}）
              </p>
              {sources.local.length + sources.cloud.length === 0 ? (
                <p className="text-[11px] text-zinc-600">素材库为空，可稍后在素材详情页关联</p>
              ) : (
                <>
                  {sourceGroup('本机素材', sources.local)}
                  {sourceGroup('远程 / 云端素材', sources.cloud)}
                </>
              )}
            </div>
            <Button
              onClick={submit}
              disabled={!newName.trim()}
              className="w-full bg-amber-500 text-zinc-950 hover:bg-amber-400 disabled:opacity-50"
            >
              收录演员
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

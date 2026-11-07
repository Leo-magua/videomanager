import type { RefObject } from 'react'
import { useEffect, useRef, useState } from 'react'
import {
  ChevronDown, Clapperboard, Clock, CloudOff, Flag,
  MoreVertical, Pencil, Plus, Scissors, Trash2, X,
} from 'lucide-react'
import { toast } from 'sonner'
import { VideoPlayer } from '@/components/VideoPlayer'
import { useLibrary } from '@/store/library'
import { TagEditor } from '@/components/TagEditor'
import { RenameDialog } from '@/components/RenameDialog'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { RatingBar } from '@/components/RatingBar'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { isClipBusy, downloadBlob, runClip } from '@/lib/clipper'
import { formatTime } from '@/types'
import type { ClipStatus, Mark, MediaItem } from '@/types'

interface Props {
  playerRef: RefObject<HTMLDivElement | null>
  id: string
  onBack: () => void
  onChangeVideo: (id: string) => void
}

/** 剪辑状态圆点：绿=已完成 蓝=剪辑中 灰=待剪辑 红=失败 */
const STATUS_DOT: Record<ClipStatus, string> = {
  completed: 'bg-emerald-500',
  cutting: 'bg-sky-500 animate-pulse',
  pending: 'bg-zinc-500',
  failed: 'bg-rose-500',
}
const STATUS_TEXT: Record<ClipStatus, string> = {
  completed: '已剪辑',
  cutting: '剪辑中',
  pending: '待剪辑',
  failed: '剪辑失败',
}

/** 参考项目算法：按时间排序后相邻两两成段（0–1、2–3…）；奇数个时末段结束=视频总长。 */
function segmentsFromMarks(marks: Mark[], duration: number): { start: number; end: number }[] {
  if (marks.length === 0) return []
  const sorted = [...marks].sort((a, b) => a.time - b.time)
  const out: { start: number; end: number }[] = []
  for (let i = 0; i < sorted.length; i += 2) {
    const start = sorted[i].time
    const end = i + 1 < sorted.length ? sorted[i + 1].time : duration > 0 ? duration : start
    out.push({ start, end })
  }
  return out
}

/** 素材详情页：1.播放窗口（直接播放打点） 2.素材信息（可折叠） 3.标记列表（可折叠） 4.片段列表（可折叠） */
export function MediaDetailPage({ id, onBack, onChangeVideo, playerRef }: Props) {
  const lib = useLibrary()
  const item = lib.get(id)
  const clips = lib.clipsOf(id)
  const [renaming, setRenaming] = useState(false)
  const [castInput, setCastInput] = useState('')
  const [addingCast, setAddingCast] = useState(false)
  const [typingCast, setTypingCast] = useState(false)
  const [castBusy, setCastBusy] = useState(false)
  const [infoOpen, setInfoOpen] = useState(true)
  const [marksOpen, setMarksOpen] = useState(true)
  const [clipsOpen, setClipsOpen] = useState(true)
  const bindRef = useRef<HTMLInputElement>(null)
  const [binding, setBinding] = useState(false)

  const videoRef = useRef<HTMLVideoElement>(null)
  const [videoInfo, setVideoInfo] = useState({id, duration: 0})
  const vidDuration = videoInfo.id === id ? videoInfo.duration : 0

  // 片段卡片操作
  const [renamingClip, setRenamingClip] = useState<MediaItem | null>(null)
  const [deletingClip, setDeletingClip] = useState<MediaItem | null>(null)
  // 标记操作
  const [renamingMark, setRenamingMark] = useState<Mark | null>(null)
  const [timeMark, setTimeMark] = useState<Mark | null>(null)

  const isClipItem = item?.kind === 'clip'
  const sourceId = isClipItem ? item!.parentId! : id
  const rangeStart = item?.rangeStart ?? 0
  // 有效总时长：优先 DB duration（已被处理器回填），否则用播放器实际读到的时长兜底
  const effDuration = (item?.duration ?? 0) > 0 ? item!.duration : vidDuration
  const rangeEnd = item?.rangeEnd ?? effDuration

  useEffect(() => {
    setRenaming(false); setAddingCast(false)
    setRenamingMark(null); setTimeMark(null); setRenamingClip(null); setDeletingClip(null)
  }, [id])

  const mark = async () => {
    const v = videoRef.current
    if (!item || !v) return
    const t = isClipItem ? v.currentTime - rangeStart : v.currentTime
    const newMark = await lib.addMark(item.id, Math.max(0, t))
    toast.success(`已在 ${formatTime(Math.max(0, t))} 打点`, { duration: 1200 })
    // 打到偶数点时，最新一对标记自动成段（仅源素材；片段内不再嵌套生成）
    if (newMark && !isClipItem) {
      const marks = [...item.marks, newMark]
      if (marks.length % 2 === 0) {
        const n = await generateFromMarks(marks)
        if (n > 0) toast.info('已按最新两个标记自动生成建议片段', { duration: 1600 })
      }
    }
  }

  /** 参考「从打点生成」：把标记两两成段，补齐所有尚未存在的建议片段（去重），返回新建数量。 */
  const generateFromMarks = async (marks: Mark[]): Promise<number> => {
    if (!item || isClipItem) return 0
    const segs = segmentsFromMarks(marks, effDuration)
    // 已存在片段的区间（四舍五入到 0.1s 比较，避免浮点重复）
    const key = (s: number, e: number) => `${Math.round(s * 10)}-${Math.round(e * 10)}`
    const existing = new Set(clips.map((c) => key(c.rangeStart ?? 0, c.rangeEnd ?? 0)))
    let created = 0
    for (const seg of segs) {
      if (seg.end <= seg.start) continue
      if (existing.has(key(seg.start, seg.end))) continue
      existing.add(key(seg.start, seg.end))
      await lib.createClip(
        item.id,
        seg.start,
        seg.end,
        `${item.name} · 建议片段 ${formatTime(seg.start)}–${formatTime(seg.end)}`,
      )
      created++
    }
    return created
  }

  // ===== 片段操作：剪辑执行 / 下载 / 重命名 / 删除 =====
  const runCut = async (clip: MediaItem) => {
    if (clip.clipStatus === 'completed' || clip.clipStatus === 'cutting') return
    if (isClipBusy()) {
      toast.error('已有剪辑任务在执行，请稍候')
      return
    }
    const src = await lib.objectURL(sourceId)
    if (!src) {
      toast.error('母素材文件不可用')
      return
    }
    await lib.patch(clip.id, { clipStatus: 'cutting' })
    try {
      const blob = await runClip({ src, start: clip.rangeStart ?? 0, end: clip.rangeEnd ?? 0 })
      await lib.patch(clip.id, { clipStatus: 'completed' })
      downloadBlob(blob, `${clip.name.replace(/\.[^.]+$/, '')}.webm`)
      toast.success(`「${clip.name}」剪辑完成，文件已下载`)
    } catch (e) {
      await lib.patch(clip.id, { clipStatus: 'failed' })
      toast.error(e instanceof Error ? `剪辑失败：${e.message}` : '剪辑失败')
    }
  }

  if (!item) {
    return (
      <div className="grid min-h-dvh place-items-center text-zinc-500">
        <button onClick={onBack} className="text-amber-400">← 返回</button>
      </div>
    )
  }

  const cast = item.cast ?? []

  const commitCast = async (name = castInput.trim()) => {
    if (!name || cast.includes(name) || castBusy) return
    setCastBusy(true)
    try {
      await lib.addActorToItem(item.id, name)
      setCastInput(''); setTypingCast(false); setAddingCast(false)
      toast.success(`已添加演员「${name}」`)
    } catch { toast.error('添加失败，请重试') }
    finally { setCastBusy(false) }
  }
  const sourceLabel = item.sourceKind === 'remote' ? '远程设备' : item.sourceKind === 'nas' ? '网络存储' : item.sourceKind === 'cloud' || !item.hasFile ? '云端素材' : '本机存储'


  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col bg-zinc-950">
      {/* 顶栏 */}
      <header className="sticky top-0 z-10 flex items-center gap-2 bg-zinc-950/90 px-3 py-2.5 backdrop-blur">
        <span className="text-sm text-zinc-400">{isClipItem ? '剪辑详情' : '素材详情'}</span>
        <div className="flex-1" />
        {!item.hasFile && item.cloudId && (
          <span className="inline-flex items-center gap-1 rounded-full bg-zinc-800 px-2.5 py-1 text-[10px] text-zinc-400">
            <CloudOff size={11} /> 云端 · 待下载
          </span>
        )}
        <button onClick={() => setRenaming(true)} className="rounded-full p-2 text-zinc-400 hover:bg-zinc-800" aria-label="重命名">
          <Pencil size={18} />
        </button>
      </header>

      <VideoPlayer item={item} items={lib.items} stageRef={playerRef} videoRef={videoRef} resolveURL={lib.objectURL}
        onChangeVideo={onChangeVideo} onDuration={duration => setVideoInfo({id, duration})} onMark={mark} binding={binding} onBind={() => bindRef.current?.click()} />
      <input ref={bindRef} type="file" accept="video/*" hidden onChange={async event => {
        const file = event.target.files?.[0]
        if (!file) return
        setBinding(true)
        try {await lib.bindFile(item.id, file); toast.success('已绑定文件')}
        catch {toast.error('绑定失败，请重试')}
        finally {setBinding(false); event.target.value = ''}
      }} />

      <Dialog open={addingCast} onOpenChange={open => {setAddingCast(open); if (!open) {setTypingCast(false); setCastInput('')}}}>
        <DialogContent onOpenAutoFocus={e => e.preventDefault()} className="max-h-[80dvh] max-w-[92vw] overflow-y-auto rounded-2xl border-zinc-700 bg-zinc-900 text-zinc-100">
          <DialogHeader><DialogTitle>添加演员</DialogTitle></DialogHeader>
          <div className="max-h-[45dvh] space-y-1 overflow-y-auto">
            {lib.actors.length === 0 && <p className="py-4 text-sm text-zinc-500">暂无已收录演员</p>}
            {lib.actors.map(actor => <button key={actor.name} disabled={cast.includes(actor.name) || castBusy} onClick={() => commitCast(actor.name)} className="flex min-h-12 w-full items-center justify-between rounded-xl bg-zinc-800 px-3 text-left text-sm disabled:opacity-40">
              <span>{actor.name}</span><span className="text-xs text-zinc-500">{cast.includes(actor.name) ? '已添加' : '添加'}</span>
            </button>)}
          </div>
          <div className="border-t border-zinc-700 pt-3">
            {typingCast ? <form onSubmit={e => {e.preventDefault(); void commitCast()}} className="flex gap-2">
              <input autoFocus value={castInput} onChange={e => setCastInput(e.target.value)} placeholder="输入演员姓名" className="min-w-0 flex-1 rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-2 text-sm" />
              <button type="submit" disabled={!castInput.trim() || castBusy} className="rounded-lg bg-amber-500 px-3 text-sm text-black disabled:opacity-40">添加</button>
            </form> : <button onClick={() => setTypingCast(true)} className="min-h-11 w-full text-right text-sm text-amber-400">＋ 输入演员姓名</button>}
          </div>
        </DialogContent>
      </Dialog>

      <div className="px-4 pb-16 min-[640px]:px-6">
        {/* ===== 2. 素材信息（可折叠，标题即素材名） ===== */}
        <section className="mt-4">
          <button
            onClick={() => setInfoOpen(!infoOpen)}
            className="flex w-full items-center justify-between gap-3 py-1"
            aria-expanded={infoOpen}
          >
            <span className="flex min-w-0 items-baseline gap-2">
              <h1 className="min-w-0 truncate text-left text-lg font-bold leading-tight text-zinc-50">{item.name}</h1>
              {item.year && <span className="shrink-0 text-xs font-normal text-zinc-500">{item.year}</span>}
            </span>
            <ChevronDown size={16} className={`shrink-0 text-zinc-500 transition-transform ${infoOpen ? 'rotate-180' : ''}`} />
          </button>

          {infoOpen && (
            <div className="space-y-4 pt-3">
              <div className="rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs">
                <p className="text-zinc-400">{sourceLabel}{item.storageName ? ` · ${item.storageName}` : ''}</p>
                <p className="mt-1 break-all font-mono text-zinc-300 select-text">{item.originalPath || item.filePath || '未记录原始路径'}</p>
              </div>
              {/* 打分 */}
              <RatingBar label="打分" value={item.rating} onChange={(v) => lib.patch(item.id, { rating: v })} />

              {/* 标签行 */}
              <TagEditor alignAddRight tags={item.tags} onChange={(tags) => lib.setItemTags(item.id, tags)} />

              {/* 简介 */}
              <EditableSynopsis
                value={item.synopsis ?? ''}
                onSave={(synopsis) => lib.patch(item.id, { synopsis })}
              />

              {/* 演员信息 */}
              <div>
                <p className="mb-2 text-xs text-zinc-500">演员信息</p>
                <div className="flex flex-wrap gap-1.5">
                  {cast.map((c) => {
                    const entry = lib.actorOf(c)
                    return (
                      <span
                        key={c}
                        title={entry?.tags.length ? `携带标签：${entry.tags.join('、')}` : '目录中暂无标签'}
                        className="inline-flex items-center gap-1 rounded-full border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-200"
                      >
                        {c}
                        <button
                          onClick={() => lib.removeActorFromItem(item.id, c)}
                          className="text-zinc-500 hover:text-zinc-300"
                          aria-label={`移除 ${c}`}
                        >
                          <X size={12} />
                        </button>
                      </span>
                    )
                  })}
                  <button onClick={() => {setTypingCast(false); setAddingCast(true)}}
                    className="ml-auto inline-flex items-center gap-1 rounded-full border border-dashed border-zinc-600 px-2.5 py-1 text-xs text-zinc-400 hover:border-amber-500/60">
                    <Plus size={12} /> 添加演员
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>

        {/* ===== 3. 标记列表（可折叠） ===== */}
        <section className="mt-5">
          <button
            onClick={() => setMarksOpen(!marksOpen)}
            className="flex w-full items-center justify-between py-1"
            aria-expanded={marksOpen}
          >
            <h2 className="flex items-center gap-1.5 text-sm font-semibold text-zinc-200">
              <Flag size={14} className="text-amber-400" /> 标记列表 ({item.marks.length})
            </h2>
            <ChevronDown size={16} className={`text-zinc-500 transition-transform ${marksOpen ? 'rotate-180' : ''}`} />
          </button>
          {marksOpen &&
            (item.marks.length === 0 ? (
              <p className="mt-2 text-xs text-zinc-600">暂无标记，点击视频上的「打点」后会同步到这里</p>
            ) : (
              <>
                {!isClipItem && (
                  <div className="mt-2 flex items-center justify-between gap-2 rounded-xl border border-sky-500/25 bg-sky-500/5 px-2.5 py-2">
                    <p className="min-w-0 text-[11px] leading-tight text-zinc-400">
                      两两成对：第 1–2、3–4… 段
                      {item.marks.length % 2 === 1 && <span className="text-amber-400">（末段结束用视频总长）</span>}
                      <br />
                      <span className="text-zinc-500">
                        {item.marks.length} 个标记 → 可生成 {Math.ceil(item.marks.length / 2)} 段
                      </span>
                    </p>
                    <button
                      onClick={async () => {
                        const n = await generateFromMarks(item.marks)
                        if (n > 0) toast.success(`已生成 ${n} 个建议片段`)
                        else toast.info('没有新的片段可生成（都已存在）')
                        setClipsOpen(true)
                      }}
                      className="shrink-0 rounded-lg bg-sky-500 px-2.5 py-1.5 text-xs font-semibold text-zinc-950 active:bg-sky-400"
                    >
                      从标记生成
                    </button>
                  </div>
                )}
                <ul className="mt-2 space-y-1.5">
                  {item.marks.map((m) => (
                    <li
                      key={m.id}
                      className="flex items-center gap-2.5 rounded-xl border border-zinc-800 bg-zinc-900 px-2.5 py-2"
                    >
                      <button onClick={() => {const v = videoRef.current; if (v) v.currentTime = (isClipItem ? rangeStart : 0) + m.time}}
                        className="shrink-0 rounded bg-zinc-800 px-2 py-1 font-mono text-xs text-amber-400" title="跳转到标记时间">{formatTime(m.time)}</button>
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{background: m.color}} />
                      <span className="flex-1" />
                      {/* 三点菜单：重命名 / 设置时间 / 删除 */}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button className="shrink-0 rounded-full p-1 text-zinc-500 hover:bg-zinc-800" aria-label="标记操作">
                            <MoreVertical size={15} />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="bg-zinc-900 border-zinc-700 text-zinc-200">
                          <DropdownMenuItem onClick={() => setRenamingMark(m)}>
                            <Pencil size={14} className="mr-2" /> 重命名
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setTimeMark(m)}>
                            <Clock size={14} className="mr-2" /> 设置时间
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={async () => {
                              await lib.removeMark(item.id, m.id)
                              toast.success('标记已删除')
                            }}
                            className="text-rose-400 focus:text-rose-300"
                          >
                            <Trash2 size={14} className="mr-2" /> 删除
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                      <button onClick={() => setRenamingMark(m)} className="min-w-0 max-w-[60%] truncate rounded-lg px-2 py-2 text-right text-[13px] text-zinc-100" title="点击修改标记名称">{m.label || '未命名标记'} <Pencil size={12} className="ml-1 inline text-zinc-500" /></button>
                    </li>
                  ))}
                </ul>
              </>
            ))}
        </section>

        {/* ===== 4. 片段列表（可折叠，横条卡片） ===== */}
        <section className="mt-5">
          <button
            onClick={() => setClipsOpen(!clipsOpen)}
            className="flex w-full items-center justify-between py-1"
            aria-expanded={clipsOpen}
          >
            <h2 className="flex items-center gap-1.5 text-sm font-semibold text-zinc-200">
              <Clapperboard size={14} className="text-sky-400" /> 片段列表 ({clips.length})
            </h2>
            <ChevronDown size={16} className={`text-zinc-500 transition-transform ${clipsOpen ? 'rotate-180' : ''}`} />
          </button>
          {clipsOpen &&
            (clips.length === 0 ? (
              <p className="mt-2 text-xs text-zinc-600">按标记截取后，片段会列在这里</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {clips.map((c) => {
                  const status: ClipStatus = c.clipStatus ?? 'completed'
                  return (
                    <li
                      key={c.id}
                      className="relative flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900 p-2.5"
                    >
                      {/* 状态圆点（右上角） */}
                      <span
                        className={`absolute right-2 top-2 h-2 w-2 rounded-full ${STATUS_DOT[status]}`}
                        title={STATUS_TEXT[status]}
                      />
                      {c.poster ? (
                        <img src={c.poster} alt="" className="h-12 w-9 shrink-0 rounded object-cover" />
                      ) : (
                        <span className="h-12 w-9 shrink-0 rounded bg-zinc-800" />
                      )}
                      {/* 片段名称 + 片段信息 */}
                      <div className="min-w-0 flex-1">
                        <p className="truncate pr-3 text-[13px] text-zinc-100">{c.name}</p>
                        <p className="mt-0.5 truncate text-[11px] text-zinc-500">
                          {formatTime(c.rangeStart ?? 0)} → {formatTime(c.rangeEnd ?? 0)} · {formatTime(c.duration)} · {STATUS_TEXT[status]}
                        </p>
                      </div>
                      {/* 三点菜单 */}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button className="shrink-0 rounded-full p-1.5 text-zinc-500 hover:bg-zinc-800" aria-label="片段操作">
                            <MoreVertical size={16} />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="bg-zinc-900 border-zinc-700 text-zinc-200">
                          <DropdownMenuItem onClick={() => setRenamingClip(c)}>
                            <Pencil size={14} className="mr-2" /> 重命名
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={status === 'completed' || status === 'cutting'}
                            onClick={() => runCut(c)}
                          >
                            <Scissors size={14} className="mr-2" /> 剪辑执行
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setDeletingClip(c)} className="text-rose-400 focus:text-rose-300">
                            <Trash2 size={14} className="mr-2" /> 删除
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </li>
                  )
                })}
              </ul>
            ))}
        </section>
      </div>

      {/* 素材重命名 */}
      <RenameDialog
        open={renaming}
        initial={item.name}
        onClose={() => setRenaming(false)}
        onSave={async (name) => {
          const { cloudSynced } = await lib.rename(item.id, name)
          setRenaming(false)
          toast.success(cloudSynced ? '已重命名，云端记录名称已同步修改' : '已重命名')
        }}
      />

      {/* 标记重命名 */}
      <RenameDialog
        open={!!renamingMark}
        initial={renamingMark?.label ?? ''}
        onClose={() => setRenamingMark(null)}
        onSave={async (label) => {
          if (renamingMark) {
            await lib.updateMark(item.id, renamingMark.id, { label })
            toast.success('标记已重命名')
          }
          setRenamingMark(null)
        }}
      />

      {/* 标记设置时间 */}
      {timeMark && <MarkTimeDialog key={timeMark.id}
        mark={timeMark}
        max={isClipItem ? rangeEnd - rangeStart : effDuration}
        onClose={() => setTimeMark(null)}
        onSave={async (t) => {
          if (timeMark) {
            await lib.updateMark(item.id, timeMark.id, { time: t })
            toast.success(`标记时间已设为 ${formatTime(t)}`)
          }
          setTimeMark(null)
        }}
      />}

      {/* 片段重命名 */}
      <RenameDialog
        open={!!renamingClip}
        initial={renamingClip?.name ?? ''}
        onClose={() => setRenamingClip(null)}
        onSave={async (name) => {
          if (renamingClip) {
            await lib.rename(renamingClip.id, name)
            toast.success('片段已重命名')
          }
          setRenamingClip(null)
        }}
      />

      {/* 片段删除确认 */}
      <AlertDialog open={!!deletingClip} onOpenChange={(o) => !o && setDeletingClip(null)}>
        <AlertDialogContent className="bg-zinc-900 border-zinc-700 text-zinc-100 max-w-[90vw] rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>删除片段「{deletingClip?.name}」？</AlertDialogTitle>
            <AlertDialogDescription className="text-zinc-400">
              删除后不可恢复，母素材与其标记不受影响。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="bg-transparent border-zinc-700 text-zinc-300">取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 text-white hover:bg-rose-500"
              onClick={async () => {
                if (deletingClip) {
                  await lib.remove(deletingClip.id)
                  toast.success('片段已删除')
                }
                setDeletingClip(null)
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** 解析手动输入的时间：支持 ss / mm:ss / hh:mm:ss（可带小数秒） */
function parseTimeInput(s: string): number | null {
  const t = s.trim()
  if (!t) return null
  const parts = t.split(':')
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null
  let sec = 0
  for (const p of parts) sec = sec * 60 + Number(p)
  return sec
}

/** 标记设置时间对话框 */
function MarkTimeDialog({
  mark,
  max,
  onClose,
  onSave,
}: {
  mark: Mark
  max: number
  onClose: () => void
  onSave: (t: number) => void
}) {
  const [text, setText] = useState(() => formatTime(mark.time))

  const commit = () => {
    const t = parseTimeInput(text)
    if (t === null) {
      toast.error('时间格式不正确，支持 秒 或 mm:ss')
      return
    }
    onSave(Math.min(Math.max(0, t), Math.max(0, max)))
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-zinc-950/70 p-6" onClick={onClose}>
      <div
        className="w-full max-w-xs rounded-2xl border border-zinc-700 bg-zinc-900 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-sm font-semibold text-zinc-100">设置「{mark.label}」的时间</p>
        <p className="mt-1 text-[11px] text-zinc-500">支持 秒 或 mm:ss 格式，范围 00:00 ~ {formatTime(max)}</p>
        <input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') onClose()
          }}
          className="mt-3 w-full rounded-lg border border-amber-500/60 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100 outline-none"
        />
        <div className="mt-3 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800">
            取消
          </button>
          <button
            onClick={commit}
            className="rounded-lg bg-amber-500 px-3 py-1.5 text-sm font-semibold text-zinc-950 active:bg-amber-400"
          >
            确定
          </button>
        </div>
      </div>
    </div>
  )
}

/** 简介：点击查看，编辑后失焦保存 */
function EditableSynopsis({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(value)
  if (editing) {
    return (
      <textarea
        autoFocus
        defaultValue={value}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          onSave(text)
          setEditing(false)
        }}
        rows={3}
        className="w-full rounded-xl border border-amber-500/60 bg-zinc-900 p-3 text-sm text-zinc-200 outline-none"
      />
    )
  }
  return (
    <p
      onClick={() => {
        setText(value)
        setEditing(true)
      }}
      className="cursor-text rounded-xl bg-zinc-900 p-3 text-sm leading-relaxed text-zinc-400"
    >
      {value || '点击添加简介…'}
    </p>
  )
}

import { useState } from 'react'
import { Clapperboard, Flag, MoreVertical, Pencil, Play, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useLibrary } from '@/store/library'
import { RatingBar } from '@/components/RatingBar'
import { TagEditor } from '@/components/TagEditor'
import { RenameDialog } from '@/components/RenameDialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { formatTime } from '@/types'
import type { MediaItem } from '@/types'

interface Props {
  onOpenPlayer: (id: string) => void
}

/** 剪辑片段列表：保留后续操作（播放/导出/打分/标签/重命名/删除） */
export function ClipsPage({ onOpenPlayer }: Props) {
  const { items, patch, rename, remove } = useLibrary()
  const clips = items.filter((i) => i.kind === 'clip')
  const [renaming, setRenaming] = useState<MediaItem | null>(null)
  const [deleting, setDeleting] = useState<MediaItem | null>(null)

  return (
    <div className="mx-auto w-full max-w-4xl px-3 pb-24 pt-4 min-[640px]:px-6">
      <header className="mb-4">
        <h1 className="text-xl font-bold text-zinc-50">剪辑片段</h1>
        <p className="mt-0.5 text-xs text-zinc-500">按标记截取的产物 · 可继续打分、加标签、再剪辑或导出</p>
      </header>

      {clips.length === 0 ? (
        <div className="mt-24 text-center">
          <Clapperboard size={40} className="mx-auto mb-3 text-zinc-700" />
          <p className="text-sm text-zinc-500">还没有剪辑片段</p>
          <p className="mt-1 text-xs text-zinc-600">在播放页为标记设定起点/终点即可生成</p>
        </div>
      ) : (
        <ul className="grid gap-3 min-[700px]:grid-cols-2">
          {clips.map((c) => (
            <li key={c.id} className="rounded-2xl border border-zinc-800 bg-zinc-900 p-3">
              <div className="flex gap-3">
                <button onClick={() => onOpenPlayer(c.id)} className="relative shrink-0 overflow-hidden rounded-lg">
                  {c.poster ? (
                    <img src={c.poster} alt="" className="h-24 w-[72px] object-cover" />
                  ) : (
                    <div className="grid h-24 w-[72px] place-items-center bg-zinc-800 text-zinc-600">
                      <Play size={22} />
                    </div>
                  )}
                  <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 font-mono text-[10px] text-zinc-200">
                    {formatTime(c.duration)}
                  </span>
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-1">
                    <button onClick={() => onOpenPlayer(c.id)} className="min-w-0 text-left">
                      <p className="truncate text-sm font-medium text-zinc-100">{c.name}</p>
                      <p className="mt-0.5 truncate text-[11px] text-sky-400/80">源自：{c.parentName}</p>
                      <p className="mt-0.5 font-mono text-[11px] text-zinc-500">
                        {formatTime(c.rangeStart ?? 0)} → {formatTime(c.rangeEnd ?? 0)}
                      </p>
                    </button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button className="rounded-full p-1.5 text-zinc-500 hover:bg-zinc-800" aria-label="更多操作">
                          <MoreVertical size={16} />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="border-zinc-700 bg-zinc-900 text-zinc-200">
                        <DropdownMenuItem onClick={() => onOpenPlayer(c.id)}>
                          <Play size={14} className="mr-2" /> 播放 / 导出片段
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setRenaming(c)}>
                          <Pencil size={14} className="mr-2" /> 重命名
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setDeleting(c)} className="text-rose-400 focus:text-rose-300">
                          <Trash2 size={14} className="mr-2" /> 删除
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <div className="mt-1.5">
                    <RatingBar label="打分" value={c.rating} onChange={(v) => patch(c.id, { rating: v })} />
                  </div>
                </div>
              </div>
              <div className="mt-2.5 flex items-center justify-between gap-2">
                <TagEditor compact tags={c.tags} onChange={(tags) => patch(c.id, { tags })} />
                {c.marks.length > 0 && (
                  <span className="inline-flex shrink-0 items-center gap-0.5 text-[10px] text-amber-300">
                    <Flag size={10} /> {c.marks.length}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <RenameDialog
        open={!!renaming}
        initial={renaming?.name ?? ''}
        onClose={() => setRenaming(null)}
        onSave={async (name) => {
          if (renaming) {
            await rename(renaming.id, name)
            toast.success('已重命名')
          }
          setRenaming(null)
        }}
      />

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent className="max-w-[90vw] rounded-2xl border-zinc-700 bg-zinc-900 text-zinc-100">
          <AlertDialogHeader>
            <AlertDialogTitle>删除「{deleting?.name}」？</AlertDialogTitle>
            <AlertDialogDescription className="text-zinc-400">母素材不受影响，仅删除该剪辑记录。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-zinc-700 bg-transparent text-zinc-300">取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 text-white hover:bg-rose-500"
              onClick={async () => {
                if (deleting) await remove(deleting.id)
                setDeleting(null)
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

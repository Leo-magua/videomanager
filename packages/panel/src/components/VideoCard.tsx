import { Cloud, CloudOff, Flag, MoreVertical, Pencil, Play, Scissors, Star, Trash2, Info } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { formatSize, formatTime } from '@/types'
import type { MediaItem } from '@/types'

interface Props {
  item: MediaItem
  onPlay: () => void
  onDetail: () => void
  onRename: () => void
  onDelete: () => void
}

const KIND_LABEL: Record<MediaItem['kind'], string> = { source: '素材', clip: '剪辑' }
const KIND_STYLE: Record<MediaItem['kind'], string> = {
  source: 'bg-amber-500/90 text-zinc-950',
  clip: 'bg-sky-500/90 text-zinc-950',
}

export function VideoCard({ item, onPlay, onDetail, onRename, onDelete }: Props) {
  return (
    <div className="group rounded-xl overflow-hidden bg-zinc-900 border border-zinc-800 active:border-zinc-600 transition-colors">
      {/* 封面区 */}
      <button type="button" onClick={onPlay} className="relative block w-full aspect-[3/4] bg-zinc-800 text-left">
        {item.poster ? (
          <img src={item.poster} alt={item.name} className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <div className="absolute inset-0 grid place-items-center text-zinc-600">
            <Play size={36} />
          </div>
        )}
        <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/80 to-transparent" />
        {/* 类型角标 */}
        <span className={`absolute left-2 top-2 rounded px-1.5 py-0.5 text-[10px] font-semibold ${KIND_STYLE[item.kind]}`}>
          {KIND_LABEL[item.kind]}
        </span>
        {/* 来源角标：云端待下载 / 云端已同步 */}
        {!item.hasFile ? (
          <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded bg-zinc-950/80 px-1.5 py-0.5 text-[10px] text-zinc-300">
            <CloudOff size={11} /> 云端·待下载
          </span>
        ) : item.cloudId ? (
          <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded bg-sky-950/90 px-1.5 py-0.5 text-[10px] text-sky-300">
            <Cloud size={11} /> 云端已同步
          </span>
        ) : null}
        {/* 时长 / 标记数 */}
        <div className="absolute bottom-1.5 left-2 right-2 flex items-center justify-between text-[10px] text-zinc-200">
          <span>{item.hasFile && item.duration > 0 ? formatTime(item.duration) : item.size ? formatSize(item.size) : ''}</span>
          {item.marks.length > 0 && (
            <span className="inline-flex items-center gap-0.5 rounded bg-black/60 px-1.5 py-0.5 text-amber-300">
              <Flag size={10} /> {item.marks.length}
            </span>
          )}
        </div>
      </button>

      {/* 信息区 */}
      <div className="p-2.5">
        <div className="flex items-start justify-between gap-1">
          <button type="button" onClick={onDetail} className="min-w-0 text-left">
            <p className="truncate text-[13px] font-medium text-zinc-100 leading-5">{item.name}</p>
            <div className="mt-0.5 flex items-center gap-0.5">
              {[1, 2, 3, 4, 5].map((n) => (
                <Star key={n} size={10} className={n <= item.rating ? 'fill-amber-400 text-amber-400' : 'text-zinc-700'} />
              ))}
            </div>
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="shrink-0 rounded-full p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" aria-label="更多操作">
                <MoreVertical size={16} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="bg-zinc-900 border-zinc-700 text-zinc-200">
              <DropdownMenuItem onClick={onPlay}>
                <Play size={14} className="mr-2" /> 播放打点
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onDetail}>
                <Info size={14} className="mr-2" /> 详情页
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onRename}>
                <Pencil size={14} className="mr-2" /> 重命名
              </DropdownMenuItem>
              {item.kind !== 'clip' && (
                <DropdownMenuItem onClick={onPlay}>
                  <Scissors size={14} className="mr-2" /> 按标记截取
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={onDelete} className="text-rose-400 focus:text-rose-300">
                <Trash2 size={14} className="mr-2" /> 删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {/* 标签预览 */}
        {item.tags.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {item.tags.slice(0, 3).map((t) => (
              <span key={t} className="rounded bg-zinc-800 px-1.5 py-px text-[10px] text-zinc-400">
                {t}
              </span>
            ))}
            {item.tags.length > 3 && <span className="text-[10px] text-zinc-600">+{item.tags.length - 3}</span>}
          </div>
        )}
        {item.kind === 'clip' && item.parentName && (
          <p className="mt-1 truncate text-[10px] text-sky-400/80">源自：{item.parentName}</p>
        )}
      </div>
    </div>
  )
}

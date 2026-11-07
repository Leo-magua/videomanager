import { CloudDownload, Flag, FolderInput, MoreHorizontal, Pencil, Play, Scissors, Trash2 } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { formatTime } from '@/types'
import type { MediaItem } from '@/types'

interface Props {
  item: MediaItem
  onOpen: () => void
  onDetail: () => void
  onRename?: () => void
  onMove?: () => void
  onDelete?: () => void
  /** 剪辑执行：执行该素材所有未完成片段的剪辑 */
  onCutAll?: () => void
  /** 云端条目未下载时显示「绑定本地文件」 */
  onBind?: () => void
  /** 云端条目的删除文案 */
  deleteLabel?: string
}

/** 横向素材卡片：缩略图 / 名称 / 时长标记 / 横排标签 / 数字打分 + 三点菜单 */
export function MediaRowCard({
  item,
  onOpen,
  onDetail,
  onRename,
  onMove,
  onDelete,
  onCutAll,
  onBind,
  deleteLabel = '删除',
}: Props) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-2.5">
      <button onClick={onOpen} className="relative shrink-0 overflow-hidden rounded-lg" aria-label={item.name}>
        {item.poster ? (
          <img src={item.poster} alt="" className="h-20 w-14 object-cover" />
        ) : (
          <div className="grid h-20 w-14 place-items-center bg-zinc-800 text-zinc-600">
            <Play size={20} />
          </div>
        )}
        {!item.hasFile && item.duration > 0 && (
          <span className="absolute bottom-0.5 right-0.5 rounded bg-black/70 px-1 font-mono text-[9px] text-zinc-200">
            {formatTime(item.duration)}
          </span>
        )}
      </button>

      <button onClick={onDetail} className="min-w-0 flex-1 text-left">
        <p className="truncate text-sm font-medium text-zinc-100">{item.name}</p>
        <div className="mt-0.5 flex items-center gap-0.5">
          {item.hasFile && item.duration > 0 && (
            <span className="font-mono text-[10px] text-zinc-500">{formatTime(item.duration)}</span>
          )}
          {item.marks.length > 0 && (
            <span className="ml-1.5 inline-flex items-center gap-0.5 text-[10px] text-amber-300">
              <Flag size={10} /> {item.marks.length}
            </span>
          )}
        </div>
        {item.tags.length > 0 && (
          <div className="mt-1.5 flex gap-1 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {item.tags.map((t) => (
              <span key={t} className="shrink-0 rounded bg-zinc-800 px-1.5 py-px text-[10px] text-zinc-400">{t}</span>
            ))}
          </div>
        )}
        {item.kind === 'clip' && item.parentName && (
          <p className="mt-1 truncate text-[10px] text-sky-400/80">源自：{item.parentName}</p>
        )}
      </button>

      {/* 数字打分：三点菜单左侧 */}
      <span
        className={`shrink-0 font-mono text-sm font-semibold ${item.rating ? 'text-amber-400' : 'text-zinc-700'}`}
        aria-label={`打分 ${item.rating || '未评'}`}
      >
        {item.rating ? item.rating.toFixed(1) : '—'}
      </span>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="shrink-0 rounded-full p-1.5 text-zinc-500 hover:bg-zinc-800" aria-label="更多操作">
            <MoreHorizontal size={16} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="bg-zinc-900 border-zinc-700 text-zinc-200">
          {onRename && (
            <DropdownMenuItem onClick={onRename}>
              <Pencil size={14} className="mr-2" /> 重命名
            </DropdownMenuItem>
          )}
          {onMove && <DropdownMenuItem onClick={onMove}><FolderInput size={14} className="mr-2" />移动</DropdownMenuItem>}
          {onCutAll && (
            <DropdownMenuItem onClick={onCutAll}>
              <Scissors size={14} className="mr-2" /> 剪辑执行
            </DropdownMenuItem>
          )}
          {onBind && (
            <DropdownMenuItem onClick={onBind}>
              <CloudDownload size={14} className="mr-2" /> 绑定本地文件
            </DropdownMenuItem>
          )}
          {onDelete && (
            <DropdownMenuItem onClick={onDelete} className="text-rose-400 focus:text-rose-300">
              <Trash2 size={14} className="mr-2" /> {deleteLabel}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

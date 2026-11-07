import {FolderInput, MoreHorizontal, Pencil, Trash2} from 'lucide-react'
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger} from '@/components/ui/dropdown-menu'

export function FileEntryMenu({name, onRename, onMove, onDelete}: {name: string; onRename: () => void; onMove: () => void; onDelete: () => void}) {
  return <DropdownMenu>
    <DropdownMenuTrigger asChild><button data-drag-select-ignore aria-label={`更多操作 ${name}`} className="shrink-0 rounded-full p-3 text-zinc-400"><MoreHorizontal size={18} /></button></DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="border-zinc-700 bg-zinc-900 text-zinc-200">
      <DropdownMenuItem onClick={onRename}><Pencil size={15} className="mr-2" />重命名</DropdownMenuItem>
      <DropdownMenuItem onClick={onMove}><FolderInput size={15} className="mr-2" />移动</DropdownMenuItem>
      <DropdownMenuItem onClick={onDelete} className="text-rose-400 focus:text-rose-300"><Trash2 size={15} className="mr-2" />删除</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
}

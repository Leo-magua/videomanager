import { useState } from 'react'
import { Plus, X } from 'lucide-react'

interface Props {
  tags: string[]
  onChange: (tags: string[]) => void
  placeholder?: string
  compact?: boolean
  alignAddRight?: boolean
}

/** 自定义标签编辑：chip + 输入添加 */
export function TagEditor({ tags, onChange, placeholder = '添加标签', compact, alignAddRight }: Props) {
  const [text, setText] = useState('')
  const [adding, setAdding] = useState(false)

  const commit = () => {
    const t = text.trim()
    if (t && !tags.includes(t)) onChange([...tags, t])
    setText('')
    setAdding(false)
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.map((t) => (
        <span
          key={t}
          className={`inline-flex items-center gap-1 rounded-full bg-zinc-800 text-zinc-200 border border-zinc-700 ${
            compact ? 'text-[11px] px-2 py-0.5' : 'text-xs px-2.5 py-1'
          }`}
        >
          {t}
          <button
            type="button"
            onClick={() => onChange(tags.filter((x) => x !== t))}
            className="text-zinc-500 hover:text-zinc-300"
            aria-label={`删除标签 ${t}`}
          >
            <X size={compact ? 11 : 13} />
          </button>
        </span>
      ))}
      <span className={alignAddRight ? 'ml-auto' : ''}>
      {adding ? (
        <input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') setAdding(false)
          }}
          placeholder={placeholder}
          className="w-24 rounded-full bg-zinc-900 border border-amber-500/60 px-2.5 py-1 text-xs text-zinc-100 outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className={`inline-flex items-center gap-1 rounded-full border border-dashed border-zinc-600 text-zinc-400 hover:border-amber-500/60 hover:text-amber-400 ${
            compact ? 'text-[11px] px-2 py-0.5' : 'text-xs px-2.5 py-1'
          }`}
        >
          <Plus size={compact ? 11 : 13} /> 标签
        </button>
      )}
      </span>
    </div>
  )
}

import { useRef, useState } from 'react'

interface Props {
  /** 维度文字：素材详情页为「打分」，演员详情页为「颜值/身材/演技」 */
  label: string
  /** 0 – 10 分 */
  value: number
  onChange: (v: number) => void
}

/** 评分条：维度文字 - 可交互进度条（点按/拖动打分） - 数字（点数字输入评分，最多 10.0） */
export function RatingBar({ label, value, onChange }: Props) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const [dragging, setDragging] = useState(false)
  const barRef = useRef<HTMLDivElement>(null)
  const pct = Math.min(100, Math.max(0, (value / 10) * 100))

  const valueFromX = (clientX: number) => {
    const el = barRef.current
    if (!el) return value
    const r = el.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
    // 0.5 分为步进，点空白最左端可清零
    return Math.round(ratio * 10 * 2) / 2
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
    onChange(valueFromX(e.clientX))
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    const v = valueFromX(e.clientX)
    if (v !== value) onChange(v)
  }

  const commit = () => {
    setEditing(false)
    const n = parseFloat(text)
    if (Number.isNaN(n)) return
    const v = Math.min(10, Math.max(0, Math.round(n * 10) / 10))
    if (v !== value) onChange(v)
  }

  return (
    <div className="flex items-center gap-3">
      <span className="w-10 shrink-0 text-xs text-zinc-500">{label}</span>
      <div
        ref={barRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        role="slider"
        aria-label={`${label}评分`}
        aria-valuemin={0}
        aria-valuemax={10}
        aria-valuenow={value}
        className="relative h-5 min-w-0 flex-1 cursor-pointer touch-none select-none"
      >
        <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-zinc-800">
          <div
            className={`h-full rounded-full bg-gradient-to-r from-amber-600 to-amber-400 ${dragging ? '' : 'transition-all'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        {/* 滑块圆点 */}
        <div
          className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-amber-400 shadow shadow-zinc-950"
          style={{ left: `${pct}%` }}
        />
      </div>
      {editing ? (
        <input
          autoFocus
          inputMode="decimal"
          value={text}
          onChange={(e) => {
            const t = e.target.value
            // 仅允许数字，最多一位小数
            if (/^\d{0,2}(\.\d{0,1})?$/.test(t)) setText(t)
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') setEditing(false)
          }}
          placeholder="10.0"
          className="w-14 shrink-0 rounded-md border border-amber-500/60 bg-zinc-900 px-1.5 py-0.5 text-right font-mono text-xs text-zinc-100 outline-none"
        />
      ) : (
        <button
          onClick={() => {
            setText(value ? String(value) : '')
            setEditing(true)
          }}
          className="w-14 shrink-0 rounded-md px-1.5 py-0.5 text-right font-mono text-xs text-amber-400 hover:bg-zinc-800 active:bg-zinc-800"
          aria-label={`设置${label}评分`}
        >
          {value ? value.toFixed(1) : '—'}
        </button>
      )}
    </div>
  )
}

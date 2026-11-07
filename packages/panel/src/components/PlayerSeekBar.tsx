import {useEffect, useRef, useState} from 'react'
import {Flag} from 'lucide-react'
import type {Mark} from '@/types'
import {formatTime} from '@/types'

export function PlayerSeekBar({value, max, marks, onSeek}: {value: number; max: number; marks: Mark[]; onSeek: (time: number) => void}) {
  const dragging = useRef(false)
  const seen = useRef(new Set(marks.map(mark => mark.id)))
  const [highlight, setHighlight] = useState<string | null>(null)
  useEffect(() => {
    const added = marks.filter(mark => !seen.current.has(mark.id))
    seen.current = new Set(marks.map(mark => mark.id))
    if (added.length) setHighlight(added.at(-1)!.id)
  }, [marks])
  const percent = (time: number) => max > 0 ? Math.max(0, Math.min(100, time / max * 100)) : 0
  const selected = marks.find(mark => mark.id === highlight)
  const seek = (bar: HTMLElement, x: number) => {
    const rect = bar.getBoundingClientRect()
    if (max > 0 && rect.width > 0) onSeek(Math.max(0, Math.min(1, (x - rect.left) / rect.width)) * max)
  }
  return <div className="relative h-12 w-full select-none" data-player-controls>
    {selected && <div role="status" className="pointer-events-none absolute -top-5 right-0 max-w-full truncate rounded-md bg-amber-400 px-2 py-0.5 text-[11px] font-medium text-black">{selected.label || '标记'} · {formatTime(selected.time)}</div>}
    <div className="absolute inset-x-2 top-0 h-6" aria-label="进度标记">
      {marks.filter(mark => mark.time <= max).map(mark => <button key={mark.id} aria-label={`跳转标记 ${mark.label || '未命名'} ${formatTime(mark.time)}`} aria-pressed={highlight === mark.id}
        onClick={() => {setHighlight(mark.id); onSeek(mark.time)}}
        className={`absolute top-0 grid h-6 w-7 -translate-x-1/2 place-items-center rounded-md ${highlight === mark.id ? 'bg-amber-400 text-black ring-2 ring-white' : 'bg-black/80 ring-1 ring-white/50'}`}
        style={{left: `${percent(mark.time)}%`, color: highlight === mark.id ? undefined : mark.color}}><Flag size={15} fill="currentColor" /></button>)}
    </div>
    <div role="slider" tabIndex={max > 0 ? 0 : -1} aria-label="播放进度" aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.max(0, Math.min(max, value))} aria-valuetext={`${formatTime(value)} / ${formatTime(max)}`} aria-disabled={max <= 0}
      className="absolute inset-x-2 bottom-0 h-6 cursor-pointer touch-none"
      onKeyDown={event => {const next = event.key === 'ArrowLeft' ? value - 5 : event.key === 'ArrowRight' ? value + 5 : event.key === 'Home' ? 0 : event.key === 'End' ? max : null; if (next !== null) {event.preventDefault(); setHighlight(null); onSeek(Math.max(0, Math.min(max, next)))}}}
      onPointerDown={event => {if (event.button !== 0 || max <= 0) return; event.currentTarget.setPointerCapture(event.pointerId); dragging.current = true; setHighlight(null); seek(event.currentTarget, event.clientX)}}
      onPointerMove={event => {if (dragging.current) seek(event.currentTarget, event.clientX)}}
      onPointerUp={() => {dragging.current = false}} onPointerCancel={() => {dragging.current = false}}>
      <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/35" />
      <div className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-amber-400" style={{width: `${percent(value)}%`}} />
      <span className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-black bg-white shadow" style={{left: `${percent(value)}%`}} />
    </div>
  </div>
}

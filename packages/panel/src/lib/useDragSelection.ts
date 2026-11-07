import {useEffect, useLayoutEffect, useRef, type Dispatch, type MouseEvent, type RefObject, type SetStateAction} from 'react'
import {selectionScrollSpeed, selectionSegment} from './drag-selection'

interface Options {
  root: RefObject<HTMLElement | null>
  ids: string[]
  selected: Set<string>
  selecting: boolean
  setSelected: Dispatch<SetStateAction<Set<string>>>
  setSelecting: Dispatch<SetStateAction<boolean>>
  scope: string
  disabled?: boolean
}
type Gesture = {id: number; kind: 'touch' | 'pointer'; x: number; y: number; startX: number; startY: number; first: string; last: string; active: boolean; checked: boolean; visited: Set<string>}

/** Normal swipes scroll. Holding a row, or dragging its checkbox, paints selection. */
export function useDragSelection(options: Options) {
  const latest = useRef(options)
  useLayoutEffect(() => {latest.current = options}, [options])
  const gesture = useRef<Gesture | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const frame = useRef(0)
  const suppressClickUntil = useRef(0)
  const active = useRef(false)
  const cancel = useRef<() => void>(() => {})

  useEffect(() => {
    const finish = () => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      cancelAnimationFrame(frame.current)
      frame.current = 0
      if (gesture.current?.active) suppressClickUntil.current = Date.now() + 600
      gesture.current = null
      active.current = false
    }
    cancel.current = finish
    const rowAt = (target: EventTarget | null) => {
      const root = latest.current.root.current
      const element = target instanceof Element ? target : null
      const row = element?.closest<HTMLElement>('[data-drag-select-id]')
      return row && root?.contains(row) ? row : null
    }
    const paint = (id: string) => {
      const g = gesture.current
      if (!g?.active) return
      const crossed = selectionSegment(latest.current.ids, g.last, id).filter(value => !g.visited.has(value))
      g.last = id
      if (!crossed.length) return
      crossed.forEach(value => g.visited.add(value))
      latest.current.setSelected(previous => {
        const next = new Set(previous)
        crossed.forEach(value => {if (g.checked) next.add(value); else next.delete(value)})
        return next
      })
    }
    const hitTest = () => {
      const g = gesture.current
      if (!g) return
      // Keep selecting the nearest visible row when the finger overlaps the
      // sticky toolbar or bottom navigation during edge scrolling.
      const y = Math.max(64, Math.min(window.innerHeight - 80, g.y))
      const row = rowAt(document.elementFromPoint(g.x, y))
      if (row) paint(row.dataset.dragSelectId!)
    }
    let previousTime = 0
    const tick = (time: number) => {
      const g = gesture.current
      if (!g?.active) return
      const root = latest.current.root.current
      if (latest.current.disabled || !root || root.closest('[hidden]')) {finish(); return}
      const elapsed = previousTime ? Math.min(32, time - previousTime) : 16.67
      previousTime = time
      const speed = selectionScrollSpeed(g.y, window.innerHeight)
      if (speed) {window.scrollBy({top: speed * elapsed / 16.67, behavior: 'instant'}); hitTest()}
      frame.current = requestAnimationFrame(tick)
    }
    const activate = () => {
      const g = gesture.current
      if (!g) return
      g.active = true
      active.current = true
      suppressClickUntil.current = Date.now() + 600
      latest.current.setSelecting(true)
      paint(g.first)
      previousTime = 0
      frame.current = requestAnimationFrame(tick)
    }
    const start = (target: EventTarget | null, x: number, y: number, id: number, kind: Gesture['kind']) => {
      finish()
      const opts = latest.current
      const element = target instanceof Element ? target : null
      const row = rowAt(target)
      if (!row || opts.disabled || row.closest('[hidden]') || element?.closest('[aria-haspopup],input,textarea,[data-drag-select-ignore]')) return
      const first = row.dataset.dragSelectId!
      if (!opts.ids.includes(first)) return
      gesture.current = {id, kind, x, y, startX: x, startY: y, first, last: first, active: false, checked: !opts.selected.has(first), visited: new Set()}
      if (opts.selecting && element?.closest('[data-drag-select-handle]')) activate()
      else timer.current = setTimeout(activate, 500)
    }
    const move = (x: number, y: number) => {
      const g = gesture.current
      if (!g) return
      g.x = x; g.y = y
      if (!g.active) {if (Math.hypot(x - g.startX, y - g.startY) > 10) finish(); return}
      hitTest()
    }
    // A non-passive native listener can stop scrolling after a long hold without
    // disabling normal vertical scrolling on every video card.
    const touchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {finish(); return}
      const t = e.changedTouches[0]
      start(e.target, t.clientX, t.clientY, t.identifier, 'touch')
    }
    const touchMove = (e: TouchEvent) => {
      const g = gesture.current
      if (!g || g.kind !== 'touch') return
      if (e.touches.length !== 1) {finish(); return}
      const t = Array.from(e.touches).find(t => t.identifier === g.id)
      if (!t) return
      if (g.active && e.cancelable) e.preventDefault()
      move(t.clientX, t.clientY)
    }
    const touchEnd = (e: TouchEvent) => {
      if (gesture.current?.kind === 'touch' && Array.from(e.changedTouches).some(t => t.identifier === gesture.current?.id)) finish()
    }
    const pointerStart = (e: PointerEvent) => {if (e.pointerType !== 'touch' && e.isPrimary && e.button === 0) start(e.target, e.clientX, e.clientY, e.pointerId, 'pointer')}
    const pointerMove = (e: PointerEvent) => {if (gesture.current?.kind === 'pointer' && e.pointerId === gesture.current.id) move(e.clientX, e.clientY)}
    const pointerEnd = (e: PointerEvent) => {if (gesture.current?.kind === 'pointer' && e.pointerId === gesture.current.id) finish()}
    const visibility = () => {if (document.hidden) finish()}
    document.addEventListener('touchstart', touchStart, {capture: true, passive: true})
    document.addEventListener('touchmove', touchMove, {capture: true, passive: false})
    document.addEventListener('touchend', touchEnd, true)
    document.addEventListener('touchcancel', touchEnd, true)
    document.addEventListener('pointerdown', pointerStart, true)
    document.addEventListener('pointermove', pointerMove, true)
    document.addEventListener('pointerup', pointerEnd, true)
    document.addEventListener('pointercancel', pointerEnd, true)
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('blur', finish)
    window.addEventListener('vm-back', finish)
    return () => {
      finish()
      document.removeEventListener('touchstart', touchStart, true)
      document.removeEventListener('touchmove', touchMove, true)
      document.removeEventListener('touchend', touchEnd, true)
      document.removeEventListener('touchcancel', touchEnd, true)
      document.removeEventListener('pointerdown', pointerStart, true)
      document.removeEventListener('pointermove', pointerMove, true)
      document.removeEventListener('pointerup', pointerEnd, true)
      document.removeEventListener('pointercancel', pointerEnd, true)
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('blur', finish)
      window.removeEventListener('vm-back', finish)
    }
  }, [])
  useEffect(() => {cancel.current()}, [options.scope])
  useEffect(() => {if (options.disabled || !options.selecting) cancel.current()}, [options.disabled, options.selecting])
  return {
    active,
    cancel: () => cancel.current(),
    itemProps: (id: string) => ({
      'data-drag-select-id': id,
      onContextMenu: (e: MouseEvent) => e.preventDefault(),
      onClickCapture: (e: MouseEvent) => {
        if (active.current || Date.now() < suppressClickUntil.current) {e.preventDefault(); e.stopPropagation(); return}
        if (latest.current.selecting) {
          e.preventDefault(); e.stopPropagation()
          latest.current.setSelected(previous => {const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next})
        }
      },
    }),
  }
}

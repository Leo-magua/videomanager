import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject} from 'react'
import {flushSync} from 'react-dom'
import {Check, CloudOff, EyeOff, Flag, ListVideo, Loader2, Maximize, Minimize, Pause, Play, RotateCcw, RotateCw, X} from 'lucide-react'
import {useRatingSort} from '@/lib/useRatingSort'
import {directoryVideos, videoSwipe} from '@/lib/playlist'
import {boundedSeek, containedVideoBounds, HoldSeek, holdDirection, previewOffset} from '@/lib/player-gestures'
import {PlayerSeekBar} from './PlayerSeekBar'
import {formatTime, type MediaItem} from '@/types'

interface Props {
  item: MediaItem
  items: MediaItem[]
  stageRef: RefObject<HTMLDivElement | null>
  videoRef: RefObject<HTMLVideoElement | null>
  resolveURL: (id: string) => Promise<string | undefined>
  onChangeVideo: (id: string) => void
  onDuration: (duration: number) => void
  onMark: () => Promise<void>
  onBind: () => void
  binding: boolean
}
type Status = {id: string; time: number; duration: number; playing: boolean; waiting: boolean}
type Transition = {id: string; direction: -1 | 1}
const RATES = [0.5, 1, 1.5, 2, 3]

export function VideoPlayer({item, items, stageRef, videoRef, resolveURL, onChangeVideo, onDuration, onMark, onBind, binding}: Props) {
  const isClip = item.kind === 'clip'
  const [sortOrder] = useRatingSort()
  const playlist = useMemo(() => directoryVideos(items, item, sortOrder), [items, item, sortOrder])
  const index = playlist.findIndex(video => video.id === item.id)
  const [fullscreen, setFullscreen] = useState(false)
  const [controls, setControls] = useState(true)
  const [episodes, setEpisodes] = useState(false)
  const [rate, setRate] = useState(1)
  const [status, setStatus] = useState<Status>({id: item.id, time: 0, duration: 0, playing: false, waiting: true})
  const [feedback, setFeedback] = useState('')
  const [hold, setHold] = useState<-1 | 0 | 1>(0)
  const [offset, setOffset] = useState(0)
  const [animate, setAnimate] = useState(false)
  const [transition, setTransition] = useState<Transition | null>(null)
  const videos = useRef(new Map<string, HTMLVideoElement>())
  const activeId = useRef(item.id)
  const selectedRef = useRef<HTMLButtonElement>(null)
  const [holdSeek] = useState(() => new HoldSeek())
  const pointer = useRef<{id: number; x: number; y: number; moved: boolean; vertical: boolean; held: boolean} | null>(null)
  const suppressClick = useRef(0)
  const transitionBusy = useRef(false)
  const transitionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const animationFrame = useRef(0)
  const latest = useRef({item, onChangeVideo, onDuration})
  useLayoutEffect(() => {
    latest.current = {item, onChangeVideo, onDuration}
    activeId.current = item.id
    videoRef.current = videos.current.get(item.id) ?? null
  }, [item, onChangeVideo, onDuration, videoRef])
  const register = useCallback((id: string, video: HTMLVideoElement | null) => {
    if (video) videos.current.set(id, video); else videos.current.delete(id)
    if (id === activeId.current) videoRef.current = video
  }, [videoRef])
  const update = useCallback((id: string, patch: Partial<Omit<Status, 'id'>>) => {
    if (id !== activeId.current) return
    setStatus(previous => ({...(previous.id === id ? previous : {id, time: 0, duration: 0, playing: false, waiting: true}), ...patch}))
    if (patch.duration !== undefined) latest.current.onDuration(patch.duration)
  }, [])
  const cancelGesture = useCallback((restore = true) => {
    if (holdSeek.stop(restore)) suppressClick.current = performance.now() + 500
    pointer.current = null
  }, [holdSeek])
  useEffect(() => {
    const change = () => {setFullscreen(document.fullscreenElement === stageRef.current); cancelGesture(); setOffset(0)}
    const blur = () => {cancelGesture(false); setOffset(0)}
    const visibility = () => {if (document.hidden) blur()}
    document.addEventListener('fullscreenchange', change)
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('blur', blur)
    return () => {
      cancelGesture(false); clearTimeout(transitionTimer.current); cancelAnimationFrame(animationFrame.current)
      document.removeEventListener('fullscreenchange', change)
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('blur', blur)
    }
  }, [cancelGesture, stageRef])
  useEffect(() => {
    if (!feedback) return
    const timer = setTimeout(() => setFeedback(''), 1800)
    return () => clearTimeout(timer)
  }, [feedback])
  useEffect(() => {cancelGesture(false)}, [item.id, cancelGesture])
  useEffect(() => {
    if (!episodes) return
    selectedRef.current?.focus()
    const stage = stageRef.current
    const back = (event: Event) => {event.preventDefault(); setEpisodes(false)}
    window.addEventListener('vm-back', back)
    return () => {window.removeEventListener('vm-back', back); stage?.focus()}
  }, [episodes, stageRef])
  const current = status.id === item.id ? status.time : 0
  const duration = status.id === item.id ? status.duration || item.duration : item.duration
  const start = isClip ? item.rangeStart ?? 0 : 0
  const end = isClip ? item.rangeEnd ?? duration : duration
  const shownTime = isClip ? Math.max(0, current - start) : current
  const shownDuration = isClip ? Math.max(0, end - start) : duration
  const playing = status.id === item.id && status.playing

  const seek = (time: number) => {
    const video = videoRef.current
    if (!video || !Number.isFinite(video.duration)) return
    const target = boundedSeek(time, start, end || video.duration)
    video.currentTime = target; update(item.id, {time: target})
  }
  const togglePlay = () => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      if (isClip && (video.currentTime < start || video.currentTime >= end - 0.05)) video.currentTime = start
      void video.play().catch(() => setFeedback('点击播放继续'))
    } else video.pause()
  }
  const requestVideo = (target: MediaItem | undefined, direction: -1 | 1) => {
    if (transitionBusy.current) return
    if (!target) {
      setAnimate(true); setOffset(0); setFeedback(direction === 1 ? '已是本目录最后一个视频' : '已是本目录第一个视频')
      return
    }
    if (target.id === item.id) {setEpisodes(false); return}
    cancelGesture(false); setEpisodes(false)
    transitionBusy.current = true
    setTransition({id: target.id, direction})
    // A prepared neighbour keeps its decoder and first frame across the commit.
    videoRef.current?.pause()
    const prepared = videos.current.get(target.id)
    if (prepared) {prepared.muted = false; prepared.playbackRate = rate; void prepared.play().catch(() => {})}
    // Called only by click, key and pointer handlers; suppress the following synthetic click.
    // eslint-disable-next-line react-hooks/purity
    suppressClick.current = performance.now() + 600
    const height = stageRef.current?.clientHeight || window.innerHeight
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    animationFrame.current = requestAnimationFrame(() => {
      animationFrame.current = requestAnimationFrame(() => {
        setAnimate(true); setOffset(direction * height)
        transitionTimer.current = setTimeout(() => {
          flushSync(() => {
            latest.current.onChangeVideo(target.id)
            setAnimate(false); setOffset(0); setTransition(null)
          })
          transitionBusy.current = false
        }, reducedMotion ? 0 : 240)
      })
    })
  }
  const surfaces = [{video: item, position: 0}]
  const previous = index >= 0 ? playlist[index - 1] : undefined
  const next = index >= 0 ? playlist[index + 1] : undefined
  if (previous && transition?.direction !== -1) surfaces.push({video: previous, position: 1})
  if (next && transition?.direction !== 1) surfaces.push({video: next, position: -1})
  if (transition) {
    const target = playlist.find(video => video.id === transition.id)
    if (target) surfaces.push({video: target, position: -transition.direction})
  }
  const fullscreenToggle = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    else void stageRef.current?.requestFullscreen?.().catch(() => {})
  }

  return <div ref={stageRef} role="region" aria-label="视频播放器" tabIndex={-1}
    className="relative isolate h-[300px] shrink-0 overflow-hidden bg-black min-[640px]:h-[360px] [&:fullscreen]:h-dvh [&:fullscreen]:w-screen"
    style={{touchAction: fullscreen ? 'none' : 'pan-y'}}
    onClick={event => {
      // eslint-disable-next-line react-hooks/purity -- This is a click event, not render.
      if ((event.target as HTMLElement).closest('[data-player-controls]') || performance.now() < suppressClick.current || transitionBusy.current) return
      if (!controls) setControls(true); else togglePlay()
    }}

    onPointerDown={event => {
      if (!event.isPrimary) {cancelGesture(); setAnimate(true); setOffset(0); return}
      if (event.button !== 0 || !event.isPrimary || transitionBusy.current || (event.target as HTMLElement).closest('[data-player-controls],button,input,[role="slider"]')) return
      event.currentTarget.setPointerCapture(event.pointerId)
      pointer.current = {id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, vertical: false, held: false}
      setAnimate(false)
      const video = videoRef.current
      if (video && video.readyState >= 1) {
        const box = containedVideoBounds(video.getBoundingClientRect(), video.videoWidth, video.videoHeight)
        const direction = holdDirection(event.clientX, event.clientY, box)
        if (direction) holdSeek.begin(direction, video, start, end || video.duration,
          time => update(item.id, {time}), value => {setHold(value); if (value && pointer.current) pointer.current.held = true})
      }
    }}
    onPointerMove={event => {
      const gesture = pointer.current
      if (!gesture || gesture.id !== event.pointerId) return
      const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y
      if (Math.hypot(dx, dy) <= 12) return
      gesture.moved = true
      if (gesture.held) return
      holdSeek.stop()
      if (!fullscreen || isClip || Math.abs(dy) < Math.abs(dx) * 1.4) return
      gesture.vertical = true
      const target = dy > 0 ? next : previous
      setOffset(previewOffset(dy, stageRef.current?.clientHeight || 1, !!target))
    }}
    onPointerUp={event => {
      const gesture = pointer.current
      if (!gesture || gesture.id !== event.pointerId) return
      const held = holdSeek.stop(); pointer.current = null
      // eslint-disable-next-line react-hooks/purity -- This is a pointer-up event, not render.
      if (gesture.moved || gesture.held || held) suppressClick.current = performance.now() + 500
      const direction = gesture.vertical && !gesture.held ? videoSwipe(event.clientX - gesture.x, event.clientY - gesture.y) : 0
      if (direction) requestVideo(direction === 1 ? next : previous, direction)
      else {setAnimate(true); setOffset(0)}
    }}
    onPointerCancel={() => {cancelGesture(); setAnimate(true); setOffset(0)}}
    onLostPointerCapture={() => {if (pointer.current) {cancelGesture(); setAnimate(true); setOffset(0)}}}
    onKeyDown={event => {
      if ((event.target as HTMLElement).closest('[data-player-controls]')) return
      if (fullscreen && !isClip && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {event.preventDefault(); const direction = event.key === 'ArrowDown' ? 1 : -1; requestVideo(direction === 1 ? next : previous, direction)}
      else if (event.key === ' ' || event.key === 'k') {event.preventDefault(); if (!controls) setControls(true); else togglePlay()}
    }}>
    <div className="absolute inset-0">
      {surfaces.map(({video, position}) => <VideoSurface key={video.id} item={video} active={video.id === item.id} resolveURL={resolveURL} register={register} update={update} rate={rate} binding={binding} onBind={onBind}
        style={{transform: `translate3d(0, calc(${position * 100}% + ${offset}px), 0)`, transition: animate ? 'transform 230ms cubic-bezier(.2,.8,.2,1)' : 'none'}} />)}
    </div>
    {controls && <>
      <button data-player-controls onClick={() => {setControls(false); setFeedback('轻点画面恢复控件')}} aria-label="隐藏所有播放控件" className="absolute left-2 top-2 z-20 grid h-10 w-10 place-items-center rounded-full bg-black/55 text-white"><EyeOff size={19} /></button>
      <button data-player-controls onClick={fullscreenToggle} disabled={!item.hasFile} aria-label={fullscreen ? '退出全屏' : '全屏'} className="absolute right-2 top-2 z-20 grid h-10 w-10 place-items-center rounded-full bg-black/55 text-white disabled:hidden">{fullscreen ? <Minimize size={19} /> : <Maximize size={19} />}</button>
      {fullscreen && <div className="pointer-events-none absolute inset-x-14 top-3 text-center text-white"><p className="truncate text-sm drop-shadow">{item.name}</p>{!isClip && <p className="mt-1 text-[10px] text-zinc-300">{index + 1} / {playlist.length} · 下滑下一个 · 上滑上一个</p>}</div>}
      {item.hasFile && <div data-player-controls className="absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/95 via-black/70 to-transparent px-2 pt-8" style={{paddingBottom: 'max(6px, env(safe-area-inset-bottom))'}}>
        <PlayerSeekBar key={item.id} value={shownTime} max={shownDuration} marks={item.marks} onSeek={time => seek(start + time)} />
        <div aria-label="播放控制" className="flex min-h-10 items-center gap-0.5 text-white">
          <span className="mr-auto shrink-0 whitespace-nowrap font-mono text-[10px] tabular-nums" aria-label="播放时间">{formatTime(shownTime)} / {formatTime(shownDuration)}</span>
          <button aria-label="后退 5 秒" onClick={() => seek(current - 5)} className="grid h-10 w-8 shrink-0 place-items-center"><RotateCcw size={18} /></button>
          <button aria-label={playing ? '暂停' : '播放'} onClick={togglePlay} className="grid h-10 w-8 shrink-0 place-items-center">{playing ? <Pause size={21} /> : <Play size={21} />}</button>
          <button aria-label="前进 5 秒" onClick={() => seek(current + 5)} className="grid h-10 w-8 shrink-0 place-items-center"><RotateCw size={18} /></button>
          <button aria-label="倍速切换" onClick={() => setRate(value => RATES[(RATES.indexOf(value) + 1) % RATES.length])} className="h-10 min-w-8 shrink-0 px-1 font-mono text-[11px]">{rate}x</button>
          {!isClip && <button aria-label="选集" onClick={() => {cancelGesture(); setEpisodes(true)}} className="grid h-10 w-8 shrink-0 place-items-center"><ListVideo size={19} /></button>}
          <button aria-label="打点" onClick={() => void onMark()} className="ml-1 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-amber-400 text-black"><Flag size={17} /></button>
        </div>
      </div>}
    </>}
    {hold !== 0 && <div role="status" className="pointer-events-none absolute inset-x-4 top-1/2 z-30 text-center"><span className="rounded-xl bg-black/80 px-4 py-3 text-sm text-white">{hold < 0 ? '◀◀ 长按快退' : '长按快进 ▶▶'} · 10× · {formatTime(shownTime)}</span></div>}
    {feedback && <div role="status" className="pointer-events-none absolute inset-x-4 top-1/3 z-30 text-center"><span className="rounded-xl bg-black/80 px-4 py-2 text-xs text-white">{feedback}</span></div>}
    {episodes && <div data-player-controls className="absolute inset-0 z-40 flex justify-end bg-black/60" onClick={() => setEpisodes(false)}>
      <section role="dialog" aria-modal="true" aria-label="当前目录选集" className="flex h-full w-[min(88%,400px)] flex-col bg-zinc-950/95 p-3 text-white shadow-2xl" onClick={event => event.stopPropagation()}
        onKeyDown={event => {
          if (event.key === 'Escape') {event.stopPropagation(); setEpisodes(false)}
          if (event.key === 'Tab') {
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'))
            const first = buttons[0], last = buttons.at(-1)
            if (event.shiftKey && document.activeElement === first) {event.preventDefault(); last?.focus()}
            else if (!event.shiftKey && document.activeElement === last) {event.preventDefault(); first?.focus()}
          }
        }}>
        <header className="mb-3 flex items-center justify-between"><span className="text-sm font-semibold">当前目录 · {playlist.length} 个视频</span><button aria-label="关闭选集" onClick={() => setEpisodes(false)} className="p-2"><X size={21} /></button></header>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">{playlist.map((video, i) => <button key={video.id} ref={video.id === item.id ? selectedRef : undefined} aria-current={video.id === item.id ? 'true' : undefined} aria-label={`播放 ${video.name}`}
          onClick={() => requestVideo(video, i > index ? 1 : -1)} className={`flex min-h-16 w-full items-center gap-3 rounded-xl border p-2 text-left ${video.id === item.id ? 'border-amber-400 bg-amber-400/10' : 'border-zinc-800 bg-zinc-900'}`}>
          {video.poster ? <img src={video.poster} alt="" className="h-12 w-16 shrink-0 rounded object-cover" /> : <span className="grid h-12 w-16 shrink-0 place-items-center rounded bg-zinc-800"><Play size={20} /></span>}
          <span className="min-w-0 flex-1"><span className="block truncate text-sm">{i + 1}. {video.name}</span><span className="text-[11px] text-zinc-400">{video.duration > 0 ? formatTime(video.duration) : video.filePath?.split('/').at(-1)}</span></span>
          {video.id === item.id && <Check size={18} className="shrink-0 text-amber-400" />}
        </button>)}</div>
        <p className="mt-2 text-center text-[11px] text-zinc-500">只显示当前文件夹内的视频</p>
      </section>
    </div>}
  </div>
}

function VideoSurface({item, active, resolveURL, register, update, rate, style, binding, onBind}: {
  item: MediaItem; active: boolean; resolveURL: Props['resolveURL']; register: (id: string, video: HTMLVideoElement | null) => void; update: (id: string, patch: Partial<Omit<Status, 'id'>>) => void; rate: number; style: React.CSSProperties; binding: boolean; onBind: () => void
}) {
  const [url, setURL] = useState<string>()
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [ready, setReady] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const resolver = useRef(resolveURL)
  useLayoutEffect(() => {resolver.current = resolveURL}, [resolveURL])
  const ref = useCallback((video: HTMLVideoElement | null) => {videoRef.current = video; register(item.id, video)}, [item.id, register])
  useEffect(() => {
    if (!item.hasFile) return
    let cancelled = false
    setError(''); setReady(false)
    resolver.current(item.kind === 'clip' ? item.parentId! : item.id)
      .then(value => {if (!cancelled) {if (value) setURL(value); else setError('无法连接视频所在设备')}})
      .catch(() => {if (!cancelled) setError('无法连接视频所在设备')})
    return () => {cancelled = true}
  }, [item.id, item.hasFile, item.kind, item.parentId, retry])
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.muted = !active
    if (active) {
      // A prepared neighbour may already be playing through the slide animation.
      // Keep that frame/time rather than seeking it back at the commit boundary.
      if (video.paused) video.currentTime = item.kind === 'clip' ? item.rangeStart ?? 0 : 0
      video.playbackRate = rate
      update(item.id, {time: video.currentTime, duration: Number.isFinite(video.duration) ? video.duration : 0, waiting: video.readyState < 2})
      void video.play().catch(() => update(item.id, {playing: false, waiting: false}))
    } else {video.pause(); if (video.readyState >= 1) video.currentTime = item.kind === 'clip' ? item.rangeStart ?? 0 : 0.01}
    // Rate updates have a separate effect so changing speed never resets time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, url, item.id, item.kind, item.rangeStart, update])
  useEffect(() => {if (videoRef.current && active) videoRef.current.playbackRate = rate}, [rate, active])
  return <div aria-hidden={!active} data-video-id={item.id} data-video-ready={ready} className="absolute inset-0 overflow-hidden bg-black will-change-transform" style={style}>
    {item.poster && !ready && <img src={item.poster} alt="" className="absolute inset-0 h-full w-full object-contain" />}
    {url && <video ref={ref} src={url} poster={item.poster} preload="auto" playsInline className="absolute inset-0 h-full w-full object-contain" style={{opacity: ready ? 1 : 0}}
      onLoadedMetadata={event => {
        const video = event.currentTarget
        if (item.kind === 'clip') video.currentTime = item.rangeStart ?? 0
        if (active) update(item.id, {duration: Number.isFinite(video.duration) ? video.duration : 0})
      }}
      onLoadedData={() => {setReady(true); if (active) update(item.id, {waiting: false})}}
      onCanPlay={() => {setReady(true); if (active) update(item.id, {waiting: false})}}
      onTimeUpdate={event => {
        if (!active) return
        const video = event.currentTarget
        if (item.kind === 'clip' && item.rangeEnd && video.currentTime >= item.rangeEnd) {video.pause(); video.currentTime = item.rangeStart ?? 0}
        update(item.id, {time: video.currentTime})
      }}
      onPlay={() => {if (active) update(item.id, {playing: true})}}
      onPlaying={() => {if (active) update(item.id, {playing: true, waiting: false})}}
      onPause={() => {if (active) update(item.id, {playing: false})}}
      onWaiting={() => {if (active) update(item.id, {waiting: true})}}
      onError={() => {setError('视频加载失败，请检查设备连接或视频格式'); if (active) update(item.id, {playing: false, waiting: false})}} />}
    {!item.hasFile ? <div className="absolute inset-0 grid place-items-center"><button data-player-controls disabled={binding} onClick={onBind} className="rounded-full bg-amber-400 px-4 py-2 text-sm font-semibold text-black">{binding ? '正在绑定…' : '绑定本地文件后播放'}</button></div> : error ? <div className="absolute inset-0 grid place-items-center bg-black/75 px-6 text-center"><div><CloudOff size={26} className="mx-auto mb-3 text-zinc-400" /><p className="text-xs text-zinc-300">{error}</p>{active && <button data-player-controls onClick={() => {setURL(undefined); setRetry(value => value + 1)}} className="mt-3 rounded-full bg-zinc-800 px-4 py-2 text-xs text-white">重试</button>}</div></div> : !ready && <div role={active ? 'status' : undefined} className="pointer-events-none absolute inset-0 grid place-items-center bg-gradient-to-b from-black/20 to-black/40"><div className="flex flex-col items-center gap-3 text-white"><Loader2 size={26} className="animate-spin" /><span className="max-w-[80vw] truncate text-xs">{item.name}</span></div></div>}
  </div>
}

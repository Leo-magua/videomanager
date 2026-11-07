import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { ArrowLeft, House } from 'lucide-react'
import { Toaster } from 'sonner'
import { LibraryProvider, useLibrary } from '@/store/library'
import { LibraryPage } from '@/sections/LibraryPage'
import type { Region } from '@/sections/LibraryPage'
import { ActorsPage } from '@/sections/ActorsPage'
import { MediaDetailPage } from '@/sections/MediaDetailPage'
import { ActorDetailPage } from '@/sections/ActorDetailPage'
import { ClipsPage } from '@/sections/ClipsPage'
import { SettingsPage } from '@/sections/SettingsPage'
import { BottomNav } from '@/components/BottomNav'
import { ConnectionBar } from '@/components/ConnectionBar'
import type { TabKey } from '@/components/BottomNav'

type View =
  | { page: 'tab'; tab: TabKey; region?: Region }
  | { page: 'detail'; id: string }
  | { page: 'actor'; name: string }
const desktop: View = { page: 'tab', tab: 'library', region: { kind: 'local' } }

function Shell() {
  const { items, actors } = useLibrary()
  const [view, setView] = useState<View>(desktop)
  const [libraryRegion, setLibraryRegion] = useState<Region>({ kind: 'local' })
  const depth = useRef(0)
  const playerRef = useRef<HTMLDivElement>(null)
  const touch = useRef<{ x: number; y: number } | null>(null)
  const go = (next: View) => {
    if (JSON.stringify(view) === JSON.stringify(next)) return
    const index = ++depth.current
    window.history.pushState({ vm: true, view: next, depth: index }, '')
    setView(next)
    if (next.page === 'tab' && next.tab === 'library') setLibraryRegion(next.region ?? {kind: 'local'})
  }
  const back = () => {
    const event = new Event('vm-back', { cancelable: true })
    window.dispatchEvent(event)
    if (event.defaultPrevented) return
    if (document.fullscreenElement) {void document.exitFullscreen(); return}
    if (document.querySelector('[role="dialog"], [role="alertdialog"]')) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      return
    }
    if (depth.current > 0) window.history.back()
    else if (view.page !== 'tab' || view.tab !== 'library') go(desktop)
  }
  const backRef = useRef(back)
  useLayoutEffect(() => {backRef.current = back})
  useEffect(() => {
    window.history.replaceState({vm: true, view: desktop, depth: 0}, '')
    const pop = (e: PopStateEvent) => {
      depth.current = e.state?.vm ? e.state.depth : 0
      const next: View = e.state?.vm ? e.state.view : desktop
      setView(next)
      if (next.page === 'tab' && next.tab === 'library') setLibraryRegion(next.region ?? {kind: 'local'})
    }
    const nativeBack = () => backRef.current()
    window.addEventListener('popstate', pop)
    window.addEventListener('vm-request-back', nativeBack)
    return () => { window.removeEventListener('popstate', pop); window.removeEventListener('vm-request-back', nativeBack) }
  }, [])
  const openDetail = (id: string) => {
    // Mount the player within the tap handler so fullscreen retains user activation.
    // Stream lookup stays asynchronous and does not delay entering fullscreen.
    flushSync(() => go({ page: 'detail', id }))
    const player = playerRef.current
    if (items.find(item => item.id === id)?.hasFile && player && !document.fullscreenElement) {
      player.requestFullscreen?.().catch(() => {})
    }
  }
  const isLibrary = view.page === 'tab' && view.tab === 'library'
  const switchVideo = (id: string) => {
    const next: View = {page: 'detail', id}
    window.history.replaceState({vm: true, view: next, depth: depth.current}, '')
    setView(next)
  }
  return (
    <div className="min-h-dvh bg-zinc-950 text-zinc-100 [font-family:system-ui,-apple-system,'PingFang_SC','Noto_Sans_SC',sans-serif]"
      onTouchStart={e => {
        const t = e.touches[0]
        touch.current = !isLibrary && !document.fullscreenElement && e.touches.length === 1 && t.clientX < 28 ? {x: t.clientX, y: t.clientY} : null
      }}
      onTouchEnd={e => {
        const start = touch.current; touch.current = null
        const t = e.changedTouches[0]
        if (start && t.clientX - start.x > 75 && Math.abs(t.clientY - start.y) < 60) back()
      }} onTouchCancel={() => {touch.current = null}}>
      {!isLibrary && <nav className="flex items-center gap-1 border-b border-zinc-800 px-2 py-1" aria-label="页面导航">
        <button onClick={back} aria-label="返回上一个路径" title="返回上一个路径" className="flex min-h-11 items-center gap-1 rounded-lg px-3 text-sm text-zinc-300"><ArrowLeft size={20} /></button>
        <button onClick={() => go(desktop)} aria-label="桌面" title="桌面" className="flex min-h-11 items-center gap-1 rounded-lg px-3 text-sm text-zinc-300"><House size={20} /></button>
      </nav>}
      {!isLibrary && <ConnectionBar />}
      <div hidden={view.page !== 'tab' || view.tab !== 'library'}>
        <LibraryPage onOpenDetail={openDetail} region={libraryRegion} onRegionChange={region => go({page: 'tab', tab: 'library', region})} />
      </div>
      {view.page === 'tab' && view.tab === 'actors' && <ActorsPage onOpenActor={name => go({page: 'actor', name})} />}
      {view.page === 'tab' && view.tab === 'clips' && <ClipsPage onOpenPlayer={openDetail} />}
      {view.page === 'tab' && view.tab === 'settings' && <SettingsPage />}
      {view.page === 'detail' && <MediaDetailPage playerRef={playerRef} id={view.id} onBack={back} onChangeVideo={switchVideo} />}
      {view.page === 'actor' && <ActorDetailPage onRenamed={name => {
          const next: View = {page: 'actor', name}
          window.history.replaceState({vm: true, view: next, depth: depth.current}, '')
          setView(next)
        }} key={view.name} name={view.name} onBack={back} onOpenDetail={openDetail} onOpenClip={openDetail} />}
      {view.page === 'tab' && <BottomNav tab={view.tab} clipCount={items.filter(i => i.kind === 'clip').length} actorCount={actors.length}
        onChange={tab => go({page: 'tab', tab, ...(tab === 'library' ? {region: libraryRegion} : {})})} />}
      <Toaster theme="dark" position="top-center" richColors />
    </div>
  )
}
export default function App() { return <LibraryProvider><Shell /></LibraryProvider> }

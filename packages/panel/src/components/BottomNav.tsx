import { Clapperboard, FolderOpen, Settings, Users } from 'lucide-react'

export type TabKey = 'library' | 'actors' | 'clips' | 'settings'

interface Props {
  tab: TabKey
  onChange: (t: TabKey) => void
  clipCount: number
  actorCount: number
}

/** 底部导航：竖屏全宽；折叠屏展开后居中悬浮 */
export function BottomNav({ tab, onChange, clipCount, actorCount }: Props) {
  const tabs = [
    { key: 'library', label: '素材库', icon: FolderOpen },
    { key: 'actors', label: actorCount ? `演员 · ${actorCount}` : '演员', icon: Users },
    { key: 'clips', label: clipCount ? `剪辑 · ${clipCount}` : '剪辑片段', icon: Clapperboard },
    { key: 'settings', label: '设置', icon: Settings },
  ] as const
  return (
    <nav className="fixed bottom-0 inset-x-0 z-40 pointer-events-none">
      <div className="mx-auto pointer-events-auto bg-zinc-950/95 backdrop-blur border-t border-zinc-800 min-[640px]:mb-4 min-[640px]:w-fit min-[640px]:rounded-2xl min-[640px]:border min-[640px]:border-zinc-700 min-[640px]:shadow-2xl">
        <div className="flex">
          {tabs.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => onChange(key)}
              className={`flex-1 min-[640px]:flex-none min-[640px]:px-6 flex flex-col items-center gap-0.5 py-2.5 text-[11px] transition-colors ${
                tab === key ? 'text-amber-400' : 'text-zinc-500'
              }`}
            >
              <Icon size={22} strokeWidth={tab === key ? 2.4 : 1.8} />
              {label}
            </button>
          ))}
        </div>
      </div>
    </nav>
  )
}

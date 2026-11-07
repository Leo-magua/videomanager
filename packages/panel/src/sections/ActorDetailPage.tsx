import { useRef, useState } from 'react'
import {
  Camera, Clapperboard, Film, Loader2, Pencil, Tags,
} from 'lucide-react'
import { toast } from 'sonner'
import { useLibrary } from '@/store/library'
import { RenameDialog } from '@/components/RenameDialog'
import { RatingBar } from '@/components/RatingBar'
import { TagEditor } from '@/components/TagEditor'
import { formatTime } from '@/types'

interface Props {
  name: string
  onBack: () => void
  onRenamed: (name: string) => void
  onOpenDetail: (id: string) => void
  onOpenClip: (id: string) => void
}

const RATING_DIMS = [
  { key: 'looks', label: '颜值' },
  { key: 'figure', label: '身材' },
  { key: 'acting', label: '演技' },
] as const

/** 演员详情页：姓名 / 照片 / 三维评分 / 介绍 / 作品列表 / 剪辑片段列表 */
export function ActorDetailPage({ name, onBack, onOpenDetail, onOpenClip, onRenamed }: Props) {
  const lib = useLibrary()
  const entry = lib.actorOf(name)
  const photoRef = useRef<HTMLInputElement>(null)
  const [renaming, setRenaming] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [editingBio, setEditingBio] = useState(false)
  const [bio, setBio] = useState('')

  // 作品列表：本地或云端已有的、含该演员的素材
  const works = lib.items.filter((i) => i.kind === 'source' && i.cast?.includes(name))
  // 剪辑片段列表：母素材含该演员的片段
  const clips = lib.items.filter((i) => i.kind === 'clip' && i.cast?.includes(name))

  if (!entry) {
    return (
      <div className="grid min-h-dvh place-items-center text-zinc-500">
        <button onClick={onBack} className="text-amber-400">← 返回演员列表</button>
      </div>
    )
  }

  const ratings = entry.ratings ?? { figure: 0, looks: 0, acting: 0 }

  const onPhoto = async (files: FileList | null) => {
    const f = files?.[0]
    if (!f) return
    setUploading(true)
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const img = new Image()
        img.onload = () => {
          const size = 256
          const c = document.createElement('canvas')
          c.width = size
          c.height = size
          const ctx = c.getContext('2d')!
          const s = Math.min(img.width, img.height)
          ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size)
          resolve(c.toDataURL('image/jpeg', 0.85))
          URL.revokeObjectURL(img.src)
        }
        img.onerror = reject
        img.src = URL.createObjectURL(f)
      })
      await lib.patchActor(name, { photo: dataUrl })
      toast.success('照片已更新')
    } catch {
      toast.error('照片读取失败')
    } finally {
      setUploading(false)
      if (photoRef.current) photoRef.current.value = ''
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-16 min-[640px]:px-6">
      {/* 顶栏 */}
      <header className="sticky top-0 z-10 -mx-4 flex items-center gap-2 bg-zinc-950/90 px-4 py-2.5 backdrop-blur min-[640px]:-mx-6 min-[640px]:px-6">
        <span className="text-sm text-zinc-400">演员详情</span>
      </header>

      {/* 照片 + 姓名 + 标签 */}
      <div className="mt-4 flex items-center gap-4">
        <button
          onClick={() => photoRef.current?.click()}
          className="group relative h-24 w-24 shrink-0 overflow-hidden rounded-2xl border border-zinc-800"
          aria-label="更换照片"
        >
          {entry.photo ? (
            <img src={entry.photo} alt={name} className="h-full w-full object-cover" />
          ) : (
            <span className="grid h-full w-full place-items-center bg-gradient-to-br from-amber-500/30 to-amber-700/20 text-3xl font-bold text-amber-300">
              {name.slice(0, 1)}
            </span>
          )}
          <span className="absolute inset-0 grid place-items-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100 group-active:opacity-100">
            {uploading ? <Loader2 size={18} className="animate-spin text-white" /> : <Camera size={18} className="text-white" />}
          </span>
        </button>
        <input ref={photoRef} type="file" accept="image/*" hidden onChange={(e) => onPhoto(e.target.files)} />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2"><h1 className="break-all text-2xl font-bold text-zinc-50">{name}</h1><button aria-label="编辑演员姓名" onClick={() => setRenaming(true)} className="shrink-0 p-2 text-zinc-400"><Pencil size={17} /></button></div>
          <RenameDialog open={renaming} initial={name} title="编辑演员姓名" onClose={() => setRenaming(false)} onSave={async value => {await lib.renameActor(name, value); setRenaming(false); onRenamed(value); toast.success('演员姓名已更新')}} />
          <p className="mt-1 text-xs text-zinc-500">
            {works.length} 部作品 · {clips.length} 个剪辑片段
          </p>
          <div className="mt-2">
            <TagEditor compact tags={entry.tags} onChange={(tags) => lib.patchActor(name, { tags })} placeholder="添加标签" />
          </div>
        </div>
      </div>

      {/* 三维评分：每个维度一行，进度条 + 数字输入 */}
      <section className="mt-6">
        <h2 className="mb-2 text-sm font-semibold text-zinc-200">评分</h2>
        <div className="space-y-2.5">
          {RATING_DIMS.map(({ key, label }) => (
            <RatingBar
              key={key}
              label={label}
              value={ratings[key]}
              onChange={(v) => lib.patchActor(name, { ratings: { ...ratings, [key]: v } })}
            />
          ))}
        </div>
      </section>

      {/* 介绍 */}
      <section className="mt-5">
        <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-zinc-200">
          <Pencil size={13} className="text-zinc-500" /> 介绍
        </h2>
        {editingBio ? (
          <textarea
            autoFocus
            defaultValue={entry.bio ?? ''}
            onChange={(e) => setBio(e.target.value)}
            onBlur={() => {
              lib.patchActor(name, { bio })
              setEditingBio(false)
            }}
            rows={3}
            className="w-full rounded-xl border border-amber-500/60 bg-zinc-900 p-3 text-sm text-zinc-200 outline-none"
          />
        ) : (
          <p
            onClick={() => {
              setBio(entry.bio ?? '')
              setEditingBio(true)
            }}
            className="cursor-text rounded-xl bg-zinc-900 p-3 text-sm leading-relaxed text-zinc-400"
          >
            {entry.bio || '点击添加介绍…'}
          </p>
        )}
      </section>

      {/* 作品列表（本地或云端已有的） */}
      <section className="mt-6">
        <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-zinc-200">
          <Film size={14} className="text-amber-400" /> 作品列表 ({works.length})
        </h2>
        {works.length === 0 ? (
          <p className="text-xs text-zinc-600">库中还没有该演员的素材，到素材详情页添加</p>
        ) : (
          <ul className="space-y-2">
            {works.map((w) => (
              <li key={w.id}>
                <button
                  onClick={() => onOpenDetail(w.id)}
                  className="flex w-full items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900 p-2.5 text-left active:border-amber-500/60"
                >
                  <div className="relative h-14 w-11 shrink-0 overflow-hidden rounded bg-zinc-800">
                    {w.poster && <img src={w.poster} alt="" className="absolute inset-0 h-full w-full object-cover" />}
                    <span
                      className={`absolute left-0.5 top-0.5 rounded px-1 py-px text-[9px] font-semibold ${
                        w.hasFile ? 'bg-emerald-500/90 text-zinc-950' : 'bg-zinc-950/80 text-zinc-300'
                      }`}
                    >
                      {w.hasFile ? '本地' : '云端'}
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-[13px] text-zinc-100">{w.name}</p>
                      <span className={`shrink-0 font-mono text-xs font-semibold ${w.rating ? 'text-amber-400' : 'text-zinc-700'}`}>
                        {w.rating ? w.rating.toFixed(1) : '—'}
                      </span>
                    </div>
                    {w.tags.length > 0 && (
                      <div className="mt-1 flex gap-1 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                        {w.tags.map((t) => (
                          <span
                            key={t}
                            className="shrink-0 rounded-full bg-amber-500/10 border border-amber-500/30 px-1.5 py-px text-[10px] text-amber-300"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 剪辑片段列表 */}
      <section className="mt-6">
        <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-zinc-200">
          <Clapperboard size={14} className="text-sky-400" /> 剪辑片段 ({clips.length})
        </h2>
        {clips.length === 0 ? (
          <p className="text-xs text-zinc-600">从该演员的作品中按标记截取后，片段会列在这里</p>
        ) : (
          <ul className="space-y-2">
            {clips.map((c) => (
              <li key={c.id}>
                <button
                  onClick={() => onOpenClip(c.id)}
                  className="flex w-full items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900 p-2.5 text-left active:border-zinc-600"
                >
                  {c.poster && <img src={c.poster} alt="" className="h-12 w-9 rounded object-cover" />}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] text-zinc-100">{c.name}</p>
                    <p className="text-[11px] text-zinc-500">
                      源自：{c.parentName} · {formatTime(c.rangeStart ?? 0)} → {formatTime(c.rangeEnd ?? 0)}
                    </p>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 互通协议说明 */}
      <p className="mt-8 flex items-start gap-1.5 text-[11px] leading-relaxed text-zinc-600">
        <Tags size={12} className="mt-0.5 shrink-0" />
        演员的标签会随添加自动并入素材；在素材上新增标签也会写回此处。
      </p>
    </div>
  )
}

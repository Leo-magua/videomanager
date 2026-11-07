// 连接状态条 + 配对面板（阶段5）。
// 顶部常驻一条细状态条：显示 在线/离线/未配对 + 待同步条数；点开配对/重连面板。
// 配对：输入 PC 地址(可留空→用默认候选) + 6位配对码；成功后开始同步。
import { useState } from 'react'
import { Cloud, CloudOff, Link2, Loader2, RefreshCw, Wifi, WifiOff } from 'lucide-react'
import { toast } from 'sonner'
import { useLibrary } from '@/store/library'
import { transport } from '@/lib/transport'
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from '@/components/ui/sheet'
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp'

function relTime(ts: number | null): string {
  if (!ts) return '从未'
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

export function ConnectionBar({compact = false}: {compact?: boolean}) {
  const { connection } = useLibrary()
  const { online, paired, pendingWrites, baseUrl, lastSync } = connection
  const [open, setOpen] = useState(false)
  const [addr, setAddr] = useState(baseUrl ?? '')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)

  const status: { label: string; cls: string; icon: React.ReactNode } = !paired
    ? { label: '未连接 PC', cls: 'text-zinc-400', icon: <Link2 size={13} /> }
    : online
      ? { label: 'PC 已连接', cls: 'text-emerald-400', icon: <Wifi size={13} /> }
      : { label: '离线（PC 未开机）', cls: 'text-amber-400', icon: <WifiOff size={13} /> }

  const doPair = async () => {
    // 地址留空则尝试已有候选/默认端口；否则规范化用户输入
    let base = addr.trim()
    if (base && !/^https?:\/\//.test(base)) base = `http://${base}`
    if (base && !/:\d+$/.test(base) && !/\/$/.test(base)) base = `${base}:8787`
    if (base) transport.setCandidates([base, ...transport.candidates()])
    const target = base || transport.baseUrl || transport.candidates()[0]
    if (!target) {
      toast.error('请填写 PC 的地址（如 192.168.1.10:8787）')
      return
    }
    if (code.length !== 6) {
      toast.error('请输入 6 位配对码')
      return
    }
    setBusy(true)
    const r = await connection.pair(target, code)
    setBusy(false)
    if (r.ok) {
      toast.success('配对成功，正在同步素材库…')
      setOpen(false)
      setCode('')
    } else {
      toast.error(r.error ?? '配对失败')
    }
  }

  const doReconnect = async () => {
    setBusy(true)
    const ok = await connection.reconnect()
    setBusy(false)
    toast[ok ? 'success' : 'error'](ok ? '已重新连接' : '仍无法连接到 PC')
  }

  return (
    <>
      <button
        onClick={() => {
          setAddr(baseUrl ?? '')
          setOpen(true)
        }}
        aria-label={pendingWrites > 0 ? `${status.label}，${pendingWrites} 条待同步` : status.label}
        title={pendingWrites > 0 ? `${status.label} · ${pendingWrites} 待同步` : status.label}
        className={compact ? 'relative grid h-10 w-10 shrink-0 place-items-center rounded-full bg-zinc-900 text-xs' : 'flex w-full items-center justify-center gap-2 border-b border-zinc-800/80 bg-zinc-900/60 py-1.5 text-[11px] backdrop-blur'}
      >
        <span className={`flex items-center gap-1 ${status.cls}`}>
          {status.icon}
          {!compact && status.label}
        </span>
        {pendingWrites > 0 && !compact && (
          <span className="flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-300">
            <CloudOff size={11} />
            {pendingWrites} 待同步
          </span>
        )}
        {pendingWrites > 0 && compact && <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-amber-500 px-1 text-[9px] text-black">{pendingWrites}</span>}
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="rounded-t-2xl border-zinc-800 bg-zinc-950 text-zinc-100">
          <SheetHeader className="text-left">
            <SheetTitle className="flex items-center gap-2 text-zinc-50">
              {online ? <Cloud size={18} className="text-emerald-400" /> : <CloudOff size={18} className="text-amber-400" />}
              连接 PC
            </SheetTitle>
            <SheetDescription className="text-zinc-400">
              视频与元数据都在你的电脑上，手机作为遥控面板。
              {paired && baseUrl && (
                <>
                  <br />
                  当前地址 <span className="text-zinc-300">{baseUrl}</span> · 上次同步 {relTime(lastSync)}
                </>
              )}
            </SheetDescription>
          </SheetHeader>

          <div className="space-y-5 px-4 pb-6">
            {paired ? (
              <div className="flex flex-col gap-3">
                <div
                  className={`rounded-xl border px-3 py-2.5 text-sm ${
                    online
                      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                      : 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                  }`}
                >
                  {online
                    ? '已连接。修改会实时保存到 PC。'
                    : 'PC 未开机或不在同一网络。你仍可浏览、打点、改标签，改动会排队，等 PC 上线后自动同步。'}
                  {pendingWrites > 0 && <div className="mt-1 text-xs opacity-80">{pendingWrites} 条改动等待同步</div>}
                </div>
                <button
                  onClick={doReconnect}
                  disabled={busy}
                  className="flex items-center justify-center gap-2 rounded-xl bg-sky-500 py-2.5 text-sm font-semibold text-zinc-950 active:bg-sky-400 disabled:opacity-60"
                >
                  {busy ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
                  重新连接
                </button>
                <button
                  onClick={() => {
                    connection.unpair()
                    toast.info('已断开配对')
                    setOpen(false)
                  }}
                  className="text-xs text-zinc-500 underline underline-offset-2"
                >
                  断开并重新配对
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                <label className="block space-y-1.5">
                  <span className="text-xs text-zinc-400">PC 地址（局域网 IP 或 Tailscale 名）</span>
                  <input
                    value={addr}
                    onChange={(e) => setAddr(e.target.value)}
                    placeholder="192.168.1.10:8787"
                    inputMode="url"
                    autoCapitalize="none"
                    className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2.5 text-sm outline-none focus:border-sky-500/60"
                  />
                </label>
                <div className="space-y-1.5">
                  <span className="text-xs text-zinc-400">6 位配对码（PC 端启动时显示）</span>
                  <InputOTP maxLength={6} value={code} onChange={setCode}>
                    <InputOTPGroup className="w-full justify-between">
                      {[0, 1, 2, 3, 4, 5].map((i) => (
                        <InputOTPSlot key={i} index={i} className="h-11 flex-1 border-zinc-700 bg-zinc-900 text-lg" />
                      ))}
                    </InputOTPGroup>
                  </InputOTP>
                </div>
                <button
                  onClick={doPair}
                  disabled={busy}
                  className="flex items-center justify-center gap-2 rounded-xl bg-emerald-500 py-2.5 text-sm font-semibold text-zinc-950 active:bg-emerald-400 disabled:opacity-60"
                >
                  {busy ? <Loader2 size={16} className="animate-spin" /> : <Link2 size={16} />}
                  配对并连接
                </button>
                <p className="text-xs leading-relaxed text-zinc-600">
                  在电脑上启动服务端后，终端会打印一个 6 位配对码和地址。首次连接后地址与凭证会记住，下次自动重连。
                </p>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}

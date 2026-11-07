// 设置 Tab：连接状态 + 设备管理 + 存储设备管理（登记引用真实 PC 目录）。
// 连接：复用 ConnectionBar 的配对逻辑（这里给一个入口卡片，展示地址/同步时间，
//       未配对时提示去顶部状态条配对）。
// 设备：列出当前接入的设备（调度中心本机 / 数据存储连接器 / 视频处理器），带角色与在线态；
//       支持「配对模式」添加新存储设备（输入设备地址 + 6 位配对码 + 初始目录）。
// 存储：列出后端已登记的存储目录，可新增（选设备 + 输入绝对路径）、重扫、删除（仅解除引用）。
import { useEffect, useState } from 'react'
import {
  FolderPlus, HardDrive, Link2, Loader2, MonitorSmartphone, Plus, RefreshCw,
  Server, Trash2, Wifi, WifiOff, Cpu, Database,
} from 'lucide-react'
import { toast } from 'sonner'
import { useLibrary } from '@/store/library'
import type { SrvNode } from '@/lib/adapter'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp'
import { Badge } from '@/components/ui/badge'

function relTime(ts: number | null): string {
  if (!ts) return '从未'
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

/** 一台物理设备可能跑多个节点进程（如 First-One 同机跑 connector + processor）。
 *  按机器把节点合并成一台设备，角色/在线/目录取并集。 */
interface Device {
  key: string
  name: string
  baseUrl?: string | null
  online: boolean
  lastSeen: number | null
  isCoordinator: boolean
  hasStorage: boolean
  hasFfmpeg: boolean
  connectorId?: string // 可作为加路径目标的在线 connector 节点 id
  connectorOnline: boolean
  roots: SrvNode['roots']
}

/** 分组键：本机=loopback；远程按显示名（默认取主机名，同机多进程共用同名）分组，
 *  使同一台机器上的 connector + processor 合并成一张设备卡。 */
function deviceKey(n: SrvNode): string {
  if (n.isCoordinator) return 'loopback'
  return `name:${n.name}`
}

/** 把节点列表合并成设备列表（同机多进程 → 一张卡）。 */
function groupDevices(nodes: SrvNode[]): Device[] {
  const map = new Map<string, Device>()
  for (const n of nodes) {
    const key = deviceKey(n)
    let d = map.get(key)
    if (!d) {
      d = {
        key, name: n.name, baseUrl: n.baseUrl, online: false, lastSeen: null,
        isCoordinator: false, hasStorage: false, hasFfmpeg: false,
        connectorOnline: false, roots: [],
      }
      map.set(key, d)
    }
    d.isCoordinator ||= !!n.isCoordinator
    if (n.kind === 'connector') d.hasStorage = true
    if (n.kind === 'processor' || n.capabilities?.hasFfmpeg) d.hasFfmpeg = true
    if (n.online) d.online = true
    if (n.lastSeen && (!d.lastSeen || n.lastSeen > d.lastSeen)) d.lastSeen = n.lastSeen
    if (!d.baseUrl && n.baseUrl) d.baseUrl = n.baseUrl
    if (n.roots?.length) d.roots = [...d.roots, ...n.roots]
    // 记录可作为远程加路径目标的 connector 节点（非本机）
    if (n.kind === 'connector' && !n.isCoordinator) {
      d.connectorId = n.id
      d.connectorOnline = n.online
    }
  }
  return Array.from(map.values())
}

/** 一台设备可能兼具多个角色（本机=调度中心+存储+处理器）；返回角色徽章描述。 */
function rolesOf(d: Device): Array<{ label: string; icon: React.ReactNode; cls: string }> {
  const roles: Array<{ label: string; icon: React.ReactNode; cls: string }> = []
  if (d.isCoordinator)
    roles.push({ label: '调度中心', icon: <Server size={11} />, cls: 'border-violet-500/40 bg-violet-500/10 text-violet-300' })
  if (d.hasStorage)
    roles.push({ label: '数据存储', icon: <Database size={11} />, cls: 'border-sky-500/40 bg-sky-500/10 text-sky-300' })
  if (d.hasFfmpeg)
    roles.push({ label: '视频处理器', icon: <Cpu size={11} />, cls: 'border-amber-500/40 bg-amber-500/10 text-amber-300' })
  return roles
}

export function SettingsPage() {
  const { connection, items } = useLibrary()
  const {
    online, paired, baseUrl, lastSync, pendingWrites,
    storages, addStorage, removeStorage, rescanStorage, refreshStorages,
    nodes, refreshNodes, pairDevice,
  } = connection

  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [targetNode, setTargetNode] = useState('') // '' = 本机(loopback)
  const [busy, setBusy] = useState(false)
  const [confirmDel, setConfirmDel] = useState<{ id: string; name: string } | null>(null)

  // 添加设备对话框状态
  const [addOpen, setAddOpen] = useState(false)
  const [devAddr, setDevAddr] = useState('')
  const [devCode, setDevCode] = useState('')
  const [devRoots, setDevRoots] = useState('')
  const [pairing, setPairing] = useState(false)

  // 进入设置页时刷新存储 + 设备列表；在线时每 5s 刷新（扫描进度/在线态/心跳）
  useEffect(() => {
    if (!paired) return
    refreshStorages()
    refreshNodes()
    const t = window.setInterval(() => {
      if (online) {
        refreshStorages()
        refreshNodes()
      }
    }, 5000)
    return () => window.clearInterval(t)
  }, [paired, online, refreshStorages, refreshNodes])

  const countOn = (storageId: string) =>
    items.filter((i) => (i as { storageId?: string }).storageId === storageId).length

  // 节点按物理机合并成设备卡（同机 connector+processor → 一张卡）
  const devices = groupDevices(nodes)
  // 可作为远程存储目标的设备（带在线 connector 节点的非本机设备）
  const connectorDevices = devices.filter((d) => !d.isCoordinator && d.connectorId)

  const doAdd = async () => {
    const p = path.trim()
    if (!p) {
      toast.error('请填写目标设备上的绝对目录路径')
      return
    }
    if (!online) {
      toast.error('需要 PC 在线才能登记目录')
      return
    }
    setBusy(true)
    const r = await addStorage(p, name.trim() || undefined, targetNode || null)
    setBusy(false)
    if (r.ok) {
      toast.success(targetNode ? '已登记，设备将在心跳内扫描该目录…' : '已登记，正在后台扫描视频…')
      setPath('')
      setName('')
    } else {
      toast.error(r.error ?? '添加失败')
    }
  }

  const doPairDevice = async () => {
    const addr = devAddr.trim()
    if (!addr) {
      toast.error('请填写设备地址（如 192.168.1.20:8788）')
      return
    }
    if (devCode.length !== 6) {
      toast.error('请输入 6 位配对码')
      return
    }
    const roots = devRoots
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (roots.length === 0) {
      toast.error('请至少填写一个要登记的目录')
      return
    }
    setPairing(true)
    const r = await pairDevice(addr, devCode, roots)
    setPairing(false)
    if (r.ok) {
      toast.success('设备已接入，正在扫描其目录…')
      setAddOpen(false)
      setDevAddr('')
      setDevCode('')
      setDevRoots('')
    } else {
      toast.error(r.error ?? '添加设备失败')
    }
  }

  const doRescan = async (id: string) => {
    const r = await rescanStorage(id)
    toast[r.ok ? 'success' : 'error'](r.ok ? '已开始重新扫描' : r.error ?? '扫描失败')
  }

  const doRemove = async () => {
    if (!confirmDel) return
    const { id } = confirmDel
    setConfirmDel(null)
    const r = await removeStorage(id)
    toast[r.ok ? 'success' : 'error'](r.ok ? '已移除该存储（磁盘文件保留）' : r.error ?? '删除失败')
  }

  return (
    <div className="mx-auto min-h-dvh max-w-2xl px-4 pb-28 pt-4">
      <h1 className="mb-4 text-lg font-semibold text-zinc-100">设置</h1>

      {/* 连接状态卡片 */}
      <section className="mb-6 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
        <div className="mb-2 flex items-center gap-2 text-sm font-medium text-zinc-200">
          {paired ? (
            online ? <Wifi size={16} className="text-emerald-400" /> : <WifiOff size={16} className="text-amber-400" />
          ) : (
            <Link2 size={16} className="text-zinc-400" />
          )}
          连接
        </div>
        {paired ? (
          <div className="space-y-1 text-xs text-zinc-400">
            <div>
              状态：
              <span className={online ? 'text-emerald-400' : 'text-amber-400'}>
                {online ? ' 已连接' : ' 离线（PC 未开机）'}
              </span>
            </div>
            <div>地址：<span className="text-zinc-300">{baseUrl ?? '—'}</span></div>
            <div>上次同步：{relTime(lastSync)}</div>
            {pendingWrites > 0 && <div className="text-amber-300">{pendingWrites} 条改动待同步</div>}
            <p className="pt-1 text-zinc-600">点顶部状态条可重连或断开配对。</p>
          </div>
        ) : (
          <p className="text-xs text-zinc-500">尚未连接 PC。点击顶部状态条输入地址与配对码完成连接。</p>
        )}
      </section>

      {/* 设备管理 */}
      <section className="mb-6 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
        <div className="mb-1 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
            <MonitorSmartphone size={16} className="text-violet-400" />
            设备
          </div>
          <button
            onClick={() => setAddOpen(true)}
            disabled={!online}
            className="flex items-center gap-1 rounded-lg border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-300 active:bg-zinc-800 disabled:opacity-40"
          >
            <Plus size={13} /> 添加设备
          </button>
        </div>
        <p className="mb-3 text-xs leading-relaxed text-zinc-500">
          接入的设备：调度中心（大脑，管元数据）、数据存储（持有视频并串流）、视频处理器（跑转码/缩略图）。
          一台设备可兼具多个角色。
        </p>

        {devices.length === 0 ? (
          <p className="py-4 text-center text-xs text-zinc-600">
            {online ? '暂无设备信息。' : '需 PC 在线才能查看设备。'}
          </p>
        ) : (
          <ul className="space-y-2">
            {devices.map((d) => (
              <li
                key={d.key}
                className="rounded-xl border border-zinc-800 bg-zinc-950/50 px-3 py-2.5"
              >
                <div className="flex items-center gap-3">
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${d.online ? 'bg-emerald-400' : 'bg-zinc-600'}`}
                    title={d.online ? '在线' : '离线'}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-zinc-100">{d.name}</div>
                    {d.baseUrl && <div className="truncate text-[11px] text-zinc-500">{d.baseUrl}</div>}
                  </div>
                  <span className="shrink-0 text-[11px] text-zinc-500">
                    {d.online ? '在线' : `离线 · ${relTime(d.lastSeen)}`}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-5">
                  {rolesOf(d).map((r) => (
                    <Badge
                      key={r.label}
                      variant="outline"
                      className={`gap-1 px-1.5 py-0 text-[10px] font-normal ${r.cls}`}
                    >
                      {r.icon}
                      {r.label}
                    </Badge>
                  ))}
                  {d.roots.length > 0 && (
                    <span className="text-[10px] text-zinc-600">· {d.roots.length} 个目录</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 存储设备管理 */}
      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
        <div className="mb-1 flex items-center gap-2 text-sm font-medium text-zinc-200">
          <HardDrive size={16} className="text-sky-400" />
          存储目录
        </div>
        <p className="mb-3 text-xs leading-relaxed text-zinc-500">
          登记设备上存放视频的目录。文件留在原地不搬动，后端扫描后即可在素材库浏览、串流播放。
          部分设备离线时，其素材仍可浏览，但播放会提示存储离线。
        </p>

        {/* 新增存储表单 */}
        <div className="mb-4 space-y-2 rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
          <label className="block space-y-1">
            <span className="text-[11px] text-zinc-500">目标设备</span>
            <select
              value={targetNode}
              onChange={(e) => setTargetNode(e.target.value)}
              className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-sky-500/60"
            >
              <option value="">本机（调度中心）</option>
              {connectorDevices.map((d) => (
                <option key={d.key} value={d.connectorId} disabled={!d.connectorOnline}>
                  {d.name}
                  {d.connectorOnline ? '' : '（离线）'}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] text-zinc-500">
              {targetNode ? '该设备上的绝对目录路径' : 'PC 上的绝对目录路径'}
            </span>
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder={targetNode ? 'E:\\视频 或 D:\\Movies' : '/Users/你/Movies 或 /Volumes/移动硬盘/视频'}
              inputMode="url"
              autoCapitalize="none"
              className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-sky-500/60"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] text-zinc-500">显示名（可选，默认取目录名）</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：移动硬盘 A"
              className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-sky-500/60"
            />
          </label>
          <button
            onClick={doAdd}
            disabled={busy || !online}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-500 py-2 text-sm font-semibold text-zinc-950 active:bg-emerald-400 disabled:opacity-50"
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <FolderPlus size={15} />}
            登记并扫描
          </button>
          {!online && <p className="text-[11px] text-amber-400">需 PC 在线才能登记目录。</p>}
          {targetNode !== '' && (
            <p className="text-[11px] text-zinc-600">
              远程设备目录由该设备自行扫描并上报，登记后素材会在心跳周期内陆续出现。
            </p>
          )}
        </div>

        {/* 存储列表 */}
        {storages.length === 0 ? (
          <p className="py-4 text-center text-xs text-zinc-600">还没有登记任何存储目录。</p>
        ) : (
          <ul className="space-y-2">
            {storages.map((s) => (
              <li
                key={s.id}
                className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950/50 px-3 py-2.5"
              >
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${s.online ? 'bg-emerald-400' : 'bg-zinc-600'}`}
                  title={s.online ? '在线' : '离线'}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm text-zinc-100">{s.name}</span>
                    {s.nodeId && (
                      <span className="shrink-0 rounded bg-zinc-800 px-1 text-[9px] text-zinc-400">远程</span>
                    )}
                    {s.scanning && (
                      <span className="flex items-center gap-1 text-[10px] text-sky-400">
                        <Loader2 size={10} className="animate-spin" /> 扫描中
                      </span>
                    )}
                  </div>
                  <div className="truncate text-[11px] text-zinc-500">{s.rootPath}</div>
                  <div className="text-[11px] text-zinc-600">
                    {s.online ? '在线' : '离线'} · {countOn(s.id)} 个素材
                  </div>
                </div>
                <button
                  onClick={() => doRescan(s.id)}
                  disabled={!online || s.scanning}
                  className="rounded-lg p-2 text-zinc-400 active:bg-zinc-800 disabled:opacity-40"
                  title="重新扫描"
                >
                  <RefreshCw size={15} className={s.scanning ? 'animate-spin' : ''} />
                </button>
                <button
                  onClick={() => setConfirmDel({ id: s.id, name: s.name })}
                  disabled={!online}
                  className="rounded-lg p-2 text-rose-400/80 active:bg-zinc-800 disabled:opacity-40"
                  title="移除登记"
                >
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 添加设备对话框（配对模式） */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="border-zinc-800 bg-zinc-950 text-zinc-100">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MonitorSmartphone size={18} className="text-violet-400" />
              添加存储设备
            </DialogTitle>
            <DialogDescription className="text-zinc-400">
              在目标设备上启动连接器（未配置时会进入配对模式并打印一个 6 位配对码），
              在这里输入它的地址和配对码即可接入。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-1">
            <label className="block space-y-1.5">
              <span className="text-xs text-zinc-400">设备地址（局域网 IP，默认端口 8788）</span>
              <input
                value={devAddr}
                onChange={(e) => setDevAddr(e.target.value)}
                placeholder="192.168.1.20:8788"
                inputMode="url"
                autoCapitalize="none"
                className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2.5 text-sm outline-none focus:border-violet-500/60"
              />
            </label>
            <div className="space-y-1.5">
              <span className="text-xs text-zinc-400">6 位配对码（设备端启动时显示）</span>
              <InputOTP maxLength={6} value={devCode} onChange={setDevCode}>
                <InputOTPGroup className="w-full justify-between">
                  {[0, 1, 2, 3, 4, 5].map((i) => (
                    <InputOTPSlot key={i} index={i} className="h-11 flex-1 border-zinc-700 bg-zinc-900 text-lg" />
                  ))}
                </InputOTPGroup>
              </InputOTP>
            </div>
            <label className="block space-y-1.5">
              <span className="text-xs text-zinc-400">要登记的目录（该设备上的绝对路径，每行一个）</span>
              <textarea
                value={devRoots}
                onChange={(e) => setDevRoots(e.target.value)}
                placeholder={'E:\\VideoTest\nD:\\Movies'}
                rows={2}
                autoCapitalize="none"
                className="w-full resize-none rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2.5 text-sm outline-none focus:border-violet-500/60"
              />
            </label>
          </div>

          <DialogFooter>
            <button
              onClick={doPairDevice}
              disabled={pairing}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-violet-500 py-2.5 text-sm font-semibold text-zinc-950 active:bg-violet-400 disabled:opacity-60"
            >
              {pairing ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
              配对并接入
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!confirmDel} onOpenChange={(o) => !o && setConfirmDel(null)}>
        <AlertDialogContent className="border-zinc-800 bg-zinc-950 text-zinc-100">
          <AlertDialogHeader>
            <AlertDialogTitle>移除存储「{confirmDel?.name}」？</AlertDialogTitle>
            <AlertDialogDescription className="text-zinc-400">
              仅解除登记并移除该目录下素材的元数据，磁盘上的视频文件不会被删除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-zinc-700 bg-transparent text-zinc-300">取消</AlertDialogCancel>
            <AlertDialogAction onClick={doRemove} className="bg-rose-500 text-zinc-950 hover:bg-rose-400">
              移除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

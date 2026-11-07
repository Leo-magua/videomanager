// M1 传输层：与 PC 后端通信。
// 职责：保存服务器地址 + 配对 token；多端点探活；在线/离线态；统一 fetch。
// <video>/<img> 用 streamUrl/posterUrl（token 走 query，因为标签无法带 header）。

const LS_ENDPOINT = 'vm.endpoint' // 已选定可用的 base url
const LS_ENDPOINTS = 'vm.endpoints' // 候选 base url 列表（LAN / Tailscale）
const LS_TOKEN = 'vm.token'

export interface HealthInfo {
  ok: true
  revision: number
  version: string
}

interface StreamLocate {
  nodeId: string
  directUrl: string
  proxyUrl: string
  ticket: string
  expiresAt: number
}

type Listener = (online: boolean) => void

export class RequestError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'RequestError'
    this.status = status
  }
}

class Transport {
  private base: string | null = localStorage.getItem(LS_ENDPOINT)
  private token: string | null = localStorage.getItem(LS_TOKEN)
  private _online = false
  private listeners = new Set<Listener>()
  // 智能串流：按 nodeId 缓存本 session 的直连可达性决策（避免每次播放都探测）
  private nodeReach = new Map<string, boolean>()

  get baseUrl(): string | null {
    return this.base
  }
  get hasToken(): boolean {
    return !!this.token
  }
  get isPaired(): boolean {
    return !!this.base && !!this.token
  }
  get online(): boolean {
    return this._online
  }

  candidates(): string[] {
    const raw = localStorage.getItem(LS_ENDPOINTS)
    const list = raw ? (JSON.parse(raw) as string[]) : []
    return this.base ? Array.from(new Set([this.base, ...list])) : list
  }

  setCandidates(urls: string[]) {
    const cleaned = urls.map((u) => u.replace(/\/+$/, '')).filter(Boolean)
    localStorage.setItem(LS_ENDPOINTS, JSON.stringify(Array.from(new Set(cleaned))))
  }

  onStatus(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  private setOnline(v: boolean) {
    if (v !== this._online) {
      this._online = v
      this.listeners.forEach((l) => l(v))
    }
  }

  /** 探活单个地址 */
  async health(base: string): Promise<HealthInfo | null> {
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 2500)
      const r = await fetch(`${base}/healthz`, { signal: ctrl.signal })
      clearTimeout(t)
      if (!r.ok) return null
      return (await r.json()) as HealthInfo
    } catch {
      return null
    }
  }

  /** 在候选地址中挑第一个可达的，设为当前 base。返回是否找到。 */
  async discover(): Promise<boolean> {
    for (const base of this.candidates()) {
      const h = await this.health(base)
      if (h) {
        this.base = base
        localStorage.setItem(LS_ENDPOINT, base)
        this.setOnline(true)
        this.nodeReach.clear() // 网络可能已切换，重探直连可达性
        return true
      }
    }
    this.setOnline(false)
    return false
  }

  /** 配对：向指定地址提交配对码换 token。成功则记住地址+token。 */
  async pair(base: string, code: string): Promise<{ ok: boolean; error?: string }> {
    base = base.replace(/\/+$/, '')
    try {
      const r = await fetch(`${base}/api/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      })
      const j = await r.json()
      if (!j.ok) return { ok: false, error: j.error?.message ?? '配对失败' }
      this.base = base
      this.token = j.data.token
      localStorage.setItem(LS_ENDPOINT, base)
      localStorage.setItem(LS_TOKEN, j.data.token)
      const list = new Set([base, ...this.candidates()])
      this.setCandidates(Array.from(list))
      this.setOnline(true)
      return { ok: true }
    } catch {
      return { ok: false, error: '无法连接到该地址' }
    }
  }

  unpair() {
    this.token = null
    localStorage.removeItem(LS_TOKEN)
    this.nodeReach.clear()
    this.setOnline(false)
  }

  private authHeaders(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {}
  }

  /** 带鉴权的 JSON 请求。网络失败抛出（供 outbox 判定离线）。 */
  async request<T>(path: string, init?: RequestInit): Promise<T> {
    if (!this.base) throw new Error('offline')
    const r = await fetch(`${this.base}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders(),
        ...(init?.headers ?? {}),
      },
    })
    if (r.status === 401) {
      this.setOnline(true)
      throw new RequestError(401, 'unauthorized')
    }
    const j = await r.json()
    this.setOnline(true)
    if (!j.ok) throw new RequestError(r.status, j.error?.message ?? 'request failed')
    return j.data as T
  }

  async get<T>(path: string): Promise<T> {
    try {
      return await this.request<T>(path)
    } catch (e) {
      if (e instanceof Error && (e.message === 'offline' || e.name === 'TypeError')) this.setOnline(false)
      throw e
    }
  }

  async send<T>(path: string, method: string, body?: unknown): Promise<T> {
    try {
      return await this.request<T>(path, { method, body: body ? JSON.stringify(body) : undefined })
    } catch (e) {
      if (!(e instanceof Error) || (e.message !== 'unauthorized')) this.setOnline(false)
      throw e
    }
  }

  uploadFile<T>(path: string, file: File, onProgress: (percent: number) => void): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.base) {reject(new Error('请先连接 PC')); return}
      const xhr = new XMLHttpRequest()
      xhr.open('PUT', `${this.base}${path}`)
      Object.entries(this.authHeaders()).forEach(([key, value]) => xhr.setRequestHeader(key, value))
      xhr.setRequestHeader('Content-Type', 'application/octet-stream')
      xhr.upload.onprogress = event => {if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100))}
      xhr.timeout = 30 * 60 * 1000
      xhr.onerror = () => reject(new Error('上传连接中断，请刷新目录核对后重试'))
      xhr.ontimeout = () => reject(new Error('上传超时，请刷新目录核对后重试'))
      xhr.onload = () => {
        try {
          const body = JSON.parse(xhr.responseText)
          if (xhr.status >= 200 && xhr.status < 300 && body.ok) resolve(body.data as T)
          else reject(new Error(body.error?.message ?? '上传失败，请检查连接器版本'))
        } catch {reject(new Error('上传失败，请先更新 PC 服务和连接器'))}
      }
      xhr.send(file)
    })
  }

  /** 代理串流 URL（调度中心转发，token 走 query，供 <video src>）——同步、总可作回落 */
  proxyStreamUrl(id: string): string {
    return `${this.base}/api/media/${id}/stream${this.token ? `?token=${encodeURIComponent(this.token)}` : ''}`
  }

  /** 探测一个直连源是否可达（其 /healthz，~1.5s 超时；CORS 已放开） */
  private async reachable(origin: string): Promise<boolean> {
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 1500)
      const r = await fetch(`${origin}/healthz`, { signal: ctrl.signal })
      clearTimeout(t)
      return r.ok
    } catch {
      return false
    }
  }

  /**
   * 智能视频流 URL（供 <video src>）：先问调度中心 stream-locate 拿直连/代理两个地址，
   * 探测直连连接器可达则直连（局域网快、调度中心零字节流量），否则回落到代理转发。
   * 可达性决策按 nodeId 缓存本 session。老服务器无此接口时回落到同步代理 URL。
   */
  async streamUrl(id: string): Promise<string> {
    if (!this.base) return this.proxyStreamUrl(id)
    let loc: StreamLocate
    try {
      loc = await this.request<StreamLocate>(`/api/media/${id}/stream-locate`)
    } catch {
      // stream-locate 不可用（老后端 / 源离线）→ 直接用代理 URL
      return this.proxyStreamUrl(id)
    }
    const proxy = loc.proxyUrl && this.token
      ? `${loc.proxyUrl}?token=${encodeURIComponent(this.token)}`
      : this.proxyStreamUrl(id)

    let ok = this.nodeReach.get(loc.nodeId)
    if (ok === undefined) {
      let origin: string
      try {
        origin = new URL(loc.directUrl).origin
      } catch {
        return proxy
      }
      ok = await this.reachable(origin)
      this.nodeReach.set(loc.nodeId, ok)
    }
    return ok ? loc.directUrl : proxy
  }

  /** 忘记直连可达性缓存（如切换网络后重探） */
  resetReach() {
    this.nodeReach.clear()
  }

  /** 海报 URL */
  posterUrl(id: string): string {
    return `${this.base}/api/media/${id}/poster${this.token ? `?token=${encodeURIComponent(this.token)}` : ''}`
  }

  /** 从调度中心取 enroll 凭证（转交给待配对连接器用） */
  async getEnrollInfo(): Promise<{ coordinatorUrl: string; enrollToken: string }> {
    return await this.request<{ coordinatorUrl: string; enrollToken: string }>('/api/enroll-info')
  }

  /**
   * 配对一台新的存储设备：先向调度中心取 enroll 凭证，再直接 POST 到连接器地址的
   * /api/pair，把它接入本调度中心。address 规范化仿 pair()（补协议、默认端口 8788）。
   */
  async pairDevice(
    address: string,
    code: string,
    roots: string[],
  ): Promise<{ ok: boolean; error?: string }> {
    let base = address.trim()
    if (!/^https?:\/\//i.test(base)) base = `http://${base}`
    base = base.replace(/\/+$/, '')
    // 未显式带端口则补连接器默认端口
    try {
      const u = new URL(base)
      if (!u.port) {
        u.port = '8788'
        base = u.toString().replace(/\/+$/, '')
      }
    } catch {
      return { ok: false, error: '设备地址格式不正确' }
    }
    let info: { coordinatorUrl: string; enrollToken: string }
    try {
      info = await this.getEnrollInfo()
    } catch {
      return { ok: false, error: '需先连接调度中心（PC 在线）才能添加设备' }
    }
    try {
      const r = await fetch(`${base}/api/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          coordinatorUrl: info.coordinatorUrl,
          enrollToken: info.enrollToken,
          roots,
        }),
      })
      const j = await r.json()
      if (!j.ok) return { ok: false, error: j.error?.message ?? '配对失败' }
      return { ok: true }
    } catch {
      return { ok: false, error: '无法连接到该设备地址（确认连接器已在配对模式运行）' }
    }
  }
}

export const transport = new Transport()

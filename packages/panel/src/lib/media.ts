// 媒体工具：本地文件读取（时长/缩略图）、演示视频生成、海报绘制

/** 读取视频文件时长 */
export function probeVideo(file: Blob): Promise<{ duration: number; url: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.src = url
    v.onloadedmetadata = () => resolve({ duration: v.duration || 0, url })
    v.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('无法读取视频'))
    }
  })
}

/** 从视频截取缩略图 */
export function captureThumb(url: string, at = 1): Promise<string | undefined> {
  return new Promise((resolve) => {
    const v = document.createElement('video')
    v.preload = 'auto'
    v.muted = true
    v.src = url
    v.crossOrigin = 'anonymous'
    const cleanup = () => v.remove()
    v.onloadeddata = () => {
      v.currentTime = Math.min(at, (v.duration || 2) / 2)
    }
    v.onseeked = () => {
      try {
        const w = 480
        const h = Math.round((w * (v.videoHeight || 9)) / (v.videoWidth || 16))
        const c = document.createElement('canvas')
        c.width = w
        c.height = h
        c.getContext('2d')!.drawImage(v, 0, 0, w, h)
        resolve(c.toDataURL('image/jpeg', 0.7))
      } catch {
        resolve(undefined)
      } finally {
        cleanup()
      }
    }
    v.onerror = () => {
      cleanup()
      resolve(undefined)
    }
    setTimeout(() => resolve(undefined), 5000)
  })
}

/** 绘制电影风格海报（用于无本地文件的云盘素材占位） */
export function drawPoster(title: string, subtitle: string, hue: number): string {
  const w = 480
  const h = 640
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  const g = ctx.createLinearGradient(0, 0, w, h)
  g.addColorStop(0, `hsl(${hue}, 55%, 22%)`)
  g.addColorStop(1, `hsl(${(hue + 60) % 360}, 60%, 10%)`)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  // 装饰圆
  ctx.globalAlpha = 0.25
  for (let i = 0; i < 5; i++) {
    ctx.beginPath()
    ctx.arc(w * (0.2 + i * 0.18), h * (0.2 + ((i * 137) % 60) / 100), 60 + i * 22, 0, Math.PI * 2)
    ctx.fillStyle = `hsl(${(hue + i * 30) % 360}, 70%, 55%)`
    ctx.fill()
  }
  ctx.globalAlpha = 1
  // 胶片孔
  ctx.fillStyle = 'rgba(0,0,0,0.5)'
  for (let y = 24; y < h; y += 64) {
    ctx.fillRect(14, y, 18, 30)
    ctx.fillRect(w - 32, y, 18, 30)
  }
  // 标题
  ctx.fillStyle = '#fff'
  ctx.font = 'bold 44px system-ui, sans-serif'
  ctx.textAlign = 'center'
  const chars = title.split('')
  const lines: string[] = []
  let line = ''
  for (const ch of chars) {
    if (ctx.measureText(line + ch).width > w - 120) {
      lines.push(line)
      line = ch
    } else line += ch
  }
  if (line) lines.push(line)
  lines.slice(0, 3).forEach((l, i) => ctx.fillText(l, w / 2, h - 180 + i * 56))
  ctx.font = '24px system-ui, sans-serif'
  ctx.fillStyle = 'rgba(255,255,255,0.7)'
  ctx.fillText(subtitle, w / 2, h - 180 + lines.slice(0, 3).length * 56 + 12)
  return c.toDataURL('image/jpeg', 0.8)
}

/** 生成一段竖屏演示视频（canvas 动画 → webm），约 seconds 秒 */
export function generateDemoVideo(seconds = 6, hue = 210): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const w = 480
    const h = 854
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d')!
    const stream = c.captureStream(30)
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : 'video/webm'
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_500_000 })
    const chunks: Blob[] = []
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
    rec.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }))
    rec.onerror = () => reject(new Error('演示视频生成失败'))

    const t0 = performance.now()
    let running = true
    const draw = () => {
      if (!running) return
      const t = (performance.now() - t0) / 1000
      const g = ctx.createLinearGradient(0, 0, 0, h)
      g.addColorStop(0, `hsl(${hue + Math.sin(t) * 20}, 50%, 16%)`)
      g.addColorStop(1, `hsl(${(hue + 80) % 360}, 55%, 8%)`)
      ctx.fillStyle = g
      ctx.fillRect(0, 0, w, h)
      // 运动主体
      const x = w / 2 + Math.sin(t * 1.6) * w * 0.3
      const y = h / 2 + Math.cos(t * 1.1) * h * 0.25
      const rg = ctx.createRadialGradient(x, y, 10, x, y, 140)
      rg.addColorStop(0, `hsla(${(hue + 40) % 360}, 90%, 65%, 0.95)`)
      rg.addColorStop(1, 'transparent')
      ctx.fillStyle = rg
      ctx.beginPath()
      ctx.arc(x, y, 140, 0, Math.PI * 2)
      ctx.fill()
      // 扫描线
      ctx.fillStyle = 'rgba(255,255,255,0.06)'
      ctx.fillRect(0, ((t * 120) % (h + 200)) - 100, w, 60)
      // 时间码
      ctx.fillStyle = 'rgba(255,255,255,0.85)'
      ctx.font = 'bold 34px ui-monospace, monospace'
      ctx.textAlign = 'center'
      ctx.fillText(`DEMO  ${t.toFixed(1)}s`, w / 2, h - 60)
      // 顶部安全区标识
      ctx.font = '20px system-ui'
      ctx.fillStyle = 'rgba(255,255,255,0.5)'
      ctx.fillText('竖屏演示素材 · 可打点试玩', w / 2, 70)
      if (t < seconds) requestAnimationFrame(draw)
      else {
        running = false
        rec.stop()
      }
    }
    rec.start(200)
    draw()
  })
}

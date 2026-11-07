// 剪辑执行：后台用隐藏 video 播放母素材的 [start, end] 区间，captureStream + MediaRecorder 录制为 webm
// 一个浏览器标签页内同时只允许一个剪辑任务执行

let busy = false
export const isClipBusy = () => busy

export interface ClipJob {
  src: string
  start: number
  end: number
}

/**
 * 执行剪辑：播完区间后 resolve(webm Blob)；不支持录制/播放失败时 reject
 */
export async function runClip(job: ClipJob): Promise<Blob> {
  if (busy) throw new Error('已有剪辑任务在执行')
  if (typeof MediaRecorder === 'undefined') throw new Error('当前浏览器不支持录制')
  busy = true
  const v = document.createElement('video')
  try {
    v.src = job.src
    v.muted = false
    v.playsInline = true
    v.crossOrigin = 'anonymous'
    await new Promise<void>((res, rej) => {
      v.onloadedmetadata = () => res()
      v.onerror = () => rej(new Error('素材读取失败'))
      v.load()
    })
    v.currentTime = job.start

    type CaptureVideo = HTMLVideoElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream }
    const stream = (v as CaptureVideo).captureStream?.() ?? (v as CaptureVideo).mozCaptureStream?.()
    if (!stream) throw new Error('当前浏览器不支持片段剪辑')

    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm'
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 })
    const chunks: Blob[] = []
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
    const stopped = new Promise<void>((res) => (rec.onstop = () => res()))

    await v.play()
    rec.start(200)
    await new Promise<void>((res, rej) => {
      const timeout = window.setTimeout(() => rej(new Error('剪辑超时')), (job.end - job.start) * 1000 + 15000)
      const tick = () => {
        if (v.currentTime >= job.end || v.ended) {
          window.clearTimeout(timeout)
          res()
        } else if (v.error) {
          window.clearTimeout(timeout)
          rej(new Error('播放失败'))
        } else requestAnimationFrame(tick)
      }
      tick()
    })
    v.pause()
    rec.stop()
    await stopped
    if (!chunks.length) throw new Error('录制结果为空')
    return new Blob(chunks, { type: 'video/webm' })
  } finally {
    busy = false
    v.removeAttribute('src')
    v.load()
  }
}

/** 触发浏览器下载 */
export function downloadBlob(blob: Blob, filename: string): void {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}

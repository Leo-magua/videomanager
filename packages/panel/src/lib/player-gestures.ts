export interface VideoBounds {left: number; top: number; width: number; height: number}

/** Object-contain video bounds: holds in the surrounding letterbox do nothing. */
export function containedVideoBounds(box: VideoBounds, width: number, height: number): VideoBounds {
  if (!(width > 0 && height > 0)) return box
  const scale = Math.min(box.width / width, box.height / height)
  const w = width * scale, h = height * scale
  return {left: box.left + (box.width - w) / 2, top: box.top + (box.height - h) / 2, width: w, height: h}
}
export function holdDirection(x: number, y: number, box: VideoBounds): -1 | 0 | 1 {
  if (x < box.left || x > box.left + box.width || y < box.top || y > box.top + box.height) return 0
  const ratio = (x - box.left) / box.width
  return ratio < 0.42 ? -1 : ratio > 0.58 ? 1 : 0
}
export function boundedSeek(time: number, start: number, end: number): number {
  return Math.max(start, Math.min(Math.max(start, end - 0.04), time))
}
export function previewOffset(dy: number, height: number, hasTarget: boolean): number {
  const distance = Math.max(-height, Math.min(height, dy))
  return hasTarget ? distance : distance * 0.18
}

interface SeekableVideo {currentTime: number; paused: boolean; pause: () => void; play: () => Promise<void>}
/** A hold scrubs at 10 seconds/second, then restores the previous playback state. */
export class HoldSeek {
  active = false
  private timer?: ReturnType<typeof setTimeout>
  private interval?: ReturnType<typeof setInterval>
  private resume = false
  private video?: SeekableVideo
  private onActive?: (direction: -1 | 0 | 1) => void
  begin(direction: -1 | 1, video: SeekableVideo, start: number, end: number, onTime: (time: number) => void, onActive: (direction: -1 | 0 | 1) => void) {
    this.stop(false)
    this.video = video; this.onActive = onActive
    this.timer = setTimeout(() => {
      this.active = true; this.resume = !video.paused
      video.pause(); onActive(direction)
      let previous = performance.now()
      this.interval = setInterval(() => {
        const now = performance.now(), elapsed = Math.min(250, now - previous)
        previous = now
        video.currentTime = boundedSeek(video.currentTime + direction * 10 * elapsed / 1000, start, end)
        onTime(video.currentTime)
      }, 120)
    }, 420)
  }
  stop(restore = true): boolean {
    clearTimeout(this.timer); clearInterval(this.interval)
    const held = this.active
    this.active = false
    if (held) {
      this.onActive?.(0)
      if (restore && this.resume && this.video) void this.video.play().catch(() => {})
    }
    this.video = undefined; this.onActive = undefined; this.resume = false
    return held
  }
}

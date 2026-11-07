import type { MediaItem } from '@/types'
import {sortMedia, type RatingSort} from './rating-sort'

const normalize = (value: string) => value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
const directory = (item: MediaItem) => item.filePath ? normalize(item.filePath).split('/').slice(0, -1).join('/') : normalize(item.folder ?? '')

/** Only playable source videos in the exact same storage and directory. */
export function directoryVideos(items: MediaItem[], current: MediaItem | undefined, order: RatingSort = 'default'): MediaItem[] {
  if (!current || current.kind !== 'source') return []
  const videos = items.filter(item => item.kind === 'source' && item.hasFile && (item.storageId ?? null) === (current.storageId ?? null) && directory(item) === directory(current))
    .sort((a, b) => {
      const left = (a.filePath ?? a.name).toLocaleLowerCase()
      const right = (b.filePath ?? b.name).toLocaleLowerCase()
      return left < right ? -1 : left > right ? 1 : a.id.localeCompare(b.id)
    })
  return sortMedia(videos, order)
}

/** Down means next; reject short, diagonal and horizontal movements. */
export function videoSwipe(dx: number, dy: number): -1 | 0 | 1 {
  if (Math.abs(dy) < 64 || Math.abs(dy) < Math.abs(dx) * 1.4) return 0
  return dy > 0 ? 1 : -1
}

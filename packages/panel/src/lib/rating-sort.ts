import type {FileEntry, MediaItem} from '@/types'

export type RatingSort = 'default' | 'rating-desc' | 'rating-asc'
export const RATING_SORT_KEY = 'vm.librarySort'
export function validRatingSort(value: unknown): RatingSort {
  return value === 'rating-desc' || value === 'rating-asc' ? value : 'default'
}

function score(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function compareRating(a: number | undefined, b: number | undefined, order: RatingSort): number {
  const left = score(a), right = score(b)
  if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1
  return order === 'rating-asc' ? left - right : right - left
}

const compareName = (a: string, b: string) => a.localeCompare(b, 'zh', {numeric: true, sensitivity: 'base'})

/** Keep the supplied default order. Rating modes put unrated entries last. */
export function sortMedia(items: readonly MediaItem[], order: RatingSort): MediaItem[] {
  return order === 'default' ? [...items] : [...items].sort((a, b) =>
    compareRating(a.rating, b.rating, order) || compareName(a.filePath ?? a.name, b.filePath ?? b.name) || a.id.localeCompare(b.id))
}

/** Folders remain first; ordinary files and unindexed videos have no rating. */
export function sortFileEntries(entries: readonly FileEntry[], ratingOf: (entry: FileEntry) => number | undefined, order: RatingSort): FileEntry[] {
  return order === 'default' ? [...entries] : [...entries].sort((a, b) =>
    Number(b.kind === 'directory') - Number(a.kind === 'directory') ||
    (a.kind === 'directory' ? 0 : compareRating(ratingOf(a), ratingOf(b), order)) ||
    compareName(a.name, b.name) || a.path.localeCompare(b.path))
}

/** Paint every crossed item, including rows skipped by a fast finger movement. */
export function selectionSegment(ids: readonly string[], previous: string, current: string): string[] {
  const from = ids.indexOf(previous), to = ids.indexOf(current)
  if (to < 0) return []
  return from < 0 ? [current] : ids.slice(Math.min(from, to), Math.max(from, to) + 1)
}

/** Pixels per 60 Hz frame; leave room for the sticky toolbar and bottom tabs. */
export function selectionScrollSpeed(y: number, height: number): number {
  const top = 104, bottom = height - 112
  if (y < top) return -16 * Math.min(1, Math.max(0, (top - y) / 64))
  if (y > bottom) return 16 * Math.min(1, Math.max(0, (y - bottom) / 64))
  return 0
}

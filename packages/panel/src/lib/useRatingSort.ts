import {useSyncExternalStore} from 'react'
import {RATING_SORT_KEY, validRatingSort, type RatingSort} from './rating-sort'

const eventName = 'vm-rating-sort-change'
let fallback: RatingSort = 'default'
let sessionOverride: RatingSort | null = null
function read(): RatingSort {
  if (sessionOverride !== null) return sessionOverride
  try {return validRatingSort(localStorage.getItem(RATING_SORT_KEY))} catch {return fallback}
}
function subscribe(notify: () => void) {
  window.addEventListener(eventName, notify)
  window.addEventListener('storage', notify)
  return () => {window.removeEventListener(eventName, notify); window.removeEventListener('storage', notify)}
}
function setSort(value: RatingSort) {
  fallback = value
  try {localStorage.setItem(RATING_SORT_KEY, value); sessionOverride = null} catch {sessionOverride = value}
  window.dispatchEvent(new Event(eventName))
}
export function useRatingSort() {
  const order = useSyncExternalStore(subscribe, read, () => 'default' as RatingSort)
  return [order, setSort] as const
}

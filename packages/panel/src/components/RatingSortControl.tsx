import {ArrowDownWideNarrow} from 'lucide-react'
import {validRatingSort, type RatingSort} from '@/lib/rating-sort'

export function RatingSortControl({value, onChange}: {value: RatingSort; onChange: (value: RatingSort) => void}) {
  return <label data-swipe-ignore className={`flex min-h-10 shrink-0 items-center gap-1 text-xs ${value === 'default' ? 'text-zinc-400' : 'text-amber-400'}`}>
    <ArrowDownWideNarrow size={15} aria-hidden="true" />
    <select aria-label="素材排序" value={value} onChange={event => onChange(validRatingSort(event.target.value))} className="max-w-32 rounded-lg border border-zinc-700 bg-zinc-900 px-1 py-2 text-xs outline-none focus:border-amber-500">
      <option value="default">默认顺序</option>
      <option value="rating-desc">评分从高到低</option>
      <option value="rating-asc">评分从低到高</option>
    </select>
  </label>
}

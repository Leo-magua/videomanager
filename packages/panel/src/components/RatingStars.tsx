import { Star } from 'lucide-react'

interface Props {
  value: number
  onChange?: (v: number) => void
  size?: number
}

/** 五星评分：点击第 n 颗星打 n 分，再点一次清零 */
export function RatingStars({ value, onChange, size = 20 }: Props) {
  return (
    <div className="flex items-center gap-1">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          disabled={!onChange}
          onClick={() => onChange?.(value === n ? 0 : n)}
          className={onChange ? 'active:scale-125 transition-transform p-0.5' : 'p-0.5 cursor-default'}
          aria-label={`${n} 星`}
        >
          <Star
            size={size}
            className={n <= value ? 'fill-amber-400 text-amber-400' : 'text-zinc-600'}
          />
        </button>
      ))}
      {value > 0 && <span className="ml-1 text-xs text-amber-400/90 font-medium">{(value * 2).toFixed(0)} 分</span>}
    </div>
  )
}

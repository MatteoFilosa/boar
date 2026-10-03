import { type FadeCurve, fadeShape } from '../core/fades'
import type { MenuIconComponent } from './ContextMenu'

const icons = new Map<string, MenuIconComponent>()

/** Menu icon drawing a fade curve: rising for a fade in, falling for a fade out. */
export function fadeCurveIcon(curve: FadeCurve, side: 'in' | 'out'): MenuIconComponent {
  const key = `${curve}:${side}`
  const cached = icons.get(key)
  if (cached) return cached
  const points: string[] = []
  for (let i = 0; i <= 16; i++) {
    const p = i / 16
    const x = side === 'in' ? 2 + p * 12 : 14 - p * 12
    points.push(`${x.toFixed(2)} ${(14 - fadeShape(curve, p) * 12).toFixed(2)}`)
  }
  const d = `M${points.join('L')}`
  const icon: MenuIconComponent = ({ size = 14, strokeWidth = 2 }) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  )
  icons.set(key, icon)
  return icon
}

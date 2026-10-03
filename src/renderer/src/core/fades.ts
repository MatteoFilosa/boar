// Fade curves (Fade Type) and playback rate limits.

export type FadeCurve = 'linear' | 'fast' | 'slow' | 'smooth' | 'sharp'

export const FADE_CURVES: { id: FadeCurve; label: string }[] = [
  { id: 'fast', label: 'Fast' },
  { id: 'linear', label: 'Linear' },
  { id: 'slow', label: 'Slow' },
  { id: 'smooth', label: 'Smooth' },
  { id: 'sharp', label: 'Sharp' }
]

export const DEFAULT_FADE_CURVE: FadeCurve = 'linear'

export const isFadeCurve = (v: unknown): v is FadeCurve => FADE_CURVES.some((c) => c.id === v)

/**
 * Level of a fade at `p` = fraction of the way from the silent/transparent edge
 * (0) to the full level (1). Fade-outs use the same shape mirrored in time.
 */
export function fadeShape(curve: FadeCurve, p: number): number {
  const x = p <= 0 ? 0 : p >= 1 ? 1 : p
  switch (curve) {
    case 'fast':
      return 1 - (1 - x) * (1 - x)
    case 'slow':
      return x * x
    case 'smooth':
      return x * x * (3 - 2 * x)
    case 'sharp':
      return x < 0.5 ? (1 - (1 - 2 * x) * (1 - 2 * x)) / 2 : 0.5 + ((2 * x - 1) * (2 * x - 1)) / 2
    default:
      return x
  }
}

/** Playback rate range for Ctrl+drag time stretch and the rate presets. */
export const MIN_RATE = 0.25
export const MAX_RATE = 4

export const RATE_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]

export const clampRate = (r: number): number => Math.min(MAX_RATE, Math.max(MIN_RATE, r))

export const formatRate = (r: number): string => `${r.toFixed(2)}x`

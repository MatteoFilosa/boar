/**
 * Timeline time is an integer number of flicks (1/705,600,000 s). Every common
 * video frame rate (including the NTSC x/1001 rates) and audio sample rate
 * divides a second into a whole number of flicks, so frame-aligned positions
 * stay exact integers and never drift.
 */
export type Flicks = number

export const FLICKS_PER_SECOND = 705_600_000

export interface FrameRate {
  num: number
  den: number
}

export const secondsToFlicks = (seconds: number): Flicks => Math.round(seconds * FLICKS_PER_SECOND)
export const flicksToSeconds = (t: Flicks): number => t / FLICKS_PER_SECOND

export const fps = (rate: FrameRate): number => rate.num / rate.den
export const frameFlicks = (rate: FrameRate): Flicks => Math.round((FLICKS_PER_SECOND * rate.den) / rate.num)

export const quantizeToFrame = (t: Flicks, rate: FrameRate): Flicks => {
  const frame = frameFlicks(rate)
  return Math.round(t / frame) * frame
}

export const floorToFrame = (t: Flicks, rate: FrameRate): Flicks => {
  const frame = frameFlicks(rate)
  return Math.floor(t / frame) * frame
}

export const frameIndex = (t: Flicks, rate: FrameRate): number => Math.floor(t / frameFlicks(rate) + 1e-6)

export const STANDARD_RATES: { label: string; rate: FrameRate }[] = [
  { label: '23.976', rate: { num: 24000, den: 1001 } },
  { label: '24.000', rate: { num: 24, den: 1 } },
  { label: '25.000', rate: { num: 25, den: 1 } },
  { label: '29.970', rate: { num: 30000, den: 1001 } },
  { label: '30.000', rate: { num: 30, den: 1 } },
  { label: '50.000', rate: { num: 50, den: 1 } },
  { label: '59.940', rate: { num: 60000, den: 1001 } },
  { label: '60.000', rate: { num: 60, den: 1 } }
]

/** Closest standard rate to a measured frame rate (phones often report 29.98 or 30.02). */
export function nearestStandardRate(measured: number): FrameRate {
  let best = STANDARD_RATES[3].rate
  let bestDiff = Infinity
  for (const { rate } of STANDARD_RATES) {
    const diff = Math.abs(fps(rate) - measured)
    if (diff < bestDiff) {
      best = rate
      bestDiff = diff
    }
  }
  return { ...best }
}

export const rateLabel = (rate: FrameRate): string => fps(rate).toFixed(3)

const pad2 = (v: number): string => String(v).padStart(2, '0')

/** SMPTE timecode. 29.97 and 59.94 use drop-frame notation (`;` before frames). */
export function formatTimecode(t: Flicks, rate: FrameRate): string {
  const frame = Math.max(0, Math.round(t / frameFlicks(rate)))
  const exact = fps(rate)
  const nominal = Math.round(exact)
  const dropFrame = rate.den === 1001 && (nominal === 30 || nominal === 60)
  let n = frame
  if (dropFrame) {
    const drop = nominal === 30 ? 2 : 4
    const per10Minutes = Math.round(exact * 600)
    const perMinute = nominal * 60 - drop
    const tens = Math.floor(n / per10Minutes)
    const rest = n % per10Minutes
    n += drop * 9 * tens + (rest > drop ? drop * Math.floor((rest - drop) / perMinute) : 0)
  }
  const ff = n % nominal
  const totalSeconds = Math.floor(n / nominal)
  const ss = totalSeconds % 60
  const mm = Math.floor(totalSeconds / 60) % 60
  const hh = Math.floor(totalSeconds / 3600)
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}${dropFrame ? ';' : ':'}${pad2(ff)}`
}

/** Compact duration for lists: 1:23.45 or 1:02:03.4 */
export function formatDuration(t: Flicks): string {
  const total = flicksToSeconds(t)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const sec = s.toFixed(2).padStart(5, '0')
  return h > 0 ? `${h}:${pad2(m)}:${sec}` : `${m}:${sec}`
}

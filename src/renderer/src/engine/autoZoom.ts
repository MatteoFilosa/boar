import { ALL_FORMATS, CanvasSink, Input } from 'mediabunny'
import { type PanCropKey, type PanCropState, DEFAULT_PANCROP, fitFrame, panCropAt } from '../core/pancrop'
import { FLICKS_PER_SECOND, secondsToFlicks } from '../core/time'
import type { MediaItem, ProjectSettings, TimelineEvent } from '../core/types'
import { inputSource } from '../media/source'
import { imageCache } from '../media/cache'
import { HOP, eventLevels, mediaLevels } from './analysis'
import { type Face, detectFaces } from './vision'

// Auto Zoom multiplies the zoom of the event's Pan/Crop (keeping its framing) and
// can move the center toward the face.

export type ZoomMode = 'cuts' | 'push' | 'punch'

export interface AutoZoomOptions {
  /** cuts: every other clip zoomed in (jump-cut zoom); push: slow zoom across each clip; punch: quick zoom on loud moments. */
  mode: ZoomMode
  /** Zoom factor, e.g. 1.15. */
  amount: number
  /** Center the zoom on the face. */
  face: boolean
}

export const ZOOM_MODES: { id: ZoomMode; label: string }[] = [
  { id: 'cuts', label: 'Alternate on cuts (jump-cut zoom)' },
  { id: 'punch', label: 'Punch in on loud moments' },
  { id: 'push', label: 'Slow push-in on every clip' }
]

const PUNCH_IN = 0.12
const PUNCH_HOLD = 1.3
const PUNCH_OUT = 0.3
const PUNCH_GAP = 3

/** The face in the frame at `seconds` of the media, if any. */
export async function faceAt(media: MediaItem, seconds: number): Promise<Face | null> {
  let canvas: OffscreenCanvas | HTMLCanvasElement | null = null
  if (media.kind === 'image') {
    const bitmap = imageCache.get(media.id)
    if (!bitmap) return null
    canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    ;(canvas.getContext('2d') as OffscreenCanvasRenderingContext2D).drawImage(bitmap, 0, 0)
  } else {
    const input = new Input({ formats: ALL_FORMATS, source: inputSource(media) })
    try {
      const track = await input.getPrimaryVideoTrack()
      if (!track) return null
      const first = Math.max(0, await input.getFirstTimestamp())
      const width = 512
      const height = Math.round((width * track.displayHeight) / Math.max(1, track.displayWidth))
      const frame = await new CanvasSink(track, { width, height, fit: 'fill' }).getCanvas(first + seconds)
      canvas = frame?.canvas ?? null
    } finally {
      input.dispose()
    }
  }
  if (!canvas) return null
  const faces = await detectFaces(canvas)
  return [...faces].sort((a, b) => b.w * b.h * b.score - a.w * a.h * a.score)[0] ?? null
}

/** Source times (seconds) of loud moments in the event: onsets well above its typical speech level. */
export async function loudMoments(event: TimelineEvent, media: MediaItem): Promise<number[]> {
  if (!media.hasAudio) return []
  const offset = event.offset / FLICKS_PER_SECOND
  const levels = eventLevels(await mediaLevels(media), offset, event.length / FLICKS_PER_SECOND, event.rate)
  if (levels.length === 0) return []
  // 150 ms moving average, then peaks over the 80th percentile of the speech.
  const radius = Math.round(0.075 / HOP)
  const smooth = Array.from(levels, (_, i) => {
    let sum = 0
    let n = 0
    for (let k = Math.max(0, i - radius); k <= Math.min(levels.length - 1, i + radius); k++) {
      sum += levels[k]
      n++
    }
    return sum / n
  })
  const speech = smooth.filter((v) => v > -60).sort((a, b) => a - b)
  if (speech.length < 20) return []
  const threshold = speech[Math.floor(speech.length * 0.8)]
  const out: number[] = []
  let last = -Infinity
  for (let i = 1; i + 1 < smooth.length; i++) {
    const t = i * HOP
    if (smooth[i] < threshold || smooth[i] < smooth[i - 1] || smooth[i] < smooth[i + 1]) continue
    if (t - last < PUNCH_GAP || t < 0.4) continue
    out.push(offset + t * event.rate)
    last = t
  }
  return out
}

/** Zoom multiplier over the event's source time: 1 = its own framing. */
type Factor = (sourceSeconds: number) => number

function factorFor(event: TimelineEvent, o: AutoZoomOptions, zoomed: boolean, moments: number[]): { at: Factor; times: number[] } {
  const from = event.offset / FLICKS_PER_SECOND
  const to = from + (event.length * event.rate) / FLICKS_PER_SECOND
  if (o.mode === 'cuts') return { at: () => (zoomed ? o.amount : 1), times: [from] }
  if (o.mode === 'push') {
    return { at: (t) => 1 + (o.amount - 1) * Math.min(1, Math.max(0, (t - from) / Math.max(0.01, to - from))), times: [from, to] }
  }
  const times: number[] = [from]
  for (const m of moments) times.push(m - PUNCH_IN, m, m + PUNCH_HOLD, m + PUNCH_HOLD + PUNCH_OUT)
  const at: Factor = (t) => {
    let f = 1
    for (const m of moments) {
      if (t < m - PUNCH_IN || t > m + PUNCH_HOLD + PUNCH_OUT) continue
      const g = t < m ? (t - (m - PUNCH_IN)) / PUNCH_IN : t <= m + PUNCH_HOLD ? 1 : 1 - (t - m - PUNCH_HOLD) / PUNCH_OUT
      f = Math.max(f, 1 + (o.amount - 1) * g)
    }
    return f
  }
  return { at, times: times.filter((t) => t >= from && t <= to) }
}

/**
 * New Pan/Crop keys for an event: its framing (or the default one) zoomed by
 * the mode's factor, centered on the face while zoomed in.
 */
export function zoomKeys(
  event: TimelineEvent,
  media: MediaItem,
  settings: ProjectSettings,
  o: AutoZoomOptions,
  zoomed: boolean,
  face: Face | null,
  moments: number[]
): PanCropKey[] {
  const base = event.panCrop.length ? event.panCrop : [{ ...DEFAULT_PANCROP, time: event.offset, ease: 'smooth' as const }]
  const { at, times } = factorFor(event, o, zoomed, moments)
  const all = [...new Set([...times.map((t) => secondsToFlicks(t)), ...base.map((k) => k.time)])].sort((a, b) => a - b)
  const fit = media.width && media.height ? fitFrame(media.width, media.height, settings.width, settings.height) : null
  const state = (time: number): PanCropState => {
    const b = panCropAt(base, time)
    const f = at(time / FLICKS_PER_SECOND)
    const zoom = b.zoom * f
    let { cx, cy } = b
    if (face && f > 1 && o.amount > 1) {
      const w = Math.min(1, (f - 1) / (o.amount - 1))
      cx += (face.cx - cx) * w
      // A little headroom above the face.
      cy += (face.cy + 0.04 - cy) * w
    }
    if (fit && media.width && media.height) {
      // Keep the zoomed frame inside the picture when it is smaller than it.
      const halfW = fit.w / zoom / media.width / 2
      const halfH = fit.h / zoom / media.height / 2
      cx = halfW < 0.5 ? Math.min(1 - halfW, Math.max(halfW, cx)) : 0.5
      cy = halfH < 0.5 ? Math.min(1 - halfH, Math.max(halfH, cy)) : 0.5
    }
    return { cx, cy, zoom, rotation: b.rotation }
  }
  const ease: PanCropKey['ease'] = o.mode === 'cuts' ? 'smooth' : 'linear'
  return all.map((time) => ({ time, ...state(time), ease }))
}

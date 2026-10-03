import { ALL_FORMATS, CanvasSink, Input } from 'mediabunny'
import { FLICKS_PER_SECOND, secondsToFlicks } from '../core/time'
import type { MediaItem, ProjectSettings, TimelineEvent } from '../core/types'
import { type PanCropKey, fillZoom, fitFrame } from '../core/pancrop'
import { inputSource } from '../media/source'
import { imageCache } from '../media/cache'
import { type Face, detectFaces } from './vision'

// Auto Reframe: face positions sampled a few times per second, smoothed and
// written as Event Pan/Crop keyframes.

const SAMPLES_PER_SECOND = 5
const ANALYSIS_WIDTH = 512

export interface FaceSample {
  /** Source time, seconds. */
  time: number
  face: Face | null
}

export interface ReframeOptions {
  /** Follow the face, or frame it once for the whole event. */
  mode: 'follow' | 'static'
  /** 0 = nervous, 1 = very steady. */
  smoothness: number
  /** Extra zoom on top of filling the frame (1 = just fill). */
  zoom: number
}

/** The face to follow: near the previous one, otherwise the biggest confident one. */
function pickFace(faces: Face[], previous: Face | null): Face | null {
  if (faces.length === 0) return null
  if (previous) {
    const near = faces
      .map((f) => ({ f, d: Math.hypot(f.cx - previous.cx, f.cy - previous.cy) }))
      .filter((x) => x.d < 0.18)
      .sort((a, b) => a.d - b.d)[0]
    if (near) return near.f
  }
  return [...faces].sort((a, b) => b.w * b.h * b.score - a.w * a.h * a.score)[0]
}

/** Detects the face along an event's source range. */
export async function analyzeFaces(
  event: TimelineEvent,
  media: MediaItem,
  onProgress: (fraction: number) => void,
  isCancelled: () => boolean
): Promise<FaceSample[]> {
  const from = event.offset / FLICKS_PER_SECOND
  const duration = (event.length * event.rate) / FLICKS_PER_SECOND
  if (media.kind === 'image') {
    const bitmap = imageCache.get(media.id)
    if (!bitmap) return []
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    ;(canvas.getContext('2d') as OffscreenCanvasRenderingContext2D).drawImage(bitmap, 0, 0)
    return [{ time: from, face: pickFace(await detectFaces(canvas), null) }]
  }
  const input = new Input({ formats: ALL_FORMATS, source: inputSource(media) })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) return []
    const first = Math.max(0, await input.getFirstTimestamp())
    const height = Math.round((ANALYSIS_WIDTH * track.displayHeight) / Math.max(1, track.displayWidth))
    const sink = new CanvasSink(track, { width: ANALYSIS_WIDTH, height, fit: 'fill' })
    const count = Math.max(1, Math.ceil(duration * SAMPLES_PER_SECOND))
    const times = Array.from({ length: count }, (_, i) => from + Math.min(duration, i / SAMPLES_PER_SECOND))
    const out: FaceSample[] = []
    let previous: Face | null = null
    let i = 0
    for await (const wrapped of sink.canvasesAtTimestamps(times.map((t) => first + t))) {
      if (isCancelled()) throw new Error('cancelled')
      const time = times[i++]
      const face: Face | null = wrapped ? pickFace(await detectFaces(wrapped.canvas), previous) : null
      if (face) previous = face
      out.push({ time, face })
      onProgress(i / count)
    }
    return out
  } finally {
    input.dispose()
  }
}

function gaussianSmooth(values: number[], sigma: number): number[] {
  if (sigma <= 0.01) return values
  const radius = Math.ceil(sigma * 3)
  return values.map((_, i) => {
    let sum = 0
    let weight = 0
    for (let k = -radius; k <= radius; k++) {
      const j = Math.min(values.length - 1, Math.max(0, i + k))
      const w = Math.exp((-k * k) / (2 * sigma * sigma))
      sum += values[j] * w
      weight += w
    }
    return sum / weight
  })
}

function median(values: number[], radius: number): number[] {
  return values.map((_, i) => {
    const window = values.slice(Math.max(0, i - radius), i + radius + 1).sort((a, b) => a - b)
    return window[Math.floor(window.length / 2)]
  })
}

/** Ramer-Douglas-Peucker on (time, x, y): keeps the keyframes that shape the path. */
function simplify(points: { t: number; x: number; y: number }[], epsilon: number): typeof points {
  if (points.length <= 2) return points
  const a = points[0]
  const b = points[points.length - 1]
  let worst = -1
  let index = 0
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]
    const f = (p.t - a.t) / Math.max(1e-9, b.t - a.t)
    const d = Math.hypot(p.x - (a.x + (b.x - a.x) * f), p.y - (a.y + (b.y - a.y) * f))
    if (d > worst) {
      worst = d
      index = i
    }
  }
  if (worst <= epsilon) return [a, b]
  return [...simplify(points.slice(0, index + 1), epsilon).slice(0, -1), ...simplify(points.slice(index), epsilon)]
}

/** Pan/Crop keyframes that keep the face in frame. Null when no face was found. */
export function reframeKeys(samples: FaceSample[], media: MediaItem, settings: ProjectSettings, o: ReframeOptions): PanCropKey[] | null {
  const found = samples.filter((s) => s.face)
  if (found.length === 0 || !media.width || !media.height) return null
  const zoom = fillZoom(media.width, media.height, settings.width, settings.height) * Math.max(1, o.zoom)
  const fit = fitFrame(media.width, media.height, settings.width, settings.height)
  const halfW = Math.min(0.5, fit.w / zoom / media.width / 2)
  const halfH = Math.min(0.5, fit.h / zoom / media.height / 2)
  // The face sits a little above the center of the frame (headroom).
  const place = (f: Face): { x: number; y: number } => ({
    x: Math.min(1 - halfW, Math.max(halfW, f.cx)),
    y: Math.min(1 - halfH, Math.max(halfH, f.cy + halfH * 0.2))
  })
  const key = (time: number, x: number, y: number, ease: PanCropKey['ease']): PanCropKey => ({
    time: secondsToFlicks(time),
    cx: x,
    cy: y,
    zoom,
    rotation: 0,
    ease
  })
  if (o.mode === 'static' || samples.length < 3) {
    const xs = found.map((s) => place(s.face as Face).x).sort((a, b) => a - b)
    const ys = found.map((s) => place(s.face as Face).y).sort((a, b) => a - b)
    return [key(samples[0].time, xs[Math.floor(xs.length / 2)], ys[Math.floor(ys.length / 2)], 'smooth')]
  }
  // Gaps (no face) hold the nearest known position.
  let last = place(found[0].face as Face)
  const raw = samples.map((s) => (s.face ? (last = place(s.face)) : last))
  const sigma = (0.25 + o.smoothness * 1.75) * SAMPLES_PER_SECOND
  const xs = gaussianSmooth(median(raw.map((p) => p.x), 2), sigma)
  const ys = gaussianSmooth(median(raw.map((p) => p.y), 2), sigma)
  const path = simplify(
    samples.map((s, i) => ({ t: s.time, x: xs[i], y: ys[i] })),
    0.004
  )
  return path.map((p) => key(p.t, p.x, p.y, 'linear'))
}

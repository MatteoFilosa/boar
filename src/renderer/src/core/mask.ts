import type { Flicks } from './time'
import { type PanCropState, fitFrame, sourceToOutput } from './pancrop'

/** A point of a custom mask, as fractions of the source picture (x, y). */
export type MaskPoint = [number, number]

/**
 * The custom shape at a source time. Every keyframe of a mask has the same
 * number of points, so the shape morphs point by point between keyframes.
 */
export interface MaskPathKey {
  time: Flicks
  points: MaskPoint[]
}

/** Points picked with Smart Select on one frame: the AI cuts out what they touch. */
export interface SmartSeeds {
  /** Source time of the frame they were picked on. */
  time: Flicks
  include: MaskPoint[]
  exclude: MaskPoint[]
}

/**
 * Shape mask on a video event. Outside the shape the event is transparent, so
 * lower tracks show through (or the inside, when inverted).
 *
 * Ellipse and rectangle are fractions of the source picture when `space` is
 * 'picture' (they move, zoom and turn with Event Pan/Crop, so a masked image
 * can be moved around whole), or of the output frame when it is 'frame' (a
 * fixed window the picture moves behind; masks saved before 0.7.4). A custom
 * shape is always drawn over the source picture (the frame itself for text
 * events) with keyframes in source time like Event Pan/Crop, so it stays on
 * its subject when the framing changes and trimming or splitting never
 * touches it.
 */
export interface EventMask {
  shape: 'rectangle' | 'ellipse' | 'custom'
  /** Ellipse and rectangle: over the source picture or over the output frame. */
  space: 'picture' | 'frame'
  cx: number
  cy: number
  w: number
  h: number
  /** Edge softness in px for a 1080 px short side. */
  feather: number
  invert: boolean
  /** Custom shape keyframes, sorted by time. */
  path: MaskPathKey[]
  /** Custom shape: a smooth curve through the points instead of straight sides. */
  smooth: boolean
  smart: SmartSeeds | null
}

export const DEFAULT_MASK: EventMask = {
  shape: 'ellipse',
  space: 'picture',
  cx: 0.5,
  cy: 0.5,
  w: 0.6,
  h: 0.6,
  feather: 40,
  invert: false,
  path: [],
  smooth: true,
  smart: null
}

/** Fills fields added after a mask was saved (older ellipses and rectangles were over the frame). */
export const normalizeMask = (m: Partial<EventMask>): EventMask => ({
  ...DEFAULT_MASK,
  ...m,
  space: m.space ?? 'frame',
  path: m.path ?? [],
  smart: m.smart ?? null
})

// Ellipse and rectangle over the picture

/** Points around an ellipse or rectangle (fractions), for drawing it through Pan/Crop. */
export function shapeOutline(mask: EventMask): MaskPoint[] {
  const { cx, cy } = mask
  const rx = mask.w / 2
  const ry = mask.h / 2
  if (mask.shape === 'rectangle') {
    return [
      [cx - rx, cy - ry],
      [cx + rx, cy - ry],
      [cx + rx, cy + ry],
      [cx - rx, cy + ry]
    ]
  }
  return Array.from({ length: 72 }, (_, i): MaskPoint => {
    const a = (i / 72) * Math.PI * 2
    return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]
  })
}

/**
 * The same ellipse or rectangle on the other space, as it looks with this
 * framing (`state`): switching keeps the shape where it is on screen (exact
 * without rotation).
 */
export function convertMaskSpace(
  mask: EventMask,
  to: EventMask['space'],
  state: PanCropState,
  srcW: number,
  srcH: number,
  outW: number,
  outH: number
): EventMask {
  if (mask.space === to) return mask
  const { map, inverse } = sourceToOutput(state, srcW, srcH, outW, outH)
  // Output pixels per source pixel.
  const scale = (outW * state.zoom) / fitFrame(srcW, srcH, outW, outH).w
  if (to === 'picture') {
    const [x, y] = inverse(mask.cx * outW, mask.cy * outH)
    return { ...mask, space: to, cx: x / srcW, cy: y / srcH, w: (mask.w * outW) / scale / srcW, h: (mask.h * outH) / scale / srcH }
  }
  const [x, y] = map(mask.cx * srcW, mask.cy * srcH)
  return { ...mask, space: to, cx: x / outW, cy: y / outH, w: (mask.w * srcW * scale) / outW, h: (mask.h * srcH * scale) / outH }
}

// Custom shape keyframes

/** The custom shape at a source time (linear between keyframes). Returns fresh points. */
export function pathAt(keys: readonly MaskPathKey[], time: Flicks): MaskPoint[] {
  if (keys.length === 0) return []
  const copy = (k: MaskPathKey): MaskPoint[] => k.points.map(([x, y]) => [x, y])
  if (time <= keys[0].time) return copy(keys[0])
  const last = keys[keys.length - 1]
  if (time >= last.time) return copy(last)
  let i = 0
  while (i < keys.length - 2 && keys[i + 1].time <= time) i++
  const a = keys[i]
  const b = keys[i + 1]
  if (a.points.length !== b.points.length) return copy(a)
  const f = (time - a.time) / (b.time - a.time)
  return a.points.map(([x, y], j) => [x + (b.points[j][0] - x) * f, y + (b.points[j][1] - y) * f])
}

/** Inserts or replaces the keyframe at `time`, keeping keys sorted. */
export function upsertPathKey(keys: readonly MaskPathKey[], key: MaskPathKey): MaskPathKey[] {
  const out = keys.filter((k) => k.time !== key.time)
  out.push(key)
  out.sort((a, b) => a.time - b.time)
  return out
}

/**
 * Writes the shape at `time`: the only keyframe changes when there is one,
 * the keyframe within `tolerance` of `time` when there is one, otherwise a
 * keyframe is added there (like Event Pan/Crop).
 */
export function setShapeAt(keys: readonly MaskPathKey[], time: Flicks, points: MaskPoint[], tolerance = 0): MaskPathKey[] {
  if (keys.length === 0) return [{ time, points }]
  if (keys.length === 1) return [{ time: keys[0].time, points }]
  const near = keys.find((k) => Math.abs(k.time - time) < tolerance)
  return upsertPathKey(keys, { time: near ? near.time : time, points })
}

/**
 * Adds a point after index `after` in every keyframe: at `point` in the shape
 * at `time`, and at the same spot along that side in the other keyframes.
 */
export function insertPoint(keys: readonly MaskPathKey[], time: Flicks, after: number, point: MaskPoint, tolerance = 0): MaskPathKey[] {
  if (keys.length === 0) return [{ time, points: [point] }]
  const here = pathAt(keys, time)
  const n = here.length
  // Where the new point falls along the side, to place it alike in the other keyframes.
  let f = 0.5
  if (n >= 2) {
    const a = here[after % n]
    const b = here[(after + 1) % n]
    const len2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2
    if (len2 > 0) f = Math.min(1, Math.max(0, ((point[0] - a[0]) * (b[0] - a[0]) + (point[1] - a[1]) * (b[1] - a[1])) / len2))
  }
  const withPoint = (points: MaskPoint[], p: MaskPoint): MaskPoint[] => [...points.slice(0, after + 1), p, ...points.slice(after + 1)]
  const updated = keys.map((k) => {
    if (k.points.length !== n || n < 2) return { time: k.time, points: withPoint(k.points, point) }
    const a = k.points[after % n]
    const b = k.points[(after + 1) % n]
    return { time: k.time, points: withPoint(k.points, [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]) }
  })
  // The clicked spot is exact at the cursor.
  return setShapeAt(updated, time, withPoint(here, point), tolerance)
}

/** Removes point `index` from every keyframe. */
export function removePoint(keys: readonly MaskPathKey[], index: number): MaskPathKey[] {
  return keys.map((k) => ({ time: k.time, points: k.points.filter((_, i) => i !== index) }))
}

// Drawing

/** Adds a closed shape through the points to a context or a Path2D: straight sides, or a smooth curve (Catmull-Rom). */
export function tracePath(ctx: CanvasPath, points: readonly MaskPoint[], smooth: boolean): void {
  const n = points.length
  if (n === 0) return
  ctx.moveTo(points[0][0], points[0][1])
  if (!smooth || n < 3) {
    for (let i = 1; i < n; i++) ctx.lineTo(points[i][0], points[i][1])
    ctx.closePath()
    return
  }
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n]
    const p1 = points[i]
    const p2 = points[(i + 1) % n]
    const p3 = points[(i + 2) % n]
    ctx.bezierCurveTo(
      p1[0] + (p2[0] - p0[0]) / 6,
      p1[1] + (p2[1] - p0[1]) / 6,
      p2[0] - (p3[0] - p1[0]) / 6,
      p2[1] - (p3[1] - p1[1]) / 6,
      p2[0],
      p2[1]
    )
  }
  ctx.closePath()
}

const cache = new Map<string, OffscreenCanvas>()

/**
 * White-on-transparent alpha mask, cached per parameters and size. A custom
 * shape, and an ellipse or rectangle over the picture, need their outline
 * already placed in the output frame (pixels).
 */
export function maskCanvas(mask: EventMask, width: number, height: number, outputPoints: readonly MaskPoint[] = []): OffscreenCanvas {
  const custom = mask.shape === 'custom' || (mask.space === 'picture' && outputPoints.length > 0)
  const smooth = mask.shape === 'custom' && mask.smooth
  const shapeKey = custom
    ? `${smooth}:${outputPoints.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(';')}`
    : `${mask.cx}:${mask.cy}:${mask.w}:${mask.h}`
  const key = `${width}x${height}:${mask.shape}:${shapeKey}:${mask.feather}:${mask.invert}`
  const hit = cache.get(key)
  if (hit) return hit
  if (cache.size > 32) cache.clear()
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const scale = Math.min(width, height) / 1080
  const blur = mask.feather * scale
  const shape = (): void => {
    ctx.beginPath()
    if (custom) {
      tracePath(ctx, outputPoints, smooth)
      return
    }
    const x = mask.cx * width
    const y = mask.cy * height
    const w = (mask.w * width) / 2
    const h = (mask.h * height) / 2
    if (mask.shape === 'ellipse') ctx.ellipse(x, y, Math.max(1, w), Math.max(1, h), 0, 0, Math.PI * 2)
    else ctx.rect(x - w, y - h, w * 2, h * 2)
  }
  ctx.fillStyle = '#fff'
  if (blur > 0) ctx.filter = `blur(${blur}px)`
  if (mask.invert) {
    // Fill a slightly larger area so the blur does not darken the frame edges.
    ctx.fillRect(-blur * 3, -blur * 3, width + blur * 6, height + blur * 6)
    ctx.globalCompositeOperation = 'destination-out'
  }
  // A custom shape with fewer than 3 points cuts nothing out yet.
  if (custom && outputPoints.length < 3) {
    if (!mask.invert) ctx.fillRect(0, 0, width, height)
  } else {
    shape()
    ctx.fill()
  }
  cache.set(key, canvas)
  return canvas
}

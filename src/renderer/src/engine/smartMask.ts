import { ALL_FORMATS, CanvasSink, Input } from 'mediabunny'
import { FLICKS_PER_SECOND, type Flicks, secondsToFlicks } from '../core/time'
import type { MediaItem, TimelineEvent } from '../core/types'
import type { MaskPathKey, MaskPoint, SmartSeeds } from '../core/mask'
import { inputSource } from '../media/source'
import { imageCache } from '../media/cache'
import { type ObjectMask, type ObjectSegmenter, objectSegmenter } from './vision'

// Smart Select: MagicTouch cuts out the object under the picked points and the
// outline becomes the custom mask shape. Tracking repeats it through the
// event, moving the points along with the object, and keeps the keyframes the
// motion needs. Everything runs locally.

const ANALYSIS_WIDTH = 640
/** Frames analysed per second of source when tracking (GPU / CPU). */
const RATE_GPU = 15
const RATE_CPU = 6
/** Keyframes closer than this (analysis pixels) to the in-between shape are dropped. */
const KEY_TOLERANCE = 1.5

type Pt = [number, number]

interface Region {
  inside: Uint8Array
  area: number
  cx: number
  cy: number
}

interface Frame {
  image: TexImageSource
  width: number
  height: number
}

// Regions

/** Labels the 4-connected regions of `bin` (0 = outside); sizes[label] is the pixel count. */
function label(bin: Uint8Array, w: number): { labels: Int32Array; sizes: number[] } {
  const n = bin.length
  const labels = new Int32Array(n)
  const sizes = [0]
  const stack = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    if (!bin[i] || labels[i]) continue
    const id = sizes.length
    let top = 0
    let size = 0
    stack[top++] = i
    labels[i] = id
    while (top > 0) {
      const p = stack[--top]
      size++
      const x = p % w
      const visit = (q: number): void => {
        if (bin[q] && !labels[q]) {
          labels[q] = id
          stack[top++] = q
        }
      }
      if (x > 0) visit(p - 1)
      if (x < w - 1) visit(p + 1)
      if (p >= w) visit(p - w)
      if (p + w < n) visit(p + w)
    }
    sizes.push(size)
  }
  return { labels, sizes }
}

function regionOf(labels: Int32Array, id: number, w: number): Region {
  const inside = new Uint8Array(labels.length)
  let area = 0
  let sx = 0
  let sy = 0
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] !== id) continue
    inside[i] = 1
    area++
    sx += i % w
    sy += Math.floor(i / w)
  }
  return { inside, area, cx: sx / Math.max(1, area), cy: sy / Math.max(1, area) }
}

const indexOf = (p: Pt, w: number, h: number): number =>
  Math.min(h - 1, Math.max(0, Math.round(p[1]))) * w + Math.min(w - 1, Math.max(0, Math.round(p[0])))

/** Of the labels touched by `points`, the biggest; the biggest overall when none is touched. */
function pickLabel(labels: Int32Array, sizes: number[], points: Pt[], w: number, h: number): number {
  let best = 0
  for (const p of points) {
    const id = labels[indexOf(p, w, h)]
    if (id && (!best || sizes[id] > sizes[best])) best = id
  }
  if (best) return best
  for (let id = 1; id < sizes.length; id++) if (!best || sizes[id] > sizes[best]) best = id
  return best
}

/** The confident part of the object mask that holds `p` (or its biggest part), at the frame's size. */
function regionAt(mask: ObjectMask, p: Pt, w: number, h: number): Region | null {
  const bin = new Uint8Array(w * h)
  const sameSize = mask.width === w && mask.height === h
  for (let y = 0, i = 0; y < h; y++) {
    const row = sameSize ? y : Math.min(mask.height - 1, Math.floor((y * mask.height) / h))
    for (let x = 0; x < w; x++, i++) {
      const col = sameSize ? x : Math.min(mask.width - 1, Math.floor((x * mask.width) / w))
      bin[i] = mask.data[row * mask.width + col] > 0.5 ? 1 : 0
    }
  }
  const { labels, sizes } = label(bin, w)
  const id = pickLabel(labels, sizes, [p], w, h)
  return id ? regionOf(labels, id, w) : null
}

/** Distance of every inside pixel to the outside (chamfer 3-4, in pixels). */
function depthMap(inside: Uint8Array, w: number, h: number): Float32Array {
  const big = 1e9
  const d = new Float32Array(inside.length)
  for (let i = 0; i < d.length; i++) d[i] = inside[i] ? big : 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!d[i]) continue
      let v = d[i]
      if (x > 0) v = Math.min(v, d[i - 1] + 3)
      if (y > 0) {
        v = Math.min(v, d[i - w] + 3)
        if (x > 0) v = Math.min(v, d[i - w - 1] + 4)
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + 4)
      }
      // The frame border counts as outside.
      if (x === 0 || y === 0) v = Math.min(v, 3)
      d[i] = v
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x
      if (!d[i]) continue
      let v = d[i]
      if (x < w - 1) v = Math.min(v, d[i + 1] + 3)
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + 3)
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + 4)
        if (x > 0) v = Math.min(v, d[i + w - 1] + 4)
      }
      if (x === w - 1 || y === h - 1) v = Math.min(v, 3)
      d[i] = v
    }
  }
  for (let i = 0; i < d.length; i++) d[i] /= 3
  return d
}

// Outline

const DIRS: Pt[] = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1]
]

/** Outer boundary of a region, clockwise on screen (Moore neighbour tracing). */
function traceOutline(inside: Uint8Array, w: number, h: number): Pt[] {
  const start = inside.indexOf(1)
  if (start < 0) return []
  const sx = start % w
  const sy = (start - sx) / w
  const at = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h && inside[y * w + x] === 1
  const out: Pt[] = []
  let x = sx
  let y = sy
  // The start is the first inside pixel in reading order: its west neighbour is outside.
  let back = 4
  let first = -1
  for (let guard = 0; guard < inside.length * 2; guard++) {
    let found = -1
    for (let k = 1; k <= 8; k++) {
      const d = (back + k) % 8
      if (at(x + DIRS[d][0], y + DIRS[d][1])) {
        found = d
        break
      }
    }
    if (found < 0) return [[x, y]]
    if (guard > 0 && x === sx && y === sy && found === first) break
    if (guard === 0) first = found
    out.push([x, y])
    x += DIRS[found][0]
    y += DIRS[found][1]
    // The last outside neighbour looked at, seen from the new pixel.
    back = (found + (found % 2 === 0 ? 6 : 5)) % 8
  }
  return out
}

function smoothClosed(points: Pt[], radius: number): Pt[] {
  const n = points.length
  if (n < radius * 2 + 3) return points
  return points.map((_, i) => {
    let x = 0
    let y = 0
    for (let k = -radius; k <= radius; k++) {
      const p = points[(i + k + n) % n]
      x += p[0]
      y += p[1]
    }
    return [x / (radius * 2 + 1), y / (radius * 2 + 1)]
  })
}

/** `count` points evenly spaced along a closed polyline. */
function resampleClosed(points: Pt[], count: number): Pt[] {
  const m = points.length
  if (m === 0) return []
  const cum = new Float64Array(m + 1)
  for (let i = 0; i < m; i++) {
    const a = points[i]
    const b = points[(i + 1) % m]
    cum[i + 1] = cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1])
  }
  const total = cum[m]
  if (total <= 0) return [points[0]]
  const out: Pt[] = []
  let j = 0
  for (let k = 0; k < count; k++) {
    const target = (k * total) / count
    while (j < m - 1 && cum[j + 1] < target) j++
    const span = cum[j + 1] - cum[j]
    const f = span > 0 ? (target - cum[j]) / span : 0
    const a = points[j]
    const b = points[(j + 1) % m]
    out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f])
  }
  return out
}

function perimeter(points: Pt[]): number {
  let total = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    total += Math.hypot(b[0] - a[0], b[1] - a[1])
  }
  return total
}

/** Point count for an outline: about one every 10 analysis pixels. */
const pointCount = (outline: Pt[]): number => Math.min(80, Math.max(24, Math.round(perimeter(outline) / 10)))

/** Rotates the point order so each point lines up with the same point of `previous`. */
function align(points: Pt[], previous: Pt[]): Pt[] {
  const n = points.length
  if (n !== previous.length || n === 0) return points
  let best = 0
  let bestCost = Infinity
  for (let s = 0; s < n; s++) {
    let cost = 0
    for (let i = 0; i < n && cost < bestCost; i++) {
      const p = points[(i + s) % n]
      cost += (p[0] - previous[i][0]) ** 2 + (p[1] - previous[i][1]) ** 2
    }
    if (cost < bestCost) {
      bestCost = cost
      best = s
    }
  }
  return points.map((_, i) => points[(i + best) % n])
}

/** The region's outline with `count` points (or a count picked from its size). */
function outlineOf(inside: Uint8Array, w: number, h: number, count?: number): Pt[] {
  const traced = smoothClosed(traceOutline(inside, w, h), 2)
  if (traced.length < 3) return []
  return resampleClosed(traced, count ?? pointCount(traced))
}

// Cutting out

interface SeedState {
  include: boolean
  pos: Pt
  velocity: Pt
  centroid: Pt | null
  area: number
  /** Deepest point of the last region (a safe place to retry from). */
  deep: Pt | null
}

const toPixels = (p: MaskPoint, w: number, h: number): Pt => [p[0] * w, p[1] * h]

/** Segments the object under one seed, with a retry from inside the last region when the result looks wrong. */
function followSeed(segmenter: ObjectSegmenter, frame: Frame, seed: SeedState): Region | null {
  const { width: w, height: h } = frame
  const clamp = (p: Pt): Pt => [Math.min(w - 1, Math.max(0, p[0])), Math.min(h - 1, Math.max(0, p[1]))]
  const tryAt = (p: Pt): { region: Region | null; at: Pt } => {
    const at = clamp(p)
    const mask = segmenter.segment(frame.image, (at[0] + 0.5) / w, (at[1] + 0.5) / h)
    return { region: mask ? regionAt(mask, at, w, h) : null, at }
  }
  const badness = (r: Region | null): number => (!r ? Infinity : seed.area > 0 ? Math.abs(Math.log(r.area / seed.area)) : 0)
  let best = tryAt([seed.pos[0] + seed.velocity[0], seed.pos[1] + seed.velocity[1]])
  // More than about twice as big or small as the last frame: probably the background or a neighbour.
  if (badness(best.region) > 0.9 && seed.deep) {
    const retry = tryAt([seed.deep[0] + seed.velocity[0], seed.deep[1] + seed.velocity[1]])
    if (badness(retry.region) < badness(best.region)) best = retry
  }
  const region = best.region
  if (!region || region.area === 0) return null
  const depth = depthMap(region.inside, w, h)
  let deepest = 0
  for (let i = 1; i < depth.length; i++) if (depth[i] > depth[deepest]) deepest = i
  const deep: Pt = [deepest % w, Math.floor(deepest / w)]
  if (seed.centroid) seed.velocity = [region.cx - seed.centroid[0], region.cy - seed.centroid[1]]
  seed.centroid = [region.cx, region.cy]
  seed.area = region.area
  seed.deep = deep
  // Keep the point on the object, away from its edge.
  seed.pos = depth[indexOf(best.at, w, h)] < depth[deepest] * 0.25 ? deep : best.at
  return region
}

/** What the include seeds touch minus what the exclude seeds touch: the part holding an include seed. */
function cutOut(segmenter: ObjectSegmenter, frame: Frame, seeds: SeedState[]): Uint8Array | null {
  const { width: w, height: h } = frame
  const union = new Uint8Array(w * h)
  let any = false
  for (const seed of seeds.filter((s) => s.include)) {
    const region = followSeed(segmenter, frame, seed)
    if (!region) continue
    any = true
    for (let i = 0; i < union.length; i++) union[i] |= region.inside[i]
  }
  if (!any) return null
  for (const seed of seeds.filter((s) => !s.include)) {
    const region = followSeed(segmenter, frame, seed)
    if (region) for (let i = 0; i < union.length; i++) if (region.inside[i]) union[i] = 0
  }
  const { labels, sizes } = label(union, w)
  const id = pickLabel(labels, sizes, seeds.filter((s) => s.include).map((s) => s.pos), w, h)
  return id ? regionOf(labels, id, w).inside : null
}

function seedStates(seeds: SmartSeeds, w: number, h: number): SeedState[] {
  const make = (p: MaskPoint, include: boolean): SeedState => ({
    include,
    pos: toPixels(p, w, h),
    velocity: [0, 0],
    centroid: null,
    area: 0,
    deep: null
  })
  return [...seeds.include.map((p) => make(p, true)), ...seeds.exclude.map((p) => make(p, false))]
}

const toFractions = (points: Pt[], w: number, h: number): MaskPoint[] =>
  points.map(([x, y]) => [Math.round(((x + 0.5) / w) * 1e5) / 1e5, Math.round(((y + 0.5) / h) * 1e5) / 1e5])

// Frames

function analysisSize(width: number, height: number): { width: number; height: number } {
  const w = Math.min(ANALYSIS_WIDTH, width)
  return { width: w, height: Math.max(1, Math.round((w * height) / Math.max(1, width))) }
}

function imageFrame(media: MediaItem): Frame | null {
  const bitmap = imageCache.get(media.id)
  if (!bitmap) return null
  const size = analysisSize(bitmap.width, bitmap.height)
  const canvas = new OffscreenCanvas(size.width, size.height)
  ;(canvas.getContext('2d') as OffscreenCanvasRenderingContext2D).drawImage(bitmap, 0, 0, size.width, size.height)
  return { image: canvas, ...size }
}

let lastFrame: { key: string; frame: Frame } | null = null

/** The source picture at a source time, at analysis size (the last one is kept for repeated clicks). */
async function frameAt(media: MediaItem, time: Flicks): Promise<Frame | null> {
  const key = `${media.id}:${media.kind === 'image' ? 0 : time}`
  if (lastFrame?.key === key) return lastFrame.frame
  let frame: Frame | null = null
  if (media.kind === 'image') frame = imageFrame(media)
  else {
    const input = new Input({ formats: ALL_FORMATS, source: inputSource(media) })
    try {
      const track = await input.getPrimaryVideoTrack()
      if (!track) return null
      const first = Math.max(0, await input.getFirstTimestamp())
      const size = analysisSize(track.displayWidth, track.displayHeight)
      const sink = new CanvasSink(track, { ...size, fit: 'fill' })
      const wrapped = await sink.getCanvas(first + time / FLICKS_PER_SECOND)
      if (wrapped) {
        const canvas = new OffscreenCanvas(size.width, size.height)
        ;(canvas.getContext('2d') as OffscreenCanvasRenderingContext2D).drawImage(wrapped.canvas, 0, 0)
        frame = { image: canvas, ...size }
      }
    } finally {
      input.dispose()
    }
  }
  if (frame) lastFrame = { key, frame }
  return frame
}

// Public

/** The outline of what the seeds pick on their frame, as custom mask points (null: nothing found). */
export async function smartOutline(media: MediaItem, seeds: SmartSeeds): Promise<MaskPoint[] | null> {
  if (seeds.include.length === 0) return null
  const [segmenter, frame] = await Promise.all([objectSegmenter(), frameAt(media, seeds.time)])
  if (!frame) return null
  const inside = cutOut(segmenter, frame, seedStates(seeds, frame.width, frame.height))
  if (!inside) return null
  const outline = outlineOf(inside, frame.width, frame.height)
  return outline.length >= 3 ? toFractions(outline, frame.width, frame.height) : null
}

/** Ramer-Douglas-Peucker over time: keeps the keyframes the motion needs. */
function reduceKeys(keys: { t: number; points: Pt[] }[], tolerance: number): typeof keys {
  if (keys.length <= 2) return keys
  const a = keys[0]
  const b = keys[keys.length - 1]
  let worst = -1
  let index = 0
  for (let i = 1; i < keys.length - 1; i++) {
    const f = (keys[i].t - a.t) / Math.max(1e-9, b.t - a.t)
    let d = 0
    keys[i].points.forEach((p, j) => {
      const x = a.points[j][0] + (b.points[j][0] - a.points[j][0]) * f
      const y = a.points[j][1] + (b.points[j][1] - a.points[j][1]) * f
      d = Math.max(d, Math.hypot(p[0] - x, p[1] - y))
    })
    if (d > worst) {
      worst = d
      index = i
    }
  }
  if (worst <= tolerance) return [a, b]
  return [...reduceKeys(keys.slice(0, index + 1), tolerance).slice(0, -1), ...reduceKeys(keys.slice(index), tolerance)]
}

/**
 * Follows what the seeds pick through the whole event (forward and backward
 * from their frame) and returns the custom mask keyframes.
 */
export async function trackOutline(
  event: TimelineEvent,
  media: MediaItem,
  seeds: SmartSeeds,
  onProgress: (fraction: number) => void,
  isCancelled: () => boolean
): Promise<MaskPathKey[]> {
  if (seeds.include.length === 0) return []
  const segmenter = await objectSegmenter()
  if (media.kind === 'image') {
    const outline = await smartOutline(media, seeds)
    return outline ? [{ time: event.offset, points: outline }] : []
  }
  const from = event.offset / FLICKS_PER_SECOND
  const to = (event.offset + event.length * event.rate) / FLICKS_PER_SECOND
  const seedTime = seeds.time / FLICKS_PER_SECOND
  // After a split the points may belong to a frame of the other part.
  if (seedTime < from - 1e-6 || seedTime > to + 1e-6) throw new Error('pick the object again on a frame of this event')
  const step = 1 / (segmenter.gpu ? RATE_GPU : RATE_CPU)
  const forward: number[] = []
  for (let t = seedTime; t < to - 1e-6; t += step) forward.push(t)
  const backward: number[] = []
  for (let t = seedTime - step; t >= from - 1e-6; t -= step) backward.push(Math.max(from, t))
  const total = forward.length + backward.length

  const input = new Input({ formats: ALL_FORMATS, source: inputSource(media) })
  const results = new Map<number, Pt[]>()
  let size = { width: 1, height: 1 }
  let done = 0
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) return []
    const first = Math.max(0, await input.getFirstTimestamp())
    size = analysisSize(track.displayWidth, track.displayHeight)
    const sink = new CanvasSink(track, { ...size, fit: 'fill' })
    let count = 0
    let seedOutline: Pt[] = []

    /** One frame: cut out, outline, line the points up with the previous frame. */
    const process = (image: TexImageSource, t: number, states: SeedState[], previous: Pt[]): Pt[] => {
      const inside = cutOut(segmenter, { image, ...size }, states)
      let outline = previous
      if (inside) {
        const traced = outlineOf(inside, size.width, size.height, count || undefined)
        if (traced.length >= 3) {
          count = traced.length
          outline = previous.length ? align(traced, previous) : traced
          results.set(t, outline)
        }
      }
      onProgress(++done / total)
      return outline
    }

    // Forward from the seed frame.
    let states = seedStates(seeds, size.width, size.height)
    let previous: Pt[] = []
    let i = 0
    for await (const wrapped of sink.canvasesAtTimestamps(forward.map((t) => first + t))) {
      if (isCancelled()) throw new Error('cancelled')
      const t = forward[i++]
      previous = wrapped ? process(wrapped.canvas, t, states, previous) : previous
      if (t === seedTime) seedOutline = previous
    }
    // Backward, a second at a time: decoded in order, analysed from the latest.
    states = seedStates(seeds, size.width, size.height)
    previous = seedOutline
    const chunk = Math.max(1, Math.round(1 / step))
    for (let c = 0; c < backward.length; c += chunk) {
      const times = backward.slice(c, c + chunk).reverse()
      const frames: (ImageBitmap | null)[] = []
      for await (const wrapped of sink.canvasesAtTimestamps(times.map((t) => first + t))) {
        if (isCancelled()) throw new Error('cancelled')
        frames.push(wrapped ? await createImageBitmap(wrapped.canvas) : null)
      }
      for (let k = frames.length - 1; k >= 0; k--) {
        const bitmap = frames[k]
        if (!bitmap) continue
        if (isCancelled()) throw new Error('cancelled')
        previous = process(bitmap, times[k], states, previous)
        bitmap.close()
      }
    }
  } finally {
    input.dispose()
  }

  // Calm the edge flicker a little, then keep only the keyframes the motion needs.
  const sorted = [...results.entries()].sort((a, b) => a[0] - b[0]).map(([t, points]) => ({ t, points }))
  const smoothed = sorted.map((k, i) => {
    const a = sorted[i - 1]
    const b = sorted[i + 1]
    if (!a || !b || a.points.length !== k.points.length || b.points.length !== k.points.length) return k
    return { t: k.t, points: k.points.map((p, j): Pt => [(a.points[j][0] + p[0] * 2 + b.points[j][0]) / 4, (a.points[j][1] + p[1] * 2 + b.points[j][1]) / 4]) }
  })
  return reduceKeys(smoothed, KEY_TOLERANCE).map((k) => ({ time: secondsToFlicks(k.t), points: toFractions(k.points, size.width, size.height) }))
}

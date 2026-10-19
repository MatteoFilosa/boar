import type { Flicks } from './time'

/**
 * Event Pan/Crop. A keyframe describes the "frame" rectangle laid over the
 * source media: what is inside it fills the output frame. The rectangle always
 * has the project aspect ratio.
 *
 * - cx, cy: center of the rectangle, as a fraction of source width/height
 * - zoom: 1 = whole source fits inside the output (the default, black bars);
 *   higher values crop in
 * - rotation: degrees, clockwise rotation of the rectangle
 * - stretch: width of the picture against its height (1 = its own
 *   proportions, 2 = twice as wide). Everything else works on the stretched
 *   picture, as if the source were `stretch` times as wide: the frame
 *   rectangle lies over it (so it stays a rectangle when it turns), zoom 1
 *   fits it, and cx/cy stay fractions of the picture.
 *
 * Keyframe times are *source* times, so trimming and splitting an event never
 * needs to touch its keyframes.
 */
export type Ease = 'smooth' | 'linear' | 'hold'

export interface PanCropState {
  cx: number
  cy: number
  zoom: number
  rotation: number
  stretch: number
}

export interface PanCropKey extends PanCropState {
  time: Flicks
  /** Interpolation from this keyframe to the next. */
  ease: Ease
}

export const DEFAULT_PANCROP: PanCropState = { cx: 0.5, cy: 0.5, zoom: 1, rotation: 0, stretch: 1 }

/** Stretch range of the preview handles, the Pan/Crop window and the agent tools. */
export const MIN_STRETCH = 0.02
export const MAX_STRETCH = 50
export const clampStretch = (v: number): number => Math.min(MAX_STRETCH, Math.max(MIN_STRETCH, v))

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

const stateOf = (k: PanCropState): PanCropState => ({ cx: k.cx, cy: k.cy, zoom: k.zoom, rotation: k.rotation, stretch: k.stretch })
const logLerp = (a: number, b: number, t: number): number => Math.exp(lerp(Math.log(a), Math.log(b), t))

/** Interpolated framing at a source time. Always returns a fresh object (never a keyframe). */
export function panCropAt(keys: readonly PanCropKey[] | undefined, sourceTime: Flicks): PanCropState {
  if (!keys || keys.length === 0) return { ...DEFAULT_PANCROP }
  if (sourceTime <= keys[0].time) return stateOf(keys[0])
  const last = keys[keys.length - 1]
  if (sourceTime >= last.time) return stateOf(last)
  let i = 0
  while (i < keys.length - 2 && keys[i + 1].time <= sourceTime) i++
  const a = keys[i]
  const b = keys[i + 1]
  if (a.ease === 'hold') return stateOf(a)
  let t = (sourceTime - a.time) / (b.time - a.time)
  if (a.ease === 'smooth') t = t * t * (3 - 2 * t)
  return {
    cx: lerp(a.cx, b.cx, t),
    cy: lerp(a.cy, b.cy, t),
    zoom: logLerp(a.zoom, b.zoom, t),
    rotation: lerp(a.rotation, b.rotation, t),
    stretch: logLerp(a.stretch, b.stretch, t)
  }
}

/** Size, in source pixels, of the frame rectangle at zoom 1 (source fully visible). */
export function fitFrame(srcW: number, srcH: number, outW: number, outH: number): { w: number; h: number } {
  const outAspect = outW / outH
  if (srcW / srcH > outAspect) return { w: srcW, h: srcW / outAspect }
  return { w: srcH * outAspect, h: srcH }
}

/** Zoom at which the source covers the whole output (no black bars). */
export function fillZoom(srcW: number, srcH: number, outW: number, outH: number): number {
  const a = srcW / srcH
  const b = outW / outH
  return Math.max(a / b, b / a)
}

/** Frame rectangle for a state, in pixels of the stretched picture (srcW × stretch wide, srcH high). */
export function frameRect(
  state: PanCropState,
  srcW: number,
  srcH: number,
  outW: number,
  outH: number
): { cx: number; cy: number; w: number; h: number; rotation: number } {
  const vw = srcW * state.stretch
  const fit = fitFrame(vw, srcH, outW, outH)
  return { cx: state.cx * vw, cy: state.cy * srcH, w: fit.w / state.zoom, h: fit.h / state.zoom, rotation: state.rotation }
}

/**
 * Where the source center lands in the output (pixels), its displayed scale
 * (output px per source px vertically; horizontally it is times `stretch`) and
 * its displayed size.
 */
export function sourcePlacement(
  state: PanCropState,
  srcW: number,
  srcH: number,
  outW: number,
  outH: number
): { x: number; y: number; scale: number; w: number; h: number } {
  const vw = srcW * state.stretch
  const scale = (outW * state.zoom) / fitFrame(vw, srcH, outW, outH).w
  const a = (-state.rotation * Math.PI) / 180
  // Source center relative to the output center, before and after the frame rotation.
  const vx = (0.5 - state.cx) * vw * scale
  const vy = (0.5 - state.cy) * srcH * scale
  return {
    x: outW / 2 + vx * Math.cos(a) - vy * Math.sin(a),
    y: outH / 2 + vx * Math.sin(a) + vy * Math.cos(a),
    scale,
    w: vw * scale,
    h: srcH * scale
  }
}

/** Maps source pixels to output pixels through a state (and back with `inverse`). */
export function sourceToOutput(
  state: PanCropState,
  srcW: number,
  srcH: number,
  outW: number,
  outH: number
): { map: (x: number, y: number) => [number, number]; inverse: (x: number, y: number) => [number, number] } {
  const st = state.stretch
  const scale = (outW * state.zoom) / fitFrame(srcW * st, srcH, outW, outH).w
  const a = (-state.rotation * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const fx = state.cx * srcW
  const fy = state.cy * srcH
  return {
    map: (x, y) => {
      const dx = (x - fx) * st * scale
      const dy = (y - fy) * scale
      return [outW / 2 + dx * cos - dy * sin, outH / 2 + dx * sin + dy * cos]
    },
    inverse: (x, y) => {
      const dx = x - outW / 2
      const dy = y - outH / 2
      return [fx + (dx * cos + dy * sin) / scale / st, fy + (-dx * sin + dy * cos) / scale]
    }
  }
}

/** State that puts the source center at (x, y) in the output with the given zoom, rotation and stretch. */
export function placeSource(
  x: number,
  y: number,
  zoom: number,
  rotation: number,
  srcW: number,
  srcH: number,
  outW: number,
  outH: number,
  stretch: number
): PanCropState {
  const vw = srcW * stretch
  const scale = (outW * zoom) / fitFrame(vw, srcH, outW, outH).w
  const a = (-rotation * Math.PI) / 180
  const dx = x - outW / 2
  const dy = y - outH / 2
  const vx = dx * Math.cos(a) + dy * Math.sin(a)
  const vy = -dx * Math.sin(a) + dy * Math.cos(a)
  return { cx: 0.5 - vx / (vw * scale), cy: 0.5 - vy / (srcH * scale), zoom, rotation, stretch }
}

/**
 * State that shows the whole source as a w × h box (output pixels, along the
 * picture's own sides) centered at (x, y): the picture stretched to any proportions.
 */
export function placeBox(
  x: number,
  y: number,
  w: number,
  h: number,
  rotation: number,
  srcW: number,
  srcH: number,
  outW: number,
  outH: number
): PanCropState {
  const stretch = clampStretch(w / srcW / (h / srcH))
  const scale = h / srcH
  const zoom = (scale * fitFrame(srcW * stretch, srcH, outW, outH).w) / outW
  return placeSource(x, y, zoom, rotation, srcW, srcH, outW, outH, stretch)
}

/** A picture's box on screen: center and size in output pixels, angle in radians (clockwise). */
export interface PictureBox {
  cx: number
  cy: number
  w: number
  h: number
  angle: number
}

/** A stretch this close to the picture's own proportions snaps to them. */
const SNAP_STRETCH = 0.03
/** Smallest stretched side, in output pixels. */
const MIN_SIDE = 4

/**
 * The box with the sides named by `handle` ('e', 'nw'…) moved by the pointer
 * offset (dx, dy) and the opposite sides kept in place, measured along the
 * box's own axes. 'snap': near the source's own proportions (src) it snaps to
 * them; 'keep': a corner keeps the box's proportions; 'free': neither.
 */
export function stretchBox(
  b0: PictureBox,
  handle: string,
  dx: number,
  dy: number,
  src: { w: number; h: number },
  mode: 'snap' | 'keep' | 'free'
): PictureBox & { snapped: boolean } {
  const cos = Math.cos(b0.angle)
  const sin = Math.sin(b0.angle)
  const lx = dx * cos + dy * sin
  const ly = -dx * sin + dy * cos
  const sx = handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0
  const sy = handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0
  let w = sx ? Math.max(MIN_SIDE, b0.w + sx * lx) : b0.w
  let h = sy ? Math.max(MIN_SIDE, b0.h + sy * ly) : b0.h
  if (mode === 'keep' && sx && sy) {
    // The pointer projected on the diagonal: both sides grow by the same factor.
    const k = ((b0.w + sx * lx) * b0.w + (b0.h + sy * ly) * b0.h) / (b0.w * b0.w + b0.h * b0.h)
    const f = Math.max(k, MIN_SIDE / Math.min(b0.w, b0.h))
    w = b0.w * f
    h = b0.h * f
  }
  const own = src.w / src.h
  const snapped = mode === 'snap' && Math.abs(w / h / own - 1) < SNAP_STRETCH
  if (snapped) {
    // The dragged side gives way (the width when both are dragged).
    if (sx) w = h * own
    else h = w / own
  }
  const ox = (sx * (w - b0.w)) / 2
  const oy = (sy * (h - b0.h)) / 2
  return { cx: b0.cx + ox * cos - oy * sin, cy: b0.cy + ox * sin + oy * cos, w, h, angle: b0.angle, snapped }
}

/** The state with another stretch, the picture keeping its center and height on screen. */
export function withStretch(state: PanCropState, stretch: number, srcW: number, srcH: number, outW: number, outH: number): PanCropState {
  const at = sourcePlacement(state, srcW, srcH, outW, outH)
  return placeBox(at.x, at.y, (at.h * srcW * clampStretch(stretch)) / srcH, at.h, state.rotation, srcW, srcH, outW, outH)
}

/**
 * Zoom at which the source, stretched and turned by `rotation` (to the nearest
 * quarter turn), fits inside the output or covers it.
 */
export function framingZoom(
  mode: 'fit' | 'fill',
  rotation: number,
  srcW: number,
  srcH: number,
  outW: number,
  outH: number,
  stretch: number
): number {
  const vw = srcW * stretch
  const sideways = Math.abs(Math.round(rotation / 90)) % 2 === 1
  const w = sideways ? srcH : vw
  const h = sideways ? vw : srcH
  const scale = mode === 'fit' ? Math.min(outW / w, outH / h) : Math.max(outW / w, outH / h)
  return (scale * fitFrame(vw, srcH, outW, outH).w) / outW
}

/**
 * The state turned by `degrees` clockwise on screen around the source center,
 * which stays in place. A source that fitted or filled the frame still does
 * (a quarter turn of sideways footage fills a frame of the other orientation).
 */
export function turnState(state: PanCropState, degrees: number, srcW: number, srcH: number, outW: number, outH: number): PanCropState {
  const rotation = state.rotation - degrees
  const at = sourcePlacement(state, srcW, srcH, outW, outH)
  let zoom = state.zoom
  // Fit wins when both match (source and frame of the same shape).
  for (const mode of ['fill', 'fit'] as const) {
    if (Math.abs(state.zoom / framingZoom(mode, state.rotation, srcW, srcH, outW, outH, state.stretch) - 1) < 0.005) {
      zoom = framingZoom(mode, rotation, srcW, srcH, outW, outH, state.stretch)
    }
  }
  return placeSource(at.x, at.y, zoom, rotation, srcW, srcH, outW, outH, state.stretch)
}

/** Degrees in (-180, 180]. */
export function normalizeAngle(degrees: number): number {
  const d = (((degrees % 360) + 540) % 360) - 180
  return d === -180 ? 180 : d
}

/** Draws a source into an output-sized context through the pan/crop frame. */
export function drawPanCropped(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  outW: number,
  outH: number,
  state: PanCropState
): void {
  const frame = frameRect(state, srcW, srcH, outW, outH)
  const scale = outW / frame.w
  ctx.save()
  ctx.translate(outW / 2, outH / 2)
  ctx.rotate((-state.rotation * Math.PI) / 180)
  ctx.scale(scale, scale)
  ctx.translate(-frame.cx, -frame.cy)
  ctx.drawImage(source, 0, 0, srcW * state.stretch, srcH)
  ctx.restore()
}

/** Inserts or replaces the keyframe at `time`, keeping keys sorted. */
export function upsertKey(keys: readonly PanCropKey[], key: PanCropKey): PanCropKey[] {
  const out = keys.filter((k) => k.time !== key.time)
  out.push(key)
  out.sort((a, b) => a.time - b.time)
  return out
}

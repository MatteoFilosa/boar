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
}

export interface PanCropKey extends PanCropState {
  time: Flicks
  /** Interpolation from this keyframe to the next. */
  ease: Ease
}

export const DEFAULT_PANCROP: PanCropState = { cx: 0.5, cy: 0.5, zoom: 1, rotation: 0 }

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

const stateOf = (k: PanCropState): PanCropState => ({ cx: k.cx, cy: k.cy, zoom: k.zoom, rotation: k.rotation })

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
    zoom: Math.exp(lerp(Math.log(a.zoom), Math.log(b.zoom), t)),
    rotation: lerp(a.rotation, b.rotation, t)
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

/** Frame rectangle in source pixels for a state. */
export function frameRect(
  state: PanCropState,
  srcW: number,
  srcH: number,
  outW: number,
  outH: number
): { cx: number; cy: number; w: number; h: number; rotation: number } {
  const fit = fitFrame(srcW, srcH, outW, outH)
  return { cx: state.cx * srcW, cy: state.cy * srcH, w: fit.w / state.zoom, h: fit.h / state.zoom, rotation: state.rotation }
}

/** Where the source center lands in the output (pixels) and its displayed scale (output px per source px). */
export function sourcePlacement(
  state: PanCropState,
  srcW: number,
  srcH: number,
  outW: number,
  outH: number
): { x: number; y: number; scale: number } {
  const scale = (outW * state.zoom) / fitFrame(srcW, srcH, outW, outH).w
  const a = (-state.rotation * Math.PI) / 180
  // Source center relative to the output center, before and after the frame rotation.
  const vx = (0.5 - state.cx) * srcW * scale
  const vy = (0.5 - state.cy) * srcH * scale
  return { x: outW / 2 + vx * Math.cos(a) - vy * Math.sin(a), y: outH / 2 + vx * Math.sin(a) + vy * Math.cos(a), scale }
}

/** Maps source pixels to output pixels through a state (and back with `inverse`). */
export function sourceToOutput(
  state: PanCropState,
  srcW: number,
  srcH: number,
  outW: number,
  outH: number
): { map: (x: number, y: number) => [number, number]; inverse: (x: number, y: number) => [number, number] } {
  const scale = (outW * state.zoom) / fitFrame(srcW, srcH, outW, outH).w
  const a = (-state.rotation * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const fx = state.cx * srcW
  const fy = state.cy * srcH
  return {
    map: (x, y) => {
      const dx = (x - fx) * scale
      const dy = (y - fy) * scale
      return [outW / 2 + dx * cos - dy * sin, outH / 2 + dx * sin + dy * cos]
    },
    inverse: (x, y) => {
      const dx = x - outW / 2
      const dy = y - outH / 2
      return [fx + (dx * cos + dy * sin) / scale, fy + (-dx * sin + dy * cos) / scale]
    }
  }
}

/** State that puts the source center at (x, y) in the output with the given zoom and rotation. */
export function placeSource(
  x: number,
  y: number,
  zoom: number,
  rotation: number,
  srcW: number,
  srcH: number,
  outW: number,
  outH: number
): PanCropState {
  const scale = (outW * zoom) / fitFrame(srcW, srcH, outW, outH).w
  const a = (-rotation * Math.PI) / 180
  const dx = x - outW / 2
  const dy = y - outH / 2
  const vx = dx * Math.cos(a) + dy * Math.sin(a)
  const vy = -dx * Math.sin(a) + dy * Math.cos(a)
  return { cx: 0.5 - vx / (srcW * scale), cy: 0.5 - vy / (srcH * scale), zoom, rotation }
}

/**
 * Zoom at which the source, turned by `rotation` (to the nearest quarter
 * turn), fits inside the output or covers it.
 */
export function framingZoom(mode: 'fit' | 'fill', rotation: number, srcW: number, srcH: number, outW: number, outH: number): number {
  const sideways = Math.abs(Math.round(rotation / 90)) % 2 === 1
  const w = sideways ? srcH : srcW
  const h = sideways ? srcW : srcH
  const scale = mode === 'fit' ? Math.min(outW / w, outH / h) : Math.max(outW / w, outH / h)
  return (scale * fitFrame(srcW, srcH, outW, outH).w) / outW
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
    if (Math.abs(state.zoom / framingZoom(mode, state.rotation, srcW, srcH, outW, outH) - 1) < 0.005) {
      zoom = framingZoom(mode, rotation, srcW, srcH, outW, outH)
    }
  }
  return placeSource(at.x, at.y, zoom, rotation, srcW, srcH, outW, outH)
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
  ctx.drawImage(source, 0, 0, srcW, srcH)
  ctx.restore()
}

/** Inserts or replaces the keyframe at `time`, keeping keys sorted. */
export function upsertKey(keys: readonly PanCropKey[], key: PanCropKey): PanCropKey[] {
  const out = keys.filter((k) => k.time !== key.time)
  out.push(key)
  out.sort((a, b) => a.time - b.time)
  return out
}

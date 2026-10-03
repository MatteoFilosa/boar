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

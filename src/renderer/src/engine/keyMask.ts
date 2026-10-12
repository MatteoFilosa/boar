import { type EventFx, colorToRgb, fxParam } from '../core/fx'
import type { VideoFxMask } from './videoFx'

// Chroma Keyer "background only": the key color is removed where it is
// connected to the edge of the frame, and in enclosed areas larger than the
// `holes` share of the frame (the gap between a bag and its handles), so the
// same color in small details of the subject (a white logo on a bag shot on
// white) stays. The picture is read on the CPU at a reduced size, its keyed
// areas are flooded, and the result goes to the shader as its auxiliary mask
// (1 = background).

/** Longest side of the flood fill, in pixels. */
const WORK_SIZE = 480

let work: OffscreenCanvasRenderingContext2D | null = null

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

function hsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  let h = 0
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h = (h / 6 + 1) % 1
  }
  return [h, max > 0 ? d / max : 0, max]
}

/**
 * Pixels (`key` color, 0-1) the Chroma Keyer makes at least partly
 * transparent: the same distance as its shader in engine/videoFx.ts.
 */
function keyTest(fx: EventFx): (r: number, g: number, b: number) => boolean {
  const key = colorToRgb(fxParam(fx, 'color'))
  const [kh, ks] = hsv(...key)
  const hueKey = smoothstep(0.25, 0.5, ks)
  const limit = fxParam(fx, 'tolerance') + fxParam(fx, 'softness') + 0.001
  return (r, g, b) => {
    const [h, s, v] = hsv(r, g, b)
    let dh = Math.abs(h - kh)
    dh = Math.min(dh, 1 - dh) * 2
    const byHue = dh + (1 - smoothstep(0.12, 0.35, s)) + (1 - smoothstep(0.08, 0.25, v))
    const byColor = Math.hypot(r - key[0], g - key[1], b - key[2]) * 1.2
    return byColor + (byHue - byColor) * hueKey < limit
  }
}

/** The background mask for `fx` (a Chroma Keyer) over an output-sized frame of the event. */
export function edgeKeyMask(image: OffscreenCanvas, fx: EventFx): VideoFxMask {
  const scale = Math.min(1, WORK_SIZE / Math.max(image.width, image.height))
  const w = Math.max(1, Math.round(image.width * scale))
  const h = Math.max(1, Math.round(image.height * scale))
  if (!work || work.canvas.width !== w || work.canvas.height !== h) {
    work = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D
  }
  work.clearRect(0, 0, w, h)
  work.drawImage(image, 0, 0, w, h)
  const px = work.getImageData(0, 0, w, h).data
  const keyed = keyTest(fx)
  // Transparent pixels (around a picture smaller than the frame) let the flood through.
  const open = new Uint8Array(w * h)
  for (let i = 0; i < open.length; i++) {
    const o = i * 4
    open[i] = px[o + 3] < 128 || keyed(px[o] / 255, px[o + 1] / 255, px[o + 2] / 255) ? 1 : 0
  }
  // 1 = background, 2 = kept (an enclosed area too small to be background).
  const background = new Uint8Array(w * h)
  const queue = new Int32Array(w * h)
  let tail = 0
  const push = (i: number): void => {
    if (open[i] && !background[i]) {
      background[i] = 1
      queue[tail++] = i
    }
  }
  const flood = (from: number): void => {
    for (let head = from; head < tail; head++) {
      const i = queue[head]
      const x = i % w
      if (x > 0) push(i - 1)
      if (x < w - 1) push(i + 1)
      if (i >= w) push(i - w)
      if (i < w * (h - 1)) push(i + w)
    }
  }
  for (let x = 0; x < w; x++) {
    push(x)
    push((h - 1) * w + x)
  }
  for (let y = 0; y < h; y++) {
    push(y * w)
    push(y * w + w - 1)
  }
  flood(0)
  const minHole = fxParam(fx, 'holes') * w * h
  for (let i = 0; i < open.length; i++) {
    if (!open[i] || background[i]) continue
    const start = tail
    push(i)
    flood(start)
    if (tail - start <= minHole) for (let k = start; k < tail; k++) background[queue[k]] = 2
  }
  // Grown by a pixel: the mask is stretched to the frame, and its soft edge must
  // not leave a rim of the background around the subject.
  const data = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const near =
        background[i] === 1 ||
        (x > 0 && background[i - 1] === 1) ||
        (x < w - 1 && background[i + 1] === 1) ||
        (y > 0 && background[i - w] === 1) ||
        (y < h - 1 && background[i + w] === 1)
      data[i] = near ? 255 : 0
    }
  }
  return { data, width: w, height: h, kind: 'key' }
}

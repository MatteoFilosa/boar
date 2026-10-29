// Camcorder pictures in standard definition are stored with non-square
// pixels (720 samples for a 16:9 or 4:3 picture). The rest of Boar works with
// square pixels, so lines are stretched to their real width once, here.

/** Taps of a horizontal resampler: for each output sample, 4 source positions and weights (sum 1 << 14). */
export interface Taps {
  start: Int32Array
  weights: Int32Array
}

/** Bicubic (Catmull-Rom) taps from `from` samples to `to` samples per line. */
export function bicubicTaps(from: number, to: number): Taps {
  const start = new Int32Array(to)
  const weights = new Int32Array(to * 4)
  const kernel = (t: number): number => {
    const a = Math.abs(t)
    if (a < 1) return 1.5 * a * a * a - 2.5 * a * a + 1
    if (a < 2) return -0.5 * a * a * a + 2.5 * a * a - 4 * a + 2
    return 0
  }
  for (let x = 0; x < to; x++) {
    const center = ((x + 0.5) * from) / to - 0.5
    const first = Math.floor(center) - 1
    start[x] = first
    let total = 0
    const w = [0, 1, 2, 3].map((k) => kernel(center - (first + k)))
    const sum = w.reduce((s, v) => s + v, 0)
    for (let k = 0; k < 3; k++) {
      weights[x * 4 + k] = Math.round((w[k] / sum) * 16384)
      total += weights[x * 4 + k]
    }
    weights[x * 4 + 3] = 16384 - total
  }
  return { start, weights }
}

/** Resamples each line of a tight `from`×`height` plane to `to` samples (taps from bicubicTaps). */
export function resampleLines(
  src: Uint8Array,
  srcOffset: number,
  from: number,
  height: number,
  taps: Taps,
  dst: Uint8Array,
  dstOffset: number
): void {
  const to = taps.start.length
  const { start, weights } = taps
  const last = from - 1
  for (let y = 0; y < height; y++) {
    const s = srcOffset + y * from
    const d = dstOffset + y * to
    for (let x = 0; x < to; x++) {
      const i = start[x]
      const w = x * 4
      let sum: number
      if (i >= 0 && i + 3 <= last) {
        sum = src[s + i] * weights[w] + src[s + i + 1] * weights[w + 1] + src[s + i + 2] * weights[w + 2] + src[s + i + 3] * weights[w + 3]
      } else {
        sum = 0
        for (let k = 0; k < 4; k++) sum += src[s + Math.min(last, Math.max(0, i + k))] * weights[w + k]
      }
      const value = (sum + 8192) >> 14
      dst[d + x] = value < 0 ? 0 : value > 255 ? 255 : value
    }
  }
}

/** Output width for square pixels: the picture's height times its display aspect ratio, even. */
export function squareWidth(height: number, aspect: number): number {
  return Math.max(2, Math.round((height * aspect) / 2) * 2)
}

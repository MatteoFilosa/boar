import { GIFEncoder, type GifEncoderInstance, type Palette, applyPalette, quantize } from 'gifenc'
import { fps } from '../core/time'
import type { Project } from '../core/types'
import type { ExportQuality } from './export'

// Animated GIF writing over gifenc: a palette per frame, optional ordered
// dithering (a fixed pattern, so still areas do not shimmer from frame to
// frame), and frames identical to the previous one folded into its delay.

export const GIF_WIDTHS = [320, 480, 640, 800, 1080]
export const GIF_RATES = [10, 12, 15, 20, 25, 30]

export const GIF_QUALITIES: Record<ExportQuality, { label: string; colors: number; dither: boolean }> = {
  medium: { label: 'Medium (64 colors, smaller file)', colors: 64, dither: false },
  high: { label: 'High (256 colors)', colors: 256, dither: false },
  veryHigh: { label: 'Very high (256 colors, smoother gradients, larger file)', colors: 256, dither: true }
}

export interface GifSettings {
  /** Output width in pixels (at most the project's); the height follows the project's shape. */
  width: number
  /** Frames per second (at most the project's). */
  fps: number
  quality: ExportQuality
  autoCrossfade: boolean
  /** Play once instead of forever. */
  once?: boolean
}

/** The size and frame rate a GIF of this project really gets. */
export function gifFormat(project: Project, settings: Pick<GifSettings, 'width' | 'fps'>): { width: number; height: number; fps: number } {
  const { width, height, frameRate } = project.settings
  const w = Math.max(16, Math.min(width, Math.round(settings.width)))
  return { width: w, height: Math.max(16, Math.round((height * w) / width)), fps: Math.max(1, Math.min(fps(frameRate), settings.fps)) }
}

/** Longest delay a GIF frame can hold, in hundredths of a second. */
const MAX_DELAY = 0xffff

/**
 * How long each of `frames` frames stays, in hundredths of a second (the GIF
 * clock), so that frame i starts at round(i * 100 / rate) and no drift builds up.
 */
export function gifDelays(frames: number, rate: number): number[] {
  const at = (i: number): number => Math.round((i * 100) / rate)
  return Array.from({ length: frames }, (_, i) => at(i + 1) - at(i))
}

export interface GifOptions {
  /** Palette size of each frame, 2-256. */
  colors: number
  dither: boolean
  /** Play forever (otherwise once). */
  loop: boolean
}

// 4x4 Bayer matrix, as offsets around 0.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16 - 0.5)
/** Dither strength in 8-bit levels: about half the step between neighbouring palette colors. */
const DITHER_LEVELS = 24

function dithered(rgba: Uint8ClampedArray, width: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length)
  for (let p = 0, i = 0; i < rgba.length; p++, i += 4) {
    const offset = BAYER[((Math.floor(p / width) & 3) << 2) | (p % width & 3)] * DITHER_LEVELS
    out[i] = rgba[i] + offset
    out[i + 1] = rgba[i + 1] + offset
    out[i + 2] = rgba[i + 2] + offset
    out[i + 3] = 255
  }
  return out
}

function samePixels(a: Uint32Array, b: Uint32Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export class GifWriter {
  private readonly encoder: GifEncoderInstance = GIFEncoder()
  private pending: { index: Uint8Array; palette: Palette; delay: number } | null = null
  private last: Uint32Array | null = null
  /** Frames written to the file (after folding identical ones). */
  frames = 0

  constructor(
    readonly width: number,
    readonly height: number,
    private readonly options: GifOptions
  ) {}

  /** Adds a frame of RGBA pixels (width by height) that stays `delay` hundredths of a second. */
  add(rgba: Uint8ClampedArray, delay: number): void {
    const pixels = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.byteLength >> 2)
    if (this.pending && this.last && samePixels(pixels, this.last) && this.pending.delay + delay <= MAX_DELAY) {
      this.pending.delay += delay
      return
    }
    this.flush()
    this.last = pixels.slice()
    const palette = quantize(rgba, this.options.colors, { format: 'rgb565' })
    const index = applyPalette(this.options.dither ? dithered(rgba, this.width) : rgba, palette, 'rgb565')
    this.pending = { index, palette, delay }
  }

  private flush(): void {
    if (!this.pending) return
    const { index, palette, delay } = this.pending
    this.encoder.writeFrame(index, this.width, this.height, { palette, delay: delay * 10, repeat: this.options.loop ? 0 : -1 })
    this.frames++
    this.pending = null
  }

  /** The finished file. */
  finish(): Uint8Array<ArrayBuffer> {
    this.flush()
    this.encoder.finish()
    return this.encoder.bytes()
  }
}

/**
 * Shape mask on a video event, in output-frame coordinates (fractions of the
 * frame), applied after Pan/Crop. Outside the shape the event is transparent,
 * so lower tracks show through (or the inside, when inverted).
 */
export interface EventMask {
  shape: 'rectangle' | 'ellipse'
  cx: number
  cy: number
  w: number
  h: number
  /** Edge softness in px for a 1080 px short side. */
  feather: number
  invert: boolean
}

export const DEFAULT_MASK: EventMask = { shape: 'ellipse', cx: 0.5, cy: 0.5, w: 0.6, h: 0.6, feather: 40, invert: false }

type Canvas2D = OffscreenCanvasRenderingContext2D

const cache = new Map<string, OffscreenCanvas>()

/** White-on-transparent alpha mask for the shape, cached per parameters and size. */
export function maskCanvas(mask: EventMask, width: number, height: number): OffscreenCanvas {
  const key = `${width}x${height}:${mask.shape}:${mask.cx}:${mask.cy}:${mask.w}:${mask.h}:${mask.feather}:${mask.invert}`
  const hit = cache.get(key)
  if (hit) return hit
  if (cache.size > 32) cache.clear()
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d') as Canvas2D
  const scale = Math.min(width, height) / 1080
  const blur = mask.feather * scale
  const shape = (): void => {
    ctx.beginPath()
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
  shape()
  ctx.fill()
  cache.set(key, canvas)
  return canvas
}

// Decoded data derived from media files. Kept out of the zustand store because
// it is large and filled progressively; listeners redraw when it changes.

export interface Thumb {
  /** Source time in seconds. */
  time: number
  image: CanvasImageSource
}

export interface ThumbStrip {
  aspect: number
  thumbs: Thumb[]
}

export interface Peaks {
  /** Buckets per second of source audio. */
  perSecond: number
  /** Max absolute sample value per bucket, one array per channel (max 2). */
  channels: Float32Array[]
}

export const thumbCache = new Map<string, ThumbStrip>()
export const peakCache = new Map<string, Peaks>()
export const imageCache = new Map<string, ImageBitmap>()

/** The frames of an animated image (GIF, animated WebP or PNG), played in a loop. */
export interface AnimatedImage {
  frames: ImageBitmap[]
  /** When each frame ends, in seconds from the start of the loop. */
  ends: number[]
  /** Length of one loop in seconds. */
  duration: number
}

export const animationCache = new Map<string, AnimatedImage>()

/** The picture of an image at a source time (seconds): the frame of the loop for animated ones. */
export function imageAt(mediaId: string, seconds: number): ImageBitmap | undefined {
  const anim = animationCache.get(mediaId)
  if (!anim) return imageCache.get(mediaId)
  let t = seconds % anim.duration
  if (t < 0) t += anim.duration
  let lo = 0
  let hi = anim.ends.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (anim.ends[mid] > t) hi = mid
    else lo = mid + 1
  }
  return anim.frames[lo]
}

const listeners = new Set<() => void>()

export function onMediaCacheChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function notifyMediaCache(): void {
  for (const listener of listeners) listener()
}

export function dropMediaCache(mediaId: string): void {
  thumbCache.delete(mediaId)
  peakCache.delete(mediaId)
  imageCache.get(mediaId)?.close()
  imageCache.delete(mediaId)
  for (const frame of animationCache.get(mediaId)?.frames ?? []) frame.close()
  animationCache.delete(mediaId)
  notifyMediaCache()
}

/** Thumbnail closest to (and not after, when possible) a source time. */
export function thumbAt(strip: ThumbStrip, seconds: number): CanvasImageSource | null {
  const list = strip.thumbs
  if (list.length === 0) return null
  let lo = 0
  let hi = list.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (list[mid].time <= seconds) lo = mid
    else hi = mid - 1
  }
  return list[lo].image
}

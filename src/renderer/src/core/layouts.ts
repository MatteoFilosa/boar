import { type PanCropState, fillZoom, fitFrame } from './pancrop'

// Layouts made with Event Pan/Crop: a frame rectangle larger than the source
// leaves the rest transparent, so a clip can fill half of the frame or a corner.

export type Corner = 'topRight' | 'topLeft' | 'bottomRight' | 'bottomLeft'

/** Source fills the top or bottom half of the frame (cropped to fit, centered). */
export function halfFrame(srcW: number, srcH: number, outW: number, outH: number, half: 'top' | 'bottom'): PanCropState {
  const halfAspect = outW / (outH / 2)
  const sourceAspect = srcW / srcH
  const visW = sourceAspect > halfAspect ? srcH * halfAspect : srcW
  const visH = sourceAspect > halfAspect ? srcH : srcW / halfAspect
  const visTop = (srcH - visH) / 2
  // The frame rectangle is twice as tall as the visible part; the other half lies outside the source.
  const zoom = fitFrame(srcW, srcH, outW, outH).w / visW
  const cy = half === 'top' ? (visTop + visH) / srcH : visTop / srcH
  return { cx: 0.5, cy, zoom, rotation: 0 }
}

/** Source shown whole at `size` (fraction of the frame width) in a corner, `margin` from the edges. */
export function cornerFrame(
  srcW: number,
  srcH: number,
  outW: number,
  outH: number,
  corner: Corner,
  size: number,
  margin: number
): PanCropState {
  const fit = fitFrame(srcW, srcH, outW, outH)
  // Zoom 1 shows the whole source as wide as the frame (or as tall): scale it down to `size`.
  const shownW = (srcW / fit.w) * outW
  const zoom = (size * outW) / shownW
  const k = (outW * zoom) / fit.w // output px per source px
  const w = srcW * k
  const h = srcH * k
  const m = margin * outW
  const px = corner.endsWith('Right') ? outW - m - w / 2 : m + w / 2
  const py = corner.startsWith('top') ? m + h / 2 : outH - m - h / 2
  // The source center lands at (px, py): place the frame rectangle's center accordingly.
  const cx = (srcW / 2 - (px - outW / 2) / k) / srcW
  const cy = (srcH / 2 - (py - outH / 2) / k) / srcH
  return { cx, cy, zoom, rotation: 0 }
}

/** The source covering the whole frame (no bars). */
export const coverFrame = (srcW: number, srcH: number, outW: number, outH: number): PanCropState => ({
  cx: 0.5,
  cy: 0.5,
  zoom: fillZoom(srcW, srcH, outW, outH),
  rotation: 0
})

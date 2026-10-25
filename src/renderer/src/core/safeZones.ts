import type { PictureBox } from './pancrop'

// Safe zones: the parts of a vertical video that short video apps cover with
// their own buttons, account name and caption. The margins are the ones the
// platforms publish for vertical video ads (the only official numbers), on a
// 1080x1920 frame; horizontal projects get the classic action/title safe.

export type SafeGuide = 'reels' | 'tiktok' | 'shorts'
export const SAFE_GUIDES: SafeGuide[] = ['reels', 'tiktok', 'shorts']

/** What covers a part of the picture. */
export type SafeSide = 'top' | 'bottom' | 'left' | 'right' | 'buttons'

/** A rectangle in pixels (or in fractions of the frame inside a spec). */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface SafeZoneSpec {
  label: string
  /** Where the numbers come from. */
  source: string
  /** Covered margins, as fractions of the frame. */
  top: number
  bottom: number
  left: number
  right: number
  /** The column of buttons, when it reaches inside the margins (fractions). */
  buttons?: Rect
}

export const SAFE_ZONES: Record<SafeGuide | 'tv', SafeZoneSpec> = {
  reels: { label: 'Instagram Reels', source: 'Meta ads guide', top: 0.14, bottom: 0.35, left: 0.06, right: 0.06 },
  tiktok: {
    label: 'TikTok',
    source: 'In-Feed ads safe zone',
    top: 240 / 1920,
    bottom: 660 / 1920,
    left: 120 / 1080,
    right: 120 / 1080,
    buttons: { x: 780 / 1080, y: 840 / 1920, w: 300 / 1080, h: 1080 / 1920 }
  },
  shorts: { label: 'YouTube Shorts', source: 'Google vertical video ads', top: 288 / 1920, bottom: 672 / 1920, left: 48 / 1080, right: 192 / 1080 },
  tv: { label: 'Action safe', source: 'title safe 10%', top: 0.05, bottom: 0.05, left: 0.05, right: 0.05 }
}

/** The guide a frame of this size gets: the chosen app for vertical frames, action safe otherwise. */
export const safeSpec = (guide: SafeGuide, width: number, height: number): SafeZoneSpec =>
  SAFE_ZONES[height > width ? guide : 'tv']

/** The part of the frame nothing covers (the button column aside). */
export function safeRect(spec: SafeZoneSpec, width: number, height: number): Rect {
  const x = spec.left * width
  const y = spec.top * height
  return { x, y, w: width - x - spec.right * width, h: height - y - spec.bottom * height }
}

/** Every covered area in pixels, with what covers it. */
export function coveredAreas(spec: SafeZoneSpec, width: number, height: number): { side: SafeSide; rect: Rect }[] {
  const safe = safeRect(spec, width, height)
  const out: { side: SafeSide; rect: Rect }[] = [
    { side: 'top', rect: { x: 0, y: 0, w: width, h: safe.y } },
    { side: 'bottom', rect: { x: 0, y: safe.y + safe.h, w: width, h: height - safe.y - safe.h } },
    { side: 'left', rect: { x: 0, y: safe.y, w: safe.x, h: safe.h } },
    { side: 'right', rect: { x: safe.x + safe.w, y: safe.y, w: width - safe.x - safe.w, h: safe.h } }
  ]
  if (spec.buttons) {
    // Only the part of the column that reaches into the safe rectangle is news.
    const b = spec.buttons
    const x0 = Math.max(b.x * width, safe.x)
    const y0 = Math.max(b.y * height, safe.y)
    const x1 = Math.min((b.x + b.w) * width, safe.x + safe.w)
    const y1 = Math.min((b.y + b.h) * height, safe.y + safe.h)
    if (x1 > x0 && y1 > y0) out.push({ side: 'buttons', rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } })
  }
  return out.filter((a) => a.rect.w > 0 && a.rect.h > 0)
}

/** The four corners of a box, clockwise from its top left. */
export function boxCorners(b: PictureBox): [number, number][] {
  const c = Math.cos(b.angle)
  const s = Math.sin(b.angle)
  return [
    [-b.w / 2, -b.h / 2],
    [b.w / 2, -b.h / 2],
    [b.w / 2, b.h / 2],
    [-b.w / 2, b.h / 2]
  ].map(([x, y]) => [b.cx + x * c - y * s, b.cy + x * s + y * c])
}

/** Whether a (turned) box overlaps a rectangle by more than a pixel (separating axes). */
export function boxOverlaps(b: PictureBox, r: Rect): boolean {
  const a = boxCorners(b)
  const rect: [number, number][] = [
    [r.x, r.y],
    [r.x + r.w, r.y],
    [r.x + r.w, r.y + r.h],
    [r.x, r.y + r.h]
  ]
  const axes: [number, number][] = [
    [1, 0],
    [0, 1],
    [Math.cos(b.angle), Math.sin(b.angle)],
    [-Math.sin(b.angle), Math.cos(b.angle)]
  ]
  for (const [ax, ay] of axes) {
    const span = (points: [number, number][]): [number, number] => {
      const d = points.map(([x, y]) => x * ax + y * ay)
      return [Math.min(...d), Math.max(...d)]
    }
    const [a0, a1] = span(a)
    const [r0, r1] = span(rect)
    if (Math.min(a1, r1) - Math.max(a0, r0) <= 1) return false
  }
  return true
}

/** Whether a box covers the whole frame (a background: covered by the app UI by design). */
export function fillsFrame(b: PictureBox, width: number, height: number): boolean {
  const c = boxCorners(b)
  const xs = c.map((p) => p[0])
  const ys = c.map((p) => p[1])
  return Math.min(...xs) <= 1 && Math.min(...ys) <= 1 && Math.max(...xs) >= width - 1 && Math.max(...ys) >= height - 1
}

/** What covers part of the box (empty when it sits in the safe area). */
export function coveredSides(b: PictureBox, spec: SafeZoneSpec, width: number, height: number): SafeSide[] {
  if (!(b.w > 0 && b.h > 0)) return []
  return coveredAreas(spec, width, height)
    .filter((a) => boxOverlaps(b, a.rect))
    .map((a) => a.side)
}

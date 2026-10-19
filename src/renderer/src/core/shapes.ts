import type { PictureBox } from './pancrop'

// Shape events: rectangles, ellipses and arrows drawn over the video to point
// at things. Like text events they have no media file (mediaId ''), and they
// are drawn as vectors, so the outline keeps its width whatever the size.

export type ShapeKind = 'rectangle' | 'ellipse' | 'arrow'
export type ShapeAnimIn = 'none' | 'fade' | 'pop' | 'draw'
export type ShapeAnimOut = 'none' | 'fade' | 'pop'

export const SHAPE_KINDS: readonly ShapeKind[] = ['rectangle', 'ellipse', 'arrow']

export interface ShapeContent {
  kind: ShapeKind
  /** Rectangle and ellipse: center, as fractions of the frame. */
  x: number
  y: number
  /** Rectangle and ellipse: size, as fractions of the frame width and height. */
  w: number
  h: number
  /** Rectangle and ellipse: degrees, clockwise. */
  rotation: number
  /** Arrow: from the tail (x1, y1) to the tip (x2, y2), fractions of the frame. */
  x1: number
  y1: number
  x2: number
  y2: number
  /** Outline (the arrow itself for arrows). */
  color: string
  /** Outline width in px for a 1080 px short side; 0 = no outline. */
  width: number
  /** Fill color, '' = none (rectangle and ellipse). */
  fill: string
  fillOpacity: number
  /** Rectangle corner radius, px for a 1080 px short side. */
  radius: number
  /** Arrow head length, px for a 1080 px short side. */
  head: number
  /** Soft shadow under the outline, so it reads over busy footage. */
  shadow: boolean
  animIn: ShapeAnimIn
  animOut: ShapeAnimOut
  /** Seconds. */
  animDuration: number
}

const BASE: ShapeContent = {
  kind: 'rectangle',
  x: 0.5,
  y: 0.5,
  w: 0.3,
  h: 0.3,
  rotation: 0,
  x1: 0.4,
  y1: 0.65,
  x2: 0.5,
  y2: 0.5,
  color: '#ff2d2d',
  width: 10,
  fill: '',
  fillOpacity: 0.25,
  radius: 8,
  head: 52,
  shadow: true,
  animIn: 'none',
  animOut: 'none',
  animDuration: 0.35
}

/** Fills fields added after a shape was saved. */
export function normalizeShape(s: Partial<ShapeContent>): ShapeContent {
  const out = { ...BASE, ...s }
  if (!SHAPE_KINDS.includes(out.kind)) out.kind = 'rectangle'
  return out
}

export const SHAPE_ANIM_IN: { id: ShapeAnimIn; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'fade', label: 'Fade' },
  { id: 'pop', label: 'Pop' },
  { id: 'draw', label: 'Draw' }
]

export const SHAPE_ANIM_OUT: { id: ShapeAnimOut; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'fade', label: 'Fade' },
  { id: 'pop', label: 'Pop' }
]

export interface ShapePreset {
  id: string
  label: string
  description: string
}

export const SHAPE_PRESETS: ShapePreset[] = [
  { id: 'rectangle', label: 'Rectangle', description: 'A box around something to point at' },
  { id: 'ellipse', label: 'Ellipse', description: 'A circle around something to point at' },
  { id: 'arrow', label: 'Arrow', description: 'An arrow pointing at something' },
  { id: 'solid', label: 'Solid Color', description: 'The whole frame in one color (backgrounds, flashes)' }
]

export const shapePresetById = (id: string): ShapePreset | undefined => SHAPE_PRESETS.find((p) => p.id === id)

/**
 * A preset's shape for a frame of this size: boxes and circles keep their
 * proportions in a vertical frame too, the arrow points at the center.
 */
export function shapeForFrame(presetId: string, width: number, height: number): ShapeContent | null {
  const short = Math.min(width, height)
  const fx = (px: number): number => px / width
  const fy = (px: number): number => px / height
  switch (presetId) {
    case 'rectangle':
      return { ...BASE, w: fx(short * 0.56), h: fy(short * 0.36) }
    case 'ellipse':
      return { ...BASE, kind: 'ellipse', w: fx(short * 0.42), h: fy(short * 0.42) }
    case 'arrow':
      return { ...BASE, kind: 'arrow', width: 12, x1: 0.5 - fx(short * 0.22), y1: 0.5 + fy(short * 0.22), x2: 0.5, y2: 0.5 }
    case 'solid':
      return { ...BASE, w: 1, h: 1, width: 0, fill: '#1d4ed8', fillOpacity: 1, radius: 0, shadow: false }
  }
  return null
}

/** The look of a shape without where it is: what Paste Event Attributes gives to another shape. */
export function shapeStyle(s: ShapeContent): Partial<ShapeContent> {
  const { color, width, fill, fillOpacity, radius, head, shadow, animIn, animOut, animDuration } = s
  return { color, width, fill, fillOpacity, radius, head, shadow, animIn, animOut, animDuration }
}

// Geometry (output pixels)

const unitOf = (width: number, height: number): number => Math.min(width, height) / 1080

/** Arrow head length and half width in output pixels, never longer than most of the arrow. */
function arrowHead(s: ShapeContent, length: number, unit: number): { length: number; half: number } {
  const head = Math.min(s.head * unit, length * 0.6)
  return { length: head, half: Math.max(s.width * unit * 1.2, head * 0.5) }
}

/**
 * The shape's box on screen: a rectangle or ellipse's own box, or for an arrow
 * a box along it from the tail (left side) to the tip (right side).
 */
export function shapeBox(s: ShapeContent, width: number, height: number): PictureBox {
  if (s.kind !== 'arrow') return { cx: s.x * width, cy: s.y * height, w: s.w * width, h: s.h * height, angle: (s.rotation * Math.PI) / 180 }
  const ax = s.x1 * width
  const ay = s.y1 * height
  const bx = s.x2 * width
  const by = s.y2 * height
  const length = Math.hypot(bx - ax, by - ay)
  const unit = unitOf(width, height)
  return {
    cx: (ax + bx) / 2,
    cy: (ay + by) / 2,
    w: length,
    h: Math.max(arrowHead(s, length, unit).half * 2, 24 * unit),
    angle: Math.atan2(by - ay, bx - ax)
  }
}

/** The geometry that puts the shape in `box` (an arrow runs along the box, tail to tip). */
export function shapeFromBox(s: ShapeContent, box: PictureBox, width: number, height: number): Partial<ShapeContent> {
  if (s.kind !== 'arrow') {
    const deg = (box.angle * 180) / Math.PI
    return { x: box.cx / width, y: box.cy / height, w: box.w / width, h: box.h / height, rotation: Math.round(deg * 1000) / 1000 }
  }
  const ux = (Math.cos(box.angle) * box.w) / 2
  const uy = (Math.sin(box.angle) * box.w) / 2
  return { x1: (box.cx - ux) / width, y1: (box.cy - uy) / height, x2: (box.cx + ux) / width, y2: (box.cy + uy) / height }
}

/** The shape moved by (dx, dy) output pixels. */
export function moveShape(s: ShapeContent, dx: number, dy: number, width: number, height: number): Partial<ShapeContent> {
  const fx = dx / width
  const fy = dy / height
  if (s.kind === 'arrow') return { x1: s.x1 + fx, y1: s.y1 + fy, x2: s.x2 + fx, y2: s.y2 + fy }
  return { x: s.x + fx, y: s.y + fy }
}

/** The shape turned clockwise on screen by `degrees` around its center. */
export function turnShape(s: ShapeContent, degrees: number, width: number, height: number): Partial<ShapeContent> {
  const b = shapeBox(s, width, height)
  return shapeFromBox(s, { ...b, angle: b.angle + (degrees * Math.PI) / 180 }, width, height)
}

/** The same place drawn as another kind: a box becomes the arrow along its diagonal, an arrow the box around it. */
export function convertShape(s: ShapeContent, kind: ShapeKind, width: number, height: number): ShapeContent {
  if (kind === s.kind) return s
  if (kind !== 'arrow' && s.kind !== 'arrow') return { ...s, kind }
  if (kind === 'arrow') {
    // From the bottom left corner of the box to its top right one, turned with it.
    const b = shapeBox(s, width, height)
    const cos = Math.cos(b.angle)
    const sin = Math.sin(b.angle)
    const corner = (lx: number, ly: number): [number, number] => [(b.cx + lx * cos - ly * sin) / width, (b.cy + lx * sin + ly * cos) / height]
    const [x1, y1] = corner(-b.w / 2, b.h / 2)
    const [x2, y2] = corner(b.w / 2, -b.h / 2)
    return { ...s, kind, x1, y1, x2, y2 }
  }
  const min = 0.05 * Math.min(width, height)
  const w = Math.max(min, Math.abs(s.x2 - s.x1) * width)
  const h = Math.max(min, Math.abs(s.y2 - s.y1) * height)
  return { ...s, kind, x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2, w: w / width, h: h / height, rotation: 0 }
}

/** Length of the outline of a rectangle (rounded corners) or an ellipse, for the draw-on animation. */
export function outlineLength(kind: ShapeKind, w: number, h: number, radius: number): number {
  if (kind === 'ellipse') {
    const a = w / 2
    const b = h / 2
    return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)))
  }
  const r = Math.max(0, Math.min(radius, w / 2, h / 2))
  return 2 * (w + h) - (8 - 2 * Math.PI) * r
}

// Animation

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
const easeOut = (p: number): number => 1 - (1 - p) ** 3
const easeInOut = (p: number): number => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2)
const easeOutBack = (p: number): number => 1 + 2.70158 * (p - 1) ** 3 + 1.70158 * (p - 1) ** 2

/** Where a shape event is in time: seconds since its start and its length. */
export interface ShapeClock {
  t: number
  length: number
}

/** Opacity, scale and how much of the outline is drawn (0-1) at a moment of the event. */
export function shapeMotion(s: ShapeContent, clock?: ShapeClock): { alpha: number; scale: number; draw: number } {
  const m = { alpha: 1, scale: 1, draw: 1 }
  if (!clock) return m
  const d = Math.max(0.05, s.animDuration)
  const pin = clamp01(clock.t / d)
  if (s.animIn === 'fade') m.alpha *= easeOut(pin)
  else if (s.animIn === 'pop') {
    m.scale *= Math.max(0, easeOutBack(pin))
    m.alpha *= clamp01(pin * 3)
  } else if (s.animIn === 'draw') m.draw = easeInOut(pin)
  const pout = clamp01((clock.length - clock.t) / d)
  if (s.animOut === 'fade') m.alpha *= easeOut(pout)
  else if (s.animOut === 'pop') {
    m.scale *= pout < 1 ? Math.max(0, easeOutBack(pout)) : 1
    m.alpha *= clamp01(pout * 3)
  }
  return m
}

// Drawing

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

function rgba(hex: string, alpha: number): string {
  const v = hex.replace('#', '')
  const n = parseInt(v.length === 3 ? v.replace(/./g, (c) => c + c) : v, 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}

function setShadow(ctx: Ctx, on: boolean, unit: number): void {
  ctx.shadowColor = on ? 'rgba(0,0,0,0.5)' : 'transparent'
  ctx.shadowBlur = on ? 10 * unit : 0
  ctx.shadowOffsetY = on ? 3 * unit : 0
}

function drawArrow(ctx: Ctx, s: ShapeContent, width: number, height: number, unit: number, draw: number): void {
  const ax = s.x1 * width
  const ay = s.y1 * height
  const length = Math.hypot(s.x2 * width - ax, s.y2 * height - ay)
  if (length < 1) return
  const ux = (s.x2 * width - ax) / length
  const uy = (s.y2 * height - ay) / length
  const shown = length * draw
  const head = arrowHead(s, length, unit)
  // The head grows in over the first stretch of the draw-on animation.
  const k = Math.min(1, shown / Math.max(1, head.length))
  const hl = head.length * k
  const hw = head.half * k
  const tx = ax + ux * shown
  const ty = ay + uy * shown
  const lw = Math.max(1, s.width * unit)
  ctx.strokeStyle = s.color
  ctx.fillStyle = s.color
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = lw
  // The shaft stops inside the head, so its round end does not poke out of the tip.
  const shaft = Math.max(0, shown - hl * 0.7)
  if (shaft > 0) {
    ctx.beginPath()
    ctx.moveTo(ax, ay)
    ctx.lineTo(ax + ux * shaft, ay + uy * shaft)
    ctx.stroke()
  }
  if (hl > 0) {
    const bx = tx - ux * hl
    const by = ty - uy * hl
    ctx.beginPath()
    ctx.moveTo(tx, ty)
    ctx.lineTo(bx - uy * hw, by + ux * hw)
    ctx.lineTo(bx + uy * hw, by - ux * hw)
    ctx.closePath()
    ctx.fill()
    // Slightly rounded corners on the head.
    ctx.lineWidth = Math.min(lw, hw) * 0.5
    ctx.stroke()
  }
}

/**
 * Renders a shape event into an output-sized context. `clock` (absent in
 * thumbnails) drives the in/out animation.
 */
export function drawShape(ctx: Ctx, s: ShapeContent, width: number, height: number, alpha: number, clock?: ShapeClock): void {
  const unit = unitOf(width, height)
  const m = shapeMotion(s, clock)
  if (m.alpha <= 0 || m.scale <= 0 || m.draw <= 0) return
  const b = shapeBox(s, width, height)
  ctx.save()
  ctx.globalAlpha = alpha * m.alpha
  ctx.translate(b.cx, b.cy)
  ctx.scale(m.scale, m.scale)
  ctx.translate(-b.cx, -b.cy)
  if (s.kind === 'arrow') {
    setShadow(ctx, s.shadow, unit)
    drawArrow(ctx, s, width, height, unit, m.draw)
    ctx.restore()
    return
  }
  ctx.translate(b.cx, b.cy)
  ctx.rotate(b.angle)
  const radius = Math.max(0, Math.min(s.radius * unit, b.w / 2, b.h / 2))
  const trace = (): void => {
    ctx.beginPath()
    if (s.kind === 'ellipse') ctx.ellipse(0, 0, Math.max(0.5, b.w / 2), Math.max(0.5, b.h / 2), 0, -Math.PI / 2, (Math.PI * 3) / 2)
    else ctx.roundRect(-b.w / 2, -b.h / 2, b.w, b.h, radius)
  }
  if (s.fill) {
    setShadow(ctx, false, unit)
    trace()
    // The fill comes in with the outline when it draws itself.
    ctx.fillStyle = rgba(s.fill, s.fillOpacity * m.draw)
    ctx.fill()
  }
  const lw = s.width * unit
  if (lw > 0) {
    setShadow(ctx, s.shadow, unit)
    trace()
    ctx.lineWidth = lw
    ctx.lineJoin = 'round'
    ctx.strokeStyle = s.color
    if (m.draw < 1) {
      const total = outlineLength(s.kind, b.w, b.h, radius)
      ctx.setLineDash([total * m.draw, total + 1])
    }
    ctx.stroke()
  }
  ctx.restore()
}

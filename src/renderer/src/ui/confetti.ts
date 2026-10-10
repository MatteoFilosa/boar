import { useEditor } from '../core/store'
import { themeColor } from './themes'

// Confetti for finished tasks (BoarProgress.tsx): bits shot from a point, they
// slow down, then flutter down and fade. One full-window canvas that lets the
// pointer through, there only while bits are in the air.

interface Bit {
  x: number
  y: number
  vx: number
  vy: number
  /** Falling speed added by gravity (px/s), capped so the bits flutter. */
  fall: number
  w: number
  h: number
  round: boolean
  color: string
  angle: number
  spin: number
  /** Phase of the 3D flip and of the sideways sway. */
  flip: number
  flipSpeed: number
  sway: number
  age: number
  life: number
}

const GRAVITY = 520
const MAX_FALL = 170
const DRAG = 3.2
const FADE = 0.7

let canvas: HTMLCanvasElement | null = null
let bits: Bit[] = []
let frame = 0
let last = 0

/** Off in Options, or when the system asks for less motion. */
export function celebrationsOn(): boolean {
  if (!useEditor.getState().options.celebrations) return false
  return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

function palette(): string[] {
  // The boar's own orange with the interface's accent and transport colors.
  return [themeColor('accent'), themeColor('accent-light'), themeColor('play'), themeColor('pause'), themeColor('stop'), '#f08a2c', themeColor('text-strong')]
}

function fit(c: HTMLCanvasElement): void {
  const ratio = window.devicePixelRatio || 1
  const w = Math.round(window.innerWidth * ratio)
  const h = Math.round(window.innerHeight * ratio)
  if (c.width !== w || c.height !== h) {
    c.width = w
    c.height = h
  }
}

function tick(now: number): void {
  const c = canvas
  if (!c) return
  // Bits age with the clock (a hidden window gets no frames: they are gone when it shows again), move in small steps.
  const elapsed = Math.max(0, (now - last) / 1000)
  const dt = Math.min(0.05, elapsed)
  last = now
  fit(c)
  const ctx = c.getContext('2d')
  if (!ctx) return
  const ratio = window.devicePixelRatio || 1
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, c.width, c.height)
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  const bottom = window.innerHeight + 30
  const drag = Math.exp(-DRAG * dt)
  bits = bits.filter((b) => {
    b.age += elapsed
    if (b.age >= b.life || b.y > bottom) return false
    b.vx *= drag
    b.vy *= drag
    b.fall = Math.min(MAX_FALL, b.fall + GRAVITY * dt)
    b.flip += b.flipSpeed * dt
    b.angle += b.spin * dt
    b.x += (b.vx + Math.sin(b.flip * 0.6 + b.sway) * 28) * dt
    b.y += (b.vy + b.fall) * dt
    ctx.globalAlpha = Math.min(1, (b.life - b.age) / FADE)
    ctx.fillStyle = b.color
    ctx.save()
    ctx.translate(b.x, b.y)
    ctx.rotate(b.angle)
    // Turning over: the bit gets thinner and wider again.
    ctx.scale(1, Math.max(0.08, Math.abs(Math.cos(b.flip))))
    if (b.round) {
      ctx.beginPath()
      ctx.arc(0, 0, b.w / 2, 0, Math.PI * 2)
      ctx.fill()
    } else {
      ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h)
    }
    ctx.restore()
    return true
  })
  ctx.globalAlpha = 1
  if (bits.length > 0) {
    frame = requestAnimationFrame(tick)
  } else {
    c.remove()
    canvas = null
    frame = 0
  }
}

/**
 * Shoots `count` bits from (x, y) in window pixels, `angle` degrees from
 * straight up (negative = to the left), spread over `spread` degrees.
 */
export function burstConfetti(x: number, y: number, { count = 80, angle = 0, spread = 70, speed = 900 } = {}): void {
  if (!canvas) {
    canvas = document.createElement('canvas')
    canvas.className = 'confetti-layer'
    canvas.setAttribute('aria-hidden', 'true')
    document.body.appendChild(canvas)
    fit(canvas)
  }
  const colors = palette()
  for (let i = 0; i < count; i++) {
    const direction = ((angle + (Math.random() - 0.5) * spread - 90) * Math.PI) / 180
    const v = speed * (0.45 + Math.random() * 0.55)
    const ribbon = Math.random() < 0.3
    const round = !ribbon && Math.random() < 0.2
    const size = 5 + Math.random() * 5
    bits.push({
      x,
      y,
      vx: Math.cos(direction) * v,
      vy: Math.sin(direction) * v,
      fall: 0,
      w: round ? size * 0.9 : ribbon ? size * 0.45 : size,
      h: ribbon ? size * 2.2 : size * 0.65,
      round,
      color: colors[Math.floor(Math.random() * colors.length)],
      angle: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 12,
      flip: Math.random() * Math.PI * 2,
      flipSpeed: 6 + Math.random() * 8,
      sway: Math.random() * Math.PI * 2,
      age: 0,
      life: 2.2 + Math.random() * 1.2
    })
  }
  if (!frame) {
    last = performance.now()
    frame = requestAnimationFrame(tick)
  }
}

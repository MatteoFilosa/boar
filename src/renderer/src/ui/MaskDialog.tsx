import { useEffect, useRef, useState } from 'react'
import { Circle, Eraser, PenTool, Spline, Square, WandSparkles } from 'lucide-react'
import { FloatingWindow } from './FloatingWindow'
import * as A from '../core/actions'
import { mediaById, useEditor } from '../core/store'
import {
  DEFAULT_MASK,
  type EventMask,
  type MaskBox,
  type MaskPoint,
  type SmartSeeds,
  convertMaskSpace,
  dragBox,
  insertPoint,
  pathAt,
  removePoint,
  setShapeAt,
  shapeOutline,
  tracePath,
  upsertPathKey
} from '../core/mask'
import { frameRect, panCropAt, sourceToOutput } from '../core/pancrop'
import { drawText } from '../core/text'
import { drawShape } from '../core/shapes'
import { type Flicks, flicksToSeconds, frameFlicks } from '../core/time'
import { isGenerated, sourceLength, sourceTime } from '../core/timeline'
import type { MediaItem, ProjectSettings, TimelineEvent } from '../core/types'
import { imageCache } from '../media/cache'
import { smartOutline, trackOutline } from '../engine/smartMask'
import { BoarProgress, celebrate } from './BoarProgress'
import { KeyframeBar, canDraw, useSourceFrame } from './KeyframeBar'
import { NumberField } from './PanCropDialog'
import { themeColor } from './themes'

function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  onChange: (v: number) => void
}): React.JSX.Element {
  return (
    <label className="te-field">
      <span>{label}</span>
      <div className="te-control">
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
        <span className="te-dim te-val">{format(value)}</span>
      </div>
    </label>
  )
}

const SHAPES: { id: EventMask['shape']; label: string; icon: typeof Circle }[] = [
  { id: 'ellipse', label: 'Ellipse', icon: Circle },
  { id: 'rectangle', label: 'Rectangle', icon: Square },
  { id: 'custom', label: 'Custom', icon: Spline }
]

/** Floating window to edit an event's mask over its picture; the preview updates live. */
export function MaskDialog({ eventId }: { eventId: string }): React.JSX.Element | null {
  const event = useEditor((s) => s.project.events.find((e) => e.id === eventId))
  const settings = useEditor((s) => s.project.settings)
  const cursor = useEditor((s) => s.cursor)
  useEffect(() => {
    if (!event) A.closeDialog()
  }, [event])
  if (!event) return null
  return (
    <FloatingWindow id="maskCustom" className="pancrop" title="Event Mask" ariaLabel="Event Mask">
      <MaskEditor event={event} settings={settings} cursor={cursor} />
    </FloatingWindow>
  )
}

type Tool = 'points' | 'smart'

interface ViewMap {
  scale: number
  ox: number
  oy: number
}

/** Screen pixels for grabbing a point or handle, and for inserting a point on a side. */
const POINT_RADIUS = 8
const SIDE_RADIUS = 6

/** Ellipse and rectangle handles: corners and side middles, as (-1, 0 or 1) across and down. */
const HANDLES: MaskPoint[] = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0]
]

const handleCursor = ([hx, hy]: MaskPoint): string =>
  hx === 0 ? 'ns-resize' : hy === 0 ? 'ew-resize' : hx === hy ? 'nwse-resize' : 'nesw-resize'

const hitCanvas = new OffscreenCanvas(1, 1).getContext('2d') as OffscreenCanvasRenderingContext2D

interface Drag {
  /** Keyframes after the press (with the inserted point, if any). */
  base: EventMask['path']
  /** Point being moved, or -1 for the whole shape. */
  index: number
  from: MaskPoint
  start: MaskPoint[]
}

interface BoxDrag {
  mode: 'move' | 'resize' | 'draw'
  handle: MaskPoint
  /** Press, in fractions of the shape's space. */
  from: MaskPoint
  start: MaskBox
  /** Press in screen pixels: drawing starts once the pointer really moves. */
  client: MaskPoint
  moved: boolean
}

function MaskEditor({
  event,
  settings,
  cursor
}: {
  event: TimelineEvent
  settings: ProjectSettings
  cursor: Flicks
}): React.JSX.Element {
  const mask = event.mask
  const customMask = mask?.shape === 'custom' ? mask : null
  const boxMask = mask && mask.shape !== 'custom' ? mask : null
  const media: MediaItem | undefined = isGenerated(event) ? undefined : mediaById(event.mediaId)
  const canSmart = !!media && !!media.width
  const [tool, setTool] = useState<Tool>('points')
  const [busy, setBusy] = useState<{ label: string; progress: number | null } | null>(null)
  const cancelled = useRef(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewRef = useRef<ViewMap>({ scale: 1, ox: 0, oy: 0 })
  const dragRef = useRef<Drag | null>(null)
  const boxRef = useRef<BoxDrag | null>(null)
  /** The mask before it was switched off, to bring it back. */
  const kept = useRef<EventMask | null>(null)
  const [, setTick] = useState(0)
  const redraw = useRef(() => setTick((n) => n + 1)).current

  // A custom shape without points starts with Smart Select when the event has a picture.
  const shape = mask?.shape
  useEffect(() => {
    if (customMask) setTool(canSmart && (customMask.path.length === 0 || customMask.smart) ? 'smart' : 'points')
    // Only when the shape changes, not at every edit of its points.
  }, [shape, canSmart])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver(() => redraw())
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [redraw])
  useEffect(
    () => () => {
      cancelled.current = true
    },
    []
  )

  const frame = frameFlicks(settings.frameRate)
  const local = Math.min(Math.max(0, cursor - event.start), Math.max(0, event.length - frame))
  const srcTime = sourceTime(event, event.start + local)
  // Text has no source picture: its shape is drawn over the frame.
  const sw = media?.width || settings.width
  const sh = media?.height || settings.height
  const state = panCropAt(event.panCrop, srcTime)
  const video = useSourceFrame(media, flicksToSeconds(srcTime), redraw)

  // An ellipse or rectangle over the output frame (older masks, or "Moves with
  // the picture" off) is placed on the source picture here through Pan/Crop.
  const overFrame = !!boxMask && boxMask.space === 'frame' && !!media?.width && !!media.height
  const toOutput = overFrame ? sourceToOutput(state, sw, sh, settings.width, settings.height) : null
  /** Size in pixels of the space an ellipse or rectangle is measured in. */
  const spaceW = toOutput ? settings.width : sw
  const spaceH = toOutput ? settings.height : sh
  /** From fractions of that space to source pixels, and back. */
  const fromSpace = ([x, y]: MaskPoint): MaskPoint => (toOutput ? toOutput.inverse(x * spaceW, y * spaceH) : [x * sw, y * sh])
  const toSpace = ([x, y]: MaskPoint): MaskPoint => {
    if (!toOutput) return [x / sw, y / sh]
    const [ox, oy] = toOutput.map(x, y)
    return [ox / spaceW, oy / spaceH]
  }
  const outline = boxMask ? shapeOutline(boxMask).map(fromSpace) : []
  const handles = boxMask ? HANDLES.map(([hx, hy]) => fromSpace([boxMask.cx + (hx * boxMask.w) / 2, boxMask.cy + (hy * boxMask.h) / 2])) : []

  const points = customMask ? pathAt(customMask.path, srcTime) : []
  const px: MaskPoint[] = points.map(([x, y]) => [x * sw, y * sh])
  const keyHere = customMask ? customMask.path.findIndex((k) => Math.abs(k.time - srcTime) < frame / 2) : -1
  const seeds = customMask?.smart && Math.abs(customMask.smart.time - srcTime) < frame / 2 ? customMask.smart : null

  /** The mask as it is now in the project (async work may finish after other edits). */
  const latest = (): EventMask =>
    useEditor.getState().project.events.find((e) => e.id === event.id)?.mask ?? mask ?? { ...DEFAULT_MASK, shape: 'custom' }

  // Workspace drawing
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const cw = canvas.clientWidth
    const ch = canvas.clientHeight
    canvas.width = Math.round(cw * dpr)
    canvas.height = Math.round(ch * dpr)
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const pad = 24
    const scale = Math.max(0.01, Math.min((cw - pad * 2) / sw, (ch - pad * 2) / sh))
    const ox = (cw - sw * scale) / 2
    const oy = (ch - sh * scale) / 2
    viewRef.current = { scale, ox, oy }

    ctx.fillStyle = themeColor('workspace')
    ctx.fillRect(0, 0, cw, ch)
    ctx.fillStyle = '#000'
    ctx.fillRect(ox, oy, sw * scale, sh * scale)
    if (event.text) {
      ctx.save()
      ctx.translate(ox, oy)
      ctx.scale(scale, scale)
      drawText(ctx, event.text, sw, sh, 1)
      ctx.restore()
    } else if (event.shape) {
      ctx.save()
      ctx.translate(ox, oy)
      ctx.scale(scale, scale)
      drawShape(ctx, event.shape, sw, sh, 1)
      ctx.restore()
    } else if (media) {
      const source: CanvasImageSource | null =
        media.kind === 'image' ? (imageCache.get(media.id) ?? null) : canDraw(video) ? video : null
      if (source) ctx.drawImage(source, ox, oy, sw * scale, sh * scale)
    }

    ctx.save()
    ctx.translate(ox, oy)
    ctx.scale(scale, scale)
    const lw = 1 / scale
    // What the output frame shows of the source (Event Pan/Crop).
    if (media && event.panCrop.length > 0) {
      const f = frameRect(state, sw, sh, settings.width, settings.height)
      ctx.save()
      // The frame lies over the stretched picture; this window shows it unstretched.
      ctx.scale(1 / state.stretch, 1)
      ctx.translate(f.cx, f.cy)
      ctx.rotate((f.rotation * Math.PI) / 180)
      ctx.setLineDash([6 * lw, 4 * lw])
      ctx.strokeStyle = 'rgba(255,255,255,0.45)'
      ctx.lineWidth = lw
      ctx.strokeRect(-f.w / 2, -f.h / 2, f.w, f.h)
      ctx.restore()
    }
    /** Dims what the mask hides and outlines the shape. */
    const cut = (shape: Path2D, invert: boolean): void => {
      ctx.fillStyle = 'rgba(10,11,13,0.6)'
      if (invert) ctx.fill(shape)
      else {
        const outside = new Path2D()
        outside.rect(-sw, -sh, sw * 3, sh * 3)
        outside.addPath(shape)
        ctx.fill(outside, 'evenodd')
      }
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1.5 * lw
      ctx.stroke(shape)
    }
    if (boxMask) {
      const shape = new Path2D()
      tracePath(shape, outline, false)
      cut(shape, boxMask.invert)
      const size = 8 * lw
      ctx.lineWidth = lw
      ctx.fillStyle = '#ffffff'
      ctx.strokeStyle = '#1b1c20'
      for (const [x, y] of handles) {
        ctx.fillRect(x - size / 2, y - size / 2, size, size)
        ctx.strokeRect(x - size / 2, y - size / 2, size, size)
      }
    } else if (customMask) {
      if (px.length >= 3) {
        const shape = new Path2D()
        tracePath(shape, px, customMask.smooth)
        cut(shape, customMask.invert)
      } else if (px.length === 2) {
        ctx.strokeStyle = '#ffffff'
        ctx.lineWidth = 1.5 * lw
        ctx.beginPath()
        ctx.moveTo(px[0][0], px[0][1])
        ctx.lineTo(px[1][0], px[1][1])
        ctx.stroke()
      }
      // Outlines from Smart Select have many points: smaller handles.
      const size = (tool === 'points' ? (px.length > 24 ? 5 : 7) : 4) * lw
      ctx.lineWidth = lw
      px.forEach(([x, y], i) => {
        ctx.fillStyle = keyHere >= 0 || customMask.path.length <= 1 ? '#ffffff' : '#9fb8e8'
        ctx.strokeStyle = '#1b1c20'
        ctx.fillRect(x - size / 2, y - size / 2, size, size)
        ctx.strokeRect(x - size / 2, y - size / 2, size, size)
        if (i === 0 && tool === 'points') {
          ctx.strokeStyle = '#ffcf70'
          ctx.strokeRect(x - size, y - size, size * 2, size * 2)
        }
      })
      // Smart Select points on their frame: green adds, red removes.
      if (seeds) {
        const mark = ([x, y]: MaskPoint, include: boolean): void => {
          const r = 7 * lw
          const cx = x * sw
          const cy = y * sh
          ctx.beginPath()
          ctx.arc(cx, cy, r, 0, Math.PI * 2)
          ctx.fillStyle = include ? '#2fb85a' : '#e04848'
          ctx.fill()
          ctx.strokeStyle = '#fff'
          ctx.lineWidth = 1.5 * lw
          ctx.stroke()
          ctx.beginPath()
          ctx.moveTo(cx - r * 0.5, cy)
          ctx.lineTo(cx + r * 0.5, cy)
          if (include) {
            ctx.moveTo(cx, cy - r * 0.5)
            ctx.lineTo(cx, cy + r * 0.5)
          }
          ctx.stroke()
        }
        seeds.include.forEach((p) => mark(p, true))
        seeds.exclude.forEach((p) => mark(p, false))
      }
    }
    ctx.restore()

    const message = !mask
      ? 'The mask is off'
      : customMask && px.length === 0 && !busy
        ? tool === 'smart'
          ? 'Click the object to cut out'
          : 'Click to place the points of the shape'
        : ''
    if (message) {
      ctx.fillStyle = 'rgba(255,255,255,0.75)'
      ctx.font = '13px "Segoe UI", system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(message, cw / 2, oy + 18)
    }
  })

  /** Pointer position in source pixels. */
  const toSource = (e: { clientX: number; clientY: number }): MaskPoint => {
    const r = (canvasRef.current as HTMLCanvasElement).getBoundingClientRect()
    const { scale, ox, oy } = viewRef.current
    return [(e.clientX - r.left - ox) / scale, (e.clientY - r.top - oy) / scale]
  }
  const toFraction = ([x, y]: MaskPoint): MaskPoint => [x / sw, y / sh]

  // Ellipse and rectangle

  /** What a press at `p` (source pixels) does to an ellipse or rectangle. */
  const boxHit = (p: MaskPoint): { mode: BoxDrag['mode']; handle: MaskPoint } => {
    const k = viewRef.current.scale
    const near = handles.findIndex(([x, y]) => Math.hypot(x - p[0], y - p[1]) * k < POINT_RADIUS)
    if (near >= 0) return { mode: 'resize', handle: HANDLES[near] }
    if (!boxMask) return { mode: 'draw', handle: [0, 0] }
    const [x, y] = toSpace(p)
    const dx = (x - boxMask.cx) / (boxMask.w / 2)
    const dy = (y - boxMask.cy) / (boxMask.h / 2)
    const inside = boxMask.shape === 'rectangle' ? Math.abs(dx) <= 1 && Math.abs(dy) <= 1 : dx * dx + dy * dy <= 1
    return { mode: inside ? 'move' : 'draw', handle: [0, 0] }
  }

  const boxDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!boxMask || e.button !== 0) return
    const p = toSource(e)
    const { mode, handle } = boxHit(p)
    e.currentTarget.setPointerCapture(e.pointerId)
    A.beginGesture()
    const { cx, cy, w, h } = boxMask
    boxRef.current = { mode, handle, from: toSpace(p), start: { cx, cy, w, h }, client: [e.clientX, e.clientY], moved: mode !== 'draw' }
  }

  const boxMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const drag = boxRef.current
    if (!drag) return
    // A click outside the shape leaves it alone; a drag draws a new one.
    if (!drag.moved && Math.hypot(e.clientX - drag.client[0], e.clientY - drag.client[1]) < 3) return
    drag.moved = true
    const [hx, hy] = drag.handle
    const box = dragBox(drag.start, drag.mode, hx, hy, drag.from, toSpace(toSource(e)), e.shiftKey, e.altKey, spaceW / spaceH)
    A.updateGesture((d) => {
      const ev = d.events.find((o) => o.id === event.id)
      if (ev?.mask) ev.mask = { ...ev.mask, ...box }
    })
  }

  // Custom shape

  /** What a press at `p` (source pixels) hits in the points tool. */
  const hit = (p: MaskPoint): { kind: 'point' | 'side' | 'inside' | 'outside'; index: number } => {
    const k = viewRef.current.scale
    const near = px.findIndex(([x, y]) => Math.hypot(x - p[0], y - p[1]) * k < POINT_RADIUS)
    if (near >= 0) return { kind: 'point', index: near }
    if (px.length >= 2) {
      let best = -1
      let bestD = SIDE_RADIUS
      for (let i = 0; i < px.length; i++) {
        const a = px[i]
        const b = px[(i + 1) % px.length]
        const len2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2
        const f = len2 > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / len2)) : 0
        const d = Math.hypot(a[0] + (b[0] - a[0]) * f - p[0], a[1] + (b[1] - a[1]) * f - p[1]) * k
        if (d < bestD) {
          bestD = d
          best = i
        }
      }
      if (best >= 0) return { kind: 'side', index: best }
    }
    if (px.length >= 3) {
      const shape = new Path2D()
      tracePath(shape, px, customMask?.smooth ?? true)
      if (hitCanvas.isPointInPath(shape, p[0], p[1])) return { kind: 'inside', index: -1 }
    }
    return { kind: 'outside', index: -1 }
  }

  const startDrag = (base: EventMask['path'], index: number, from: MaskPoint): void => {
    A.beginGesture()
    dragRef.current = { base, index, from, start: pathAt(base, srcTime) }
    moveDrag(from)
  }

  const moveDrag = (p: MaskPoint): void => {
    const drag = dragRef.current
    if (!drag) return
    const dx = (p[0] - drag.from[0]) / sw
    const dy = (p[1] - drag.from[1]) / sh
    const shape = drag.start.map(([x, y], i): MaskPoint => (drag.index < 0 || i === drag.index ? [x + dx, y + dy] : [x, y]))
    const path = setShapeAt(drag.base, srcTime, shape, frame / 2)
    A.updateGesture((d) => {
      const e = d.events.find((o) => o.id === event.id)
      if (e?.mask) e.mask = { ...e.mask, path }
    })
  }

  const pointsDown = (e: React.PointerEvent<HTMLCanvasElement>, m: EventMask): void => {
    const p = toSource(e)
    const target = hit(p)
    const remove = e.button === 2 || e.altKey
    if (remove) {
      if (target.kind === 'point') A.replaceMask(event.id, { ...m, path: removePoint(m.path, target.index) })
      return
    }
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    if (target.kind === 'point') startDrag(m.path, target.index, p)
    else if (target.kind === 'side') startDrag(insertPoint(m.path, srcTime, target.index, toFraction(p), frame / 2), target.index + 1, p)
    else if (target.kind === 'inside') startDrag(m.path, -1, p)
    else startDrag(insertPoint(m.path, srcTime, px.length - 1, toFraction(p), frame / 2), px.length, p)
  }

  const smartDown = async (e: React.PointerEvent<HTMLCanvasElement>): Promise<void> => {
    if (!media || busy) return
    const [x, y] = toFraction(toSource(e))
    if (x < 0 || y < 0 || x > 1 || y > 1) return
    const exclude = e.button === 2 || e.altKey
    const p: MaskPoint = [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4]
    // Points belong to one frame: a click on another frame starts a new selection there.
    const next: SmartSeeds = seeds
      ? { ...seeds, include: exclude ? seeds.include : [...seeds.include, p], exclude: exclude ? [...seeds.exclude, p] : seeds.exclude }
      : { time: srcTime, include: exclude ? [] : [p], exclude: exclude ? [p] : [] }
    if (next.include.length === 0) {
      A.replaceMask(event.id, { ...latest(), smart: next })
      A.setStatus('Click the object to cut out first, then Alt+click the parts to leave out')
      return
    }
    setBusy({ label: 'Finding the object…', progress: null })
    try {
      const outline = await smartOutline(media, next)
      const current = latest()
      A.replaceMask(event.id, { ...current, smart: next, path: outline ? [{ time: next.time, points: outline }] : current.path })
      A.setStatus(
        outline
          ? media.kind === 'video'
            ? 'Selected: click more parts to add them, Alt+click to leave parts out, then Track Motion to follow it'
            : 'Selected: click more parts to add them, Alt+click to leave parts out'
          : 'Nothing found there: click inside the object'
      )
    } catch (err) {
      A.setStatus(`Smart Select failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  const track = async (): Promise<void> => {
    const smart = customMask?.smart
    if (!media || !smart || smart.include.length === 0) return
    cancelled.current = false
    setBusy({ label: 'Tracking', progress: 0 })
    try {
      const keys = await trackOutline(event, media, smart, (f) => setBusy({ label: 'Tracking', progress: f }), () => cancelled.current)
      if (keys.length > 0) {
        A.replaceMask(event.id, { ...latest(), path: keys })
        A.setStatus(`Mask follows the object: ${keys.length} keyframe${keys.length === 1 ? '' : 's'}`)
        celebrate('Mask follows the object')
      } else A.setStatus('The object was not found in the clip')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message !== 'cancelled') A.setStatus(`Tracking failed: ${message}`)
    } finally {
      setBusy(null)
    }
  }

  // Pointer

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (busy) return
    if (boxMask) boxDown(e)
    else if (customMask) {
      if (tool === 'smart') void smartDown(e)
      else pointsDown(e, customMask)
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (dragRef.current) {
      moveDrag(toSource(e))
      return
    }
    if (boxRef.current) {
      boxMove(e)
      return
    }
    const style = e.currentTarget.style
    if (boxMask) {
      const { mode, handle } = boxHit(toSource(e))
      style.cursor = mode === 'resize' ? handleCursor(handle) : mode === 'move' ? 'move' : 'crosshair'
    } else if (!customMask) style.cursor = 'default'
    else if (tool === 'smart') style.cursor = busy ? 'progress' : e.altKey ? 'not-allowed' : 'crosshair'
    else {
      const target = hit(toSource(e))
      style.cursor =
        target.kind === 'point' ? (e.altKey ? 'not-allowed' : 'grab') : target.kind === 'side' ? 'copy' : target.kind === 'inside' ? 'move' : 'crosshair'
    }
  }

  const onPointerUp = (): void => {
    if (!dragRef.current && !boxRef.current) return
    dragRef.current = null
    boxRef.current = null
    A.endGesture()
  }

  // Properties

  const update = (patch: Partial<EventMask>, field: string): void => {
    if (mask) A.setMask(event.id, { ...mask, ...patch }, field)
  }
  const setEnabled = (on: boolean): void => {
    if (on) A.replaceMask(event.id, kept.current ?? { ...DEFAULT_MASK })
    else {
      kept.current = mask
      A.replaceMask(event.id, null)
    }
  }
  const canFollow = !!media?.width && !!media.height
  const setFollow = (follow: boolean): void => {
    if (boxMask && media) {
      A.setMask(event.id, convertMaskSpace(boxMask, follow ? 'picture' : 'frame', state, sw, sh, settings.width, settings.height), 'space')
    }
  }

  // After a split the Smart Select points may be on a frame of the other part.
  const seedInEvent = !!customMask?.smart && customMask.smart.time >= event.offset && customMask.smart.time <= event.offset + sourceLength(event)
  const trackable = media?.kind === 'video' && seedInEvent && (customMask?.smart?.include.length ?? 0) > 0
  return (
    <div className="pc-body">
      <div className="pc-props">
        <label className="te-check" title="Outside the shape the event becomes transparent, so lower tracks show through">
          <input type="checkbox" checked={mask !== null} onChange={(e) => setEnabled(e.target.checked)} />
          Mask on
        </label>
        <fieldset className="mask-props" disabled={!mask}>
          <div className="te-control mask-shapes">
            {SHAPES.map(({ id, label, icon: Icon }) => (
              <button key={id} className={`tool-btn labeled${mask?.shape === id ? ' active' : ''}`} onClick={() => update({ shape: id }, 'shape')}>
                <Icon size={13} /> {label}
              </button>
            ))}
          </div>
          <div className="mask-row">
            <label className="te-check">
              <input type="checkbox" checked={mask?.invert ?? false} onChange={(e) => update({ invert: e.target.checked }, 'invert')} />
              Invert
            </label>
            {customMask && (
              <label className="te-check">
                <input type="checkbox" checked={customMask.smooth} onChange={(e) => update({ smooth: e.target.checked }, 'smooth')} />
                Smooth curve
              </label>
            )}
          </div>
          <Slider
            label="Feather"
            value={mask?.feather ?? 0}
            min={0}
            max={200}
            step={1}
            format={(v) => `${v}px`}
            onChange={(v) => update({ feather: v }, 'feather')}
          />

          {boxMask && (
            <>
              <div className="pc-group">Position and size (px)</div>
              <NumberField label="Center X" value={boxMask.cx * spaceW} step={1} digits={0} onChange={(v) => update({ cx: v / spaceW }, 'cx')} />
              <NumberField label="Center Y" value={boxMask.cy * spaceH} step={1} digits={0} onChange={(v) => update({ cy: v / spaceH }, 'cy')} />
              <NumberField label="Width" value={boxMask.w * spaceW} step={1} digits={0} onChange={(v) => v > 0 && update({ w: v / spaceW }, 'w')} />
              <NumberField label="Height" value={boxMask.h * spaceH} step={1} digits={0} onChange={(v) => v > 0 && update({ h: v / spaceH }, 'h')} />
              {canFollow && (
                <label
                  className="te-check"
                  title="On: the shape is part of the picture, so moving, zooming or turning it with Event Pan/Crop (or the preview handles) takes the masked part along. Off: a fixed window over the frame that the picture moves behind."
                >
                  <input type="checkbox" checked={boxMask.space === 'picture'} onChange={(e) => setFollow(e.target.checked)} />
                  Moves with the picture (Pan/Crop)
                </label>
              )}
              <p className="dim mask-hint">
                Drag inside the shape to move it, drag a handle to resize it (Shift keeps the proportions, Alt works from the center), drag
                outside it to draw a new one. Pixels of the {overFrame || !media ? 'frame' : 'picture'}.
              </p>
            </>
          )}

          {customMask && (
            <>
              <div className="pc-group">Tool</div>
              <div className="te-control mask-tools">
                <button className={`tool-btn labeled${tool === 'points' ? ' active' : ''}`} onClick={() => setTool('points')} title="Place and drag points">
                  <PenTool size={13} /> Points
                </button>
                <button
                  className={`tool-btn labeled${tool === 'smart' ? ' active' : ''}`}
                  disabled={!canSmart}
                  onClick={() => setTool('smart')}
                  title={canSmart ? 'Click an object: the AI cuts it out (runs on this computer)' : 'Smart Select works on video and image events'}
                >
                  <WandSparkles size={13} /> Smart Select
                </button>
              </div>
              <p className="dim mask-hint">
                {tool === 'smart'
                  ? 'Click the object to cut out. Click more parts to add them; Alt+click (or right-click) what to leave out.'
                  : 'Click to add points, drag to move them, click a side to insert one. Drag inside to move the shape; Alt+click (or right-click) a point to delete it.'}
              </p>
              {busy ? (
                <div className="mask-busy">
                  <BoarProgress value={busy.progress}>
                    {busy.label}
                    {busy.progress !== null ? ` ${Math.round(busy.progress * 100)}%` : ''}
                  </BoarProgress>
                  {busy.progress !== null && (
                    <button className="btn small" onClick={() => (cancelled.current = true)}>
                      Cancel
                    </button>
                  )}
                </div>
              ) : (
                <div className="pc-buttons">
                  {media?.kind === 'video' && (
                    <button
                      className="btn small"
                      disabled={!trackable}
                      onClick={() => void track()}
                      title={
                        trackable
                          ? 'Follow the selected object through the whole event'
                          : customMask.smart && !seedInEvent
                            ? 'Pick the object again with Smart Select on a frame of this event'
                            : 'Select an object with Smart Select first'
                      }
                    >
                      Track Motion
                    </button>
                  )}
                  <button
                    className="btn small"
                    disabled={customMask.path.length === 0 && !customMask.smart}
                    onClick={() => A.replaceMask(event.id, { ...customMask, path: [], smart: null })}
                    title="Remove every point and keyframe"
                  >
                    <Eraser size={12} /> Clear
                  </button>
                </div>
              )}
            </>
          )}
        </fieldset>
        <p className="dim mask-hint mask-tip">Tip: put the masked event on a track above another clip for a picture-in-picture or spotlight look.</p>
      </div>
      <div className="pc-main">
        <canvas
          ref={canvasRef}
          className="pc-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onContextMenu={(e) => e.preventDefault()}
        />
        {customMask && (
          <KeyframeBar
            event={event}
            keys={customMask.path}
            kind="mask"
            srcTime={srcTime}
            here={keyHere}
            local={local}
            frame={frame}
            frameRate={settings.frameRate}
            onAdd={() => points.length > 0 && A.replaceMask(event.id, { ...customMask, path: upsertPathKey(customMask.path, { time: srcTime, points }) })}
            onChange={(path) => A.replaceMask(event.id, { ...latest(), path })}
            pasteProblem={(keys) => {
              const count = customMask.path[0]?.points.length
              const other = keys.find((k) => count !== undefined && k.points.length !== count)
              return other ? `The copied shape has ${other.points.length} points and this one ${count}: keyframes of a shape need the same points` : null
            }}
          />
        )}
      </div>
    </div>
  )
}

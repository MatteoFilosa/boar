import { useEffect, useRef, useState } from 'react'
import { Circle, Eraser, PenTool, Spline, Square, WandSparkles } from 'lucide-react'
import { FloatingWindow } from './FloatingWindow'
import * as A from '../core/actions'
import { mediaById, useEditor } from '../core/store'
import {
  DEFAULT_MASK,
  type EventMask,
  type MaskPoint,
  type SmartSeeds,
  convertMaskSpace,
  insertPoint,
  pathAt,
  removePoint,
  setShapeAt,
  tracePath,
  upsertPathKey
} from '../core/mask'
import { frameRect, panCropAt } from '../core/pancrop'
import { drawText } from '../core/text'
import { type Flicks, flicksToSeconds, frameFlicks } from '../core/time'
import { sourceLength, sourceTime } from '../core/timeline'
import type { MediaItem, ProjectSettings, TimelineEvent } from '../core/types'
import { imageCache } from '../media/cache'
import { smartOutline, trackOutline } from '../engine/smartMask'
import { BoarProgress, celebrate } from './BoarProgress'
import { KeyframeBar, canDraw, useSourceFrame } from './KeyframeBar'
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

const pct = (v: number): string => `${Math.round(v * 100)}%`

const SHAPES: { id: EventMask['shape']; label: string; icon: typeof Circle }[] = [
  { id: 'ellipse', label: 'Ellipse', icon: Circle },
  { id: 'rectangle', label: 'Rectangle', icon: Square },
  { id: 'custom', label: 'Custom', icon: Spline }
]

/** Floating window to edit an event's mask; the preview updates live. */
export function MaskDialog({ eventId }: { eventId: string }): React.JSX.Element | null {
  const event = useEditor((s) => s.project.events.find((e) => e.id === eventId))
  const settings = useEditor((s) => s.project.settings)
  const cursor = useEditor((s) => s.cursor)
  useEffect(() => {
    if (!event) A.closeDialog()
  }, [event])
  if (!event) return null
  const mask = event.mask
  const update = (patch: Partial<EventMask>, field: string): void => A.setMask(event.id, { ...(mask ?? DEFAULT_MASK), ...patch }, field)
  // Text has no picture of its own: its shapes are always over the frame.
  const media = event.text ? undefined : mediaById(event.mediaId)
  const follow = mask && media && media.width > 0 && media.height > 0 ? (
    <label className="te-check" title="On: the shape is part of the picture, so moving, zooming or turning it with Event Pan/Crop (or the preview handles) takes the masked part along. Off: a fixed window over the frame that the picture moves behind.">
      <input
        type="checkbox"
        checked={mask.space === 'picture'}
        onChange={(e) => {
          const state = panCropAt(event.panCrop, sourceTime(event, Math.min(Math.max(cursor, event.start), event.start + event.length - 1)))
          A.setMask(event.id, convertMaskSpace(mask, e.target.checked ? 'picture' : 'frame', state, media.width, media.height, settings.width, settings.height), 'space')
        }}
      />
      Moves with the picture (Pan/Crop)
    </label>
  ) : null
  const of = mask?.space === 'picture' && media ? 'picture' : 'frame'

  const enable = (
    <label className="te-check">
      <input type="checkbox" checked={mask !== null} onChange={(e) => A.setMask(event.id, e.target.checked ? { ...DEFAULT_MASK } : null, 'enable')} />
      Enable mask (outside the shape becomes transparent)
    </label>
  )
  const shapes = mask && (
    <div className="te-control mask-shapes">
      {SHAPES.map(({ id, label, icon: Icon }) => (
        <button key={id} className={`tool-btn labeled${mask.shape === id ? ' active' : ''}`} onClick={() => update({ shape: id }, 'shape')}>
          <Icon size={13} /> {label}
        </button>
      ))}
    </div>
  )
  const invert = mask && (
    <label className="te-check">
      <input type="checkbox" checked={mask.invert} onChange={(e) => update({ invert: e.target.checked }, 'invert')} />
      Invert
    </label>
  )
  const feather = mask && (
    <Slider label="Feather" value={mask.feather} min={0} max={200} step={1} format={(v) => `${v}px`} onChange={(v) => update({ feather: v }, 'feather')} />
  )

  if (mask?.shape === 'custom') {
    return (
      <FloatingWindow key="custom" id="maskCustom" className="pancrop" title="Event Mask" ariaLabel="Event Mask">
        <CustomMaskEditor event={event} mask={mask} settings={settings} cursor={cursor}>
          {enable}
          {shapes}
          <div className="mask-row">
            {invert}
            <label className="te-check">
              <input type="checkbox" checked={mask.smooth} onChange={(e) => update({ smooth: e.target.checked }, 'smooth')} />
              Smooth curve
            </label>
          </div>
          {feather}
        </CustomMaskEditor>
      </FloatingWindow>
    )
  }

  return (
    <FloatingWindow key="shape" id="mask" className="text-editor" title="Event Mask">
      <div className="te-body">
        {enable}
        {mask && (
          <div className="te-grid">
            <label className="te-field">
              <span>Shape</span>
              <div className="te-control">
                {shapes}
                {invert}
              </div>
            </label>
            {follow && (
              <label className="te-field">
                <span />
                <div className="te-control">{follow}</div>
              </label>
            )}
            <Slider label="Center X" value={mask.cx} min={0} max={1} step={0.005} format={pct} onChange={(cx) => update({ cx }, 'cx')} />
            <Slider label="Center Y" value={mask.cy} min={0} max={1} step={0.005} format={pct} onChange={(cy) => update({ cy }, 'cy')} />
            <Slider label="Width" value={mask.w} min={0.02} max={1.5} step={0.005} format={pct} onChange={(w) => update({ w }, 'w')} />
            <Slider label="Height" value={mask.h} min={0.02} max={1.5} step={0.005} format={pct} onChange={(h) => update({ h }, 'h')} />
            {feather}
            <p className="dim">Position and size are fractions of the {of}.</p>
          </div>
        )}
        <p className="dim">
          Tip: put the masked event on a track above another clip for a picture-in-picture or spotlight look. Custom draws any shape
          with points, or cuts out an object with Smart Select and follows it through the clip.
        </p>
      </div>
    </FloatingWindow>
  )
}

// Custom shape editor

type Tool = 'points' | 'smart'

interface ViewMap {
  scale: number
  ox: number
  oy: number
}

/** Screen pixels for grabbing a point, and for inserting one on a side. */
const POINT_RADIUS = 8
const SIDE_RADIUS = 6

const hitCanvas = new OffscreenCanvas(1, 1).getContext('2d') as OffscreenCanvasRenderingContext2D

interface Drag {
  /** Keyframes after the press (with the inserted point, if any). */
  base: EventMask['path']
  /** Point being moved, or -1 for the whole shape. */
  index: number
  from: MaskPoint
  start: MaskPoint[]
}

function CustomMaskEditor({
  event,
  mask,
  settings,
  cursor,
  children
}: {
  event: TimelineEvent
  mask: EventMask
  settings: ProjectSettings
  cursor: Flicks
  children: React.ReactNode
}): React.JSX.Element {
  const media: MediaItem | undefined = event.text ? undefined : mediaById(event.mediaId)
  const canSmart = !!media && !!media.width
  const [tool, setTool] = useState<Tool>(canSmart && (mask.path.length === 0 || mask.smart) ? 'smart' : 'points')
  const [busy, setBusy] = useState<{ label: string; progress: number | null } | null>(null)
  const cancelled = useRef(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewRef = useRef<ViewMap>({ scale: 1, ox: 0, oy: 0 })
  const dragRef = useRef<Drag | null>(null)
  const [, setTick] = useState(0)
  const redraw = useRef(() => setTick((n) => n + 1)).current

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
  const points = pathAt(mask.path, srcTime)
  const px: MaskPoint[] = points.map(([x, y]) => [x * sw, y * sh])
  const keyHere = mask.path.findIndex((k) => Math.abs(k.time - srcTime) < frame / 2)
  const seeds = mask.smart && Math.abs(mask.smart.time - srcTime) < frame / 2 ? mask.smart : null
  const video = useSourceFrame(media, flicksToSeconds(srcTime), redraw)

  /** The mask as it is now in the project (async work may finish after other edits). */
  const latest = (): EventMask => useEditor.getState().project.events.find((e) => e.id === event.id)?.mask ?? mask

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
      const f = frameRect(panCropAt(event.panCrop, srcTime), sw, sh, settings.width, settings.height)
      ctx.save()
      ctx.translate(f.cx, f.cy)
      ctx.rotate((f.rotation * Math.PI) / 180)
      ctx.setLineDash([6 * lw, 4 * lw])
      ctx.strokeStyle = 'rgba(255,255,255,0.45)'
      ctx.lineWidth = lw
      ctx.strokeRect(-f.w / 2, -f.h / 2, f.w, f.h)
      ctx.restore()
    }
    if (px.length >= 3) {
      // Dim what the mask hides.
      const shape = new Path2D()
      tracePath(shape, px, mask.smooth)
      ctx.fillStyle = 'rgba(10,11,13,0.6)'
      if (mask.invert) ctx.fill(shape)
      else {
        const outside = new Path2D()
        outside.rect(-sw, -sh, sw * 3, sh * 3)
        outside.addPath(shape)
        ctx.fill(outside, 'evenodd')
      }
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1.5 * lw
      ctx.stroke(shape)
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
      ctx.fillStyle = keyHere >= 0 || mask.path.length <= 1 ? '#ffffff' : '#9fb8e8'
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
    ctx.restore()

    if (px.length === 0 && !busy) {
      ctx.fillStyle = 'rgba(255,255,255,0.75)'
      ctx.font = '13px "Segoe UI", system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(tool === 'smart' ? 'Click the object to cut out' : 'Click to place the points of the shape', cw / 2, oy + 18)
    }
  })

  /** Pointer position in source pixels. */
  const toSource = (e: { clientX: number; clientY: number }): MaskPoint => {
    const r = (canvasRef.current as HTMLCanvasElement).getBoundingClientRect()
    const { scale, ox, oy } = viewRef.current
    return [(e.clientX - r.left - ox) / scale, (e.clientY - r.top - oy) / scale]
  }
  const toFraction = ([x, y]: MaskPoint): MaskPoint => [x / sw, y / sh]

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
      tracePath(shape, px, mask.smooth)
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

  const pointsDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const p = toSource(e)
    const target = hit(p)
    const remove = e.button === 2 || e.altKey
    if (remove) {
      if (target.kind === 'point') A.replaceMask(event.id, { ...mask, path: removePoint(mask.path, target.index) })
      return
    }
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    if (target.kind === 'point') startDrag(mask.path, target.index, p)
    else if (target.kind === 'side') startDrag(insertPoint(mask.path, srcTime, target.index, toFraction(p), frame / 2), target.index + 1, p)
    else if (target.kind === 'inside') startDrag(mask.path, -1, p)
    else startDrag(insertPoint(mask.path, srcTime, px.length - 1, toFraction(p), frame / 2), px.length, p)
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
    const smart = mask.smart
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

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (busy) return
    if (tool === 'smart') void smartDown(e)
    else pointsDown(e)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (dragRef.current) {
      moveDrag(toSource(e))
      return
    }
    if (tool === 'smart') {
      e.currentTarget.style.cursor = busy ? 'progress' : e.altKey ? 'not-allowed' : 'crosshair'
      return
    }
    const target = hit(toSource(e))
    e.currentTarget.style.cursor =
      target.kind === 'point' ? (e.altKey ? 'not-allowed' : 'grab') : target.kind === 'side' ? 'copy' : target.kind === 'inside' ? 'move' : 'crosshair'
  }

  const onPointerUp = (): void => {
    if (!dragRef.current) return
    dragRef.current = null
    A.endGesture()
  }

  // After a split the Smart Select points may be on a frame of the other part.
  const seedInEvent = !!mask.smart && mask.smart.time >= event.offset && mask.smart.time <= event.offset + sourceLength(event)
  const trackable = media?.kind === 'video' && seedInEvent && (mask.smart?.include.length ?? 0) > 0
  return (
    <div className="pc-body">
      <div className="pc-props">
        {children}
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
                    : mask.smart && !seedInEvent
                      ? 'Pick the object again with Smart Select on a frame of this event'
                      : 'Select an object with Smart Select first'
                }
              >
                Track Motion
              </button>
            )}
            <button
              className="btn small"
              disabled={mask.path.length === 0 && !mask.smart}
              onClick={() => A.replaceMask(event.id, { ...mask, path: [], smart: null })}
              title="Remove every point and keyframe"
            >
              <Eraser size={12} /> Clear
            </button>
          </div>
        )}
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
        <KeyframeBar
          event={event}
          keys={mask.path}
          kind="mask"
          srcTime={srcTime}
          here={keyHere}
          local={local}
          frame={frame}
          frameRate={settings.frameRate}
          onAdd={() => points.length > 0 && A.replaceMask(event.id, { ...mask, path: upsertPathKey(mask.path, { time: srcTime, points }) })}
          onChange={(path) => A.replaceMask(event.id, { ...latest(), path })}
          pasteProblem={(keys) => {
            const count = mask.path[0]?.points.length
            const other = keys.find((k) => count !== undefined && k.points.length !== count)
            return other ? `The copied shape has ${other.points.length} points and this one ${count}: keyframes of a shape need the same points` : null
          }}
        />
      </div>
    </div>
  )
}

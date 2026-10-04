import { useEffect, useRef, useState } from 'react'
import { FloatingWindow } from './FloatingWindow'
import * as A from '../core/actions'
import { mediaById, useEditor } from '../core/store'
import {
  type Ease,
  type PanCropKey,
  type PanCropState,
  fitFrame,
  frameRect,
  framingZoom,
  panCropAt,
  upsertKey
} from '../core/pancrop'
import { type Flicks, flicksToSeconds, frameFlicks } from '../core/time'
import type { MediaItem, TimelineEvent } from '../core/types'
import { sourceTime } from '../core/timeline'
import { imageCache } from '../media/cache'
import { rotateCursor, snapAngle } from './rotateCursor'
import { KeyframeBar, canDraw, useSourceFrame } from './KeyframeBar'
import { themeColor } from './themes'

type Corners = [number, number][]

function corners(f: { cx: number; cy: number; w: number; h: number; rotation: number }): Corners {
  const a = (f.rotation * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1]
  ].map(([sx, sy]) => {
    const dx = (sx * f.w) / 2
    const dy = (sy * f.h) / 2
    return [f.cx + dx * cos - dy * sin, f.cy + dx * sin + dy * cos] as [number, number]
  })
}

interface ViewMap {
  scale: number
  ox: number
  oy: number
}

type DragMode = 'move' | 'scale' | 'rotate'

/** Screen pixels around a corner that scale (on it) or rotate (just outside the frame). */
const SCALE_RADIUS = 10
const ROTATE_RADIUS = 28

/**
 * What a press at source point (x, y) does: on a corner it scales, just outside
 * a corner it rotates, elsewhere it moves. `corner` is the index of the nearest corner.
 */
function hitMode(
  f: { cx: number; cy: number; w: number; h: number; rotation: number },
  x: number,
  y: number,
  viewScale: number
): { mode: DragMode; corner: number } {
  const pts = corners(f)
  let corner = 0
  let best = Infinity
  pts.forEach(([px, py], i) => {
    const d = Math.hypot(px - x, py - y) * viewScale
    if (d < best) {
      best = d
      corner = i
    }
  })
  if (best < SCALE_RADIUS) return { mode: 'scale', corner }
  const a = (-f.rotation * Math.PI) / 180
  const lx = (x - f.cx) * Math.cos(a) - (y - f.cy) * Math.sin(a)
  const ly = (x - f.cx) * Math.sin(a) + (y - f.cy) * Math.cos(a)
  const outside = Math.abs(lx) > f.w / 2 || Math.abs(ly) > f.h / 2
  return { mode: outside && best < ROTATE_RADIUS ? 'rotate' : 'move', corner }
}

function NumberField({
  label,
  value,
  step,
  digits,
  onChange
}: {
  label: string
  value: number
  step: number
  digits: number
  onChange: (v: number) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <label className="pc-field">
      <span>{label}</span>
      <input
        className="input"
        type="number"
        step={step}
        value={draft ?? value.toFixed(digits)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== null && Number.isFinite(Number(draft))) onChange(Number(draft))
          setDraft(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
      />
    </label>
  )
}

export function PanCropDialog({ eventId }: { eventId: string }): React.JSX.Element | null {
  const event = useEditor((s) => s.project.events.find((e) => e.id === eventId))
  const settings = useEditor((s) => s.project.settings)
  const cursor = useEditor((s) => s.cursor)
  const media = event ? mediaById(event.mediaId) : undefined

  useEffect(() => {
    if (!event) A.closeDialog()
  }, [event])

  if (!event || !media) return null
  return <PanCropWindow event={event} media={media} settings={settings} cursor={cursor} />
}

function PanCropWindow({
  event,
  media,
  settings,
  cursor
}: {
  event: TimelineEvent
  media: MediaItem
  settings: { width: number; height: number; frameRate: { num: number; den: number } }
  cursor: Flicks
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewRef = useRef<ViewMap>({ scale: 1, ox: 0, oy: 0 })
  const dragRef = useRef<{
    mode: DragMode
    x: number
    y: number
    start: PanCropState
    dist: number
    /** Rotation: last pointer angle around the frame center and the unwrapped turn so far (radians). */
    angle: number
    turned: number
  } | null>(null)
  const [, setTick] = useState(0)
  const redraw = useRef(() => setTick((n) => n + 1)).current

  // The window can be resized from its corner: redraw the canvases at the new size.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver(() => redraw())
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [redraw])

  const frame = frameFlicks(settings.frameRate)
  const local = Math.min(Math.max(0, cursor - event.start), Math.max(0, event.length - frame))
  const srcTime = sourceTime(event, event.start + local)
  const state = panCropAt(event.panCrop, srcTime)
  const keyHere = event.panCrop.find((k) => Math.abs(k.time - srcTime) < frame / 2)
  const sw = media.width || 1
  const sh = media.height || 1
  const outW = settings.width
  const outH = settings.height
  const video = useSourceFrame(media, flicksToSeconds(srcTime), redraw)

  /** Writes a change at the cursor, creating a keyframe there when the event already animates. */
  const edit = (patch: Partial<PanCropState>): void => {
    const keys = event.panCrop
    const next = { ...state, ...patch }
    let result: PanCropKey[]
    if (keys.length === 0) result = [{ ...next, time: event.offset, ease: 'smooth' }]
    else if (keys.length === 1 && !keyHere) result = [{ ...keys[0], ...patch }]
    else if (keyHere) result = keys.map((k) => (k === keyHere ? { ...k, ...patch } : k))
    else result = upsertKey(keys, { ...next, time: srcTime, ease: 'smooth' })
    A.setPanCropKeys(event.id, result)
  }

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
    const f = frameRect(state, sw, sh, outW, outH)
    const pts = corners(f)
    const xs = [0, sw, ...pts.map((p) => p[0])]
    const ys = [0, sh, ...pts.map((p) => p[1])]
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    const pad = 24
    const scale = Math.min((cw - pad * 2) / (maxX - minX), (ch - pad * 2) / (maxY - minY))
    const ox = (cw - (maxX - minX) * scale) / 2 - minX * scale
    const oy = (ch - (maxY - minY) * scale) / 2 - minY * scale
    viewRef.current = { scale, ox, oy }
    const sx = (x: number): number => ox + x * scale
    const sy = (y: number): number => oy + y * scale

    ctx.fillStyle = themeColor('workspace')
    ctx.fillRect(0, 0, cw, ch)
    const source: CanvasImageSource | null =
      media.kind === 'image' ? (imageCache.get(media.id) ?? null) : canDraw(video) ? video : null
    ctx.fillStyle = '#000'
    ctx.fillRect(sx(0), sy(0), sw * scale, sh * scale)
    if (source) ctx.drawImage(source, sx(0), sy(0), sw * scale, sh * scale)

    // Dim everything outside the frame.
    ctx.beginPath()
    ctx.rect(0, 0, cw, ch)
    ctx.moveTo(sx(pts[0][0]), sy(pts[0][1]))
    for (let i = 1; i < 4; i++) ctx.lineTo(sx(pts[i][0]), sy(pts[i][1]))
    ctx.closePath()
    ctx.fillStyle = 'rgba(10,11,13,0.62)'
    ctx.fill('evenodd')

    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(sx(pts[0][0]), sy(pts[0][1]))
    for (let i = 1; i < 4; i++) ctx.lineTo(sx(pts[i][0]), sy(pts[i][1]))
    ctx.closePath()
    ctx.stroke()
    ctx.fillStyle = '#ffffff'
    for (const [px, py] of pts) ctx.fillRect(sx(px) - 4, sy(py) - 4, 8, 8)

    // The "F" shows the frame orientation.
    ctx.save()
    ctx.translate(sx(f.cx), sy(f.cy))
    ctx.rotate((f.rotation * Math.PI) / 180)
    const size = Math.max(14, Math.min(f.w, f.h) * scale * 0.25)
    ctx.font = `600 ${size}px "Segoe UI", system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = 'rgba(255,255,255,0.35)'
    ctx.fillText('F', 0, 0)
    ctx.restore()
  })

  const toSource = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = canvasRef.current!.getBoundingClientRect()
    const { scale, ox, oy } = viewRef.current
    return [(e.clientX - r.left - ox) / scale, (e.clientY - r.top - oy) / scale]
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const [x, y] = toSource(e)
    const f = frameRect(state, sw, sh, outW, outH)
    A.beginGesture()
    dragRef.current = {
      mode: hitMode(f, x, y, viewRef.current.scale).mode,
      x,
      y,
      start: { ...state },
      dist: Math.max(1, Math.hypot(x - f.cx, y - f.cy)),
      angle: Math.atan2(y - f.cy, x - f.cx),
      turned: 0
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const drag = dragRef.current
    const [x, y] = toSource(e)
    if (!drag) {
      const f = frameRect(state, sw, sh, outW, outH)
      const hit = hitMode(f, x, y, viewRef.current.scale)
      // Corners are listed clockwise from the top left, like the cursor's base angles.
      e.currentTarget.style.cursor =
        hit.mode === 'rotate' ? rotateCursor(hit.corner * 90 + f.rotation) : hit.mode === 'scale' ? 'nwse-resize' : 'move'
      return
    }
    if (drag.mode === 'rotate') {
      const startFrame = frameRect(drag.start, sw, sh, outW, outH)
      const a = Math.atan2(y - startFrame.cy, x - startFrame.cx)
      let step = a - drag.angle
      if (step > Math.PI) step -= Math.PI * 2
      if (step < -Math.PI) step += Math.PI * 2
      drag.turned += step
      drag.angle = a
      edit({ rotation: snapAngle(drag.start.rotation + (drag.turned * 180) / Math.PI, e) })
    } else if (drag.mode === 'move') {
      edit({ cx: drag.start.cx + (x - drag.x) / sw, cy: drag.start.cy + (y - drag.y) / sh })
    } else {
      const startFrame = frameRect(drag.start, sw, sh, outW, outH)
      const ratio = Math.hypot(x - startFrame.cx, y - startFrame.cy) / drag.dist
      edit({ zoom: Math.min(50, Math.max(0.05, drag.start.zoom / Math.max(0.01, ratio))) })
    }
  }

  const onPointerUp = (): void => {
    if (!dragRef.current) return
    dragRef.current = null
    A.endGesture()
  }

  const f = frameRect(state, sw, sh, outW, outH)
  const fill = framingZoom('fill', state.rotation, sw, sh, outW, outH)
  const fit = framingZoom('fit', state.rotation, sw, sh, outW, outH)
  const fitW = fitFrame(sw, sh, outW, outH).w

  return (
    <FloatingWindow id="panCrop" className="pancrop" title={`Event Pan/Crop: ${media.name}`} ariaLabel="Event Pan/Crop">
      <div className="pc-body">
        <div className="pc-props">
          <div className="pc-group">Position</div>
          <NumberField label="Center X" value={state.cx * sw} step={1} digits={1} onChange={(v) => edit({ cx: v / sw })} />
          <NumberField label="Center Y" value={state.cy * sh} step={1} digits={1} onChange={(v) => edit({ cy: v / sh })} />
          <NumberField label="Width" value={f.w} step={1} digits={1} onChange={(v) => v > 0 && edit({ zoom: fitW / v })} />
          <NumberField label="Zoom %" value={state.zoom * 100} step={1} digits={1} onChange={(v) => v > 0 && edit({ zoom: v / 100 })} />
          <NumberField label="Rotation °" value={state.rotation} step={1} digits={1} onChange={(v) => edit({ rotation: v })} />
          <div className="pc-buttons">
            <button className="btn small" onClick={() => edit({ zoom: fill })} title="Crop so the source covers the whole frame">
              Fill frame
            </button>
            <button className="btn small" onClick={() => edit({ zoom: fit, cx: 0.5, cy: 0.5 })} title="Whole source visible (keeps the rotation)">
              Fit
            </button>
            <button className="btn small" onClick={() => edit({ cx: 0.5, cy: 0.5 })}>
              Center
            </button>
            <button className="btn small" onClick={() => A.setPanCropKeys(event.id, [])} title="Remove every keyframe">
              Reset
            </button>
          </div>
          <div className="pc-group">Keyframe at cursor</div>
          {keyHere ? (
            <label className="pc-field" title="How the framing moves from this keyframe to the next one">
              <span>Motion</span>
              <select
                className="select"
                value={keyHere.ease}
                onChange={(e) =>
                  A.setPanCropKeys(
                    event.id,
                    event.panCrop.map((k) => (k === keyHere ? { ...k, ease: e.target.value as Ease } : k))
                  )
                }
              >
                <option value="smooth">Smooth (eases in and out)</option>
                <option value="linear">Linear (steady speed)</option>
                <option value="hold">Hold (jumps at the next)</option>
              </select>
            </label>
          ) : (
            <p className="dim pc-hint">
              No keyframe here. To animate, add one with <b>+◇</b> under the picture at each moment and change the framing:
              Boar moves between them.
            </p>
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
          />
          <KeyframeBar
            event={event}
            keys={event.panCrop.map((k) => k.time)}
            srcTime={srcTime}
            here={keyHere ? event.panCrop.indexOf(keyHere) : -1}
            local={local}
            frame={frame}
            frameRate={settings.frameRate}
            onAdd={() => A.setPanCropKeys(event.id, upsertKey(event.panCrop, { ...state, time: srcTime, ease: keyHere?.ease ?? 'smooth' }))}
            onDelete={() => A.setPanCropKeys(event.id, event.panCrop.filter((k) => k !== keyHere))}
          />
        </div>
      </div>
    </FloatingWindow>
  )
}

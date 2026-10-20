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
  sourceToOutput,
  upsertKey,
  withStretch
} from '../core/pancrop'
import { type MaskPoint, pathAt, shapeOutline } from '../core/mask'
import { type Flicks, flicksToSeconds, frameFlicks } from '../core/time'
import type { MediaItem, TimelineEvent } from '../core/types'
import { sourceTime } from '../core/timeline'
import { imageCache } from '../media/cache'
import { rotateCursor, snapAngle } from './rotateCursor'
import { KeyframeBar, canDraw, useSourceFrame } from './KeyframeBar'
import { themeColor } from './themes'
import { MOD } from '../platform'

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
  /** Canvas size (CSS pixels) the view was fitted to. */
  cw: number
  ch: number
}

type DragMode = 'move' | 'scale' | 'rotate'

/** Shift while moving: the frame follows the pointer this much slower, for precise placement. */
const FINE_DRAG = 0.2
/** Arrow keys move the frame by one output pixel, ten with Shift. */
const NUDGE_PX = 1
const NUDGE_SHIFT_PX = 10
const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }

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

export function NumberField({
  label,
  value,
  step,
  digits,
  title,
  onChange
}: {
  label: string
  value: number
  step: number
  digits: number
  title?: string
  onChange: (v: number) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <label className="pc-field" title={title}>
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
  const viewRef = useRef<ViewMap>({ scale: 1, ox: 0, oy: 0, cw: 0, ch: 0 })
  const dragRef = useRef<{
    mode: DragMode
    x: number
    y: number
    /** Move: last pointer position and the frame center so far (source pixels; Shift slows it down). */
    lastX: number
    lastY: number
    cx: number
    cy: number
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
  // The window shows the picture stretched: the frame lies over it as a rectangle.
  const vw = sw * state.stretch
  const outW = settings.width
  const outH = settings.height
  const video = useSourceFrame(media, flicksToSeconds(srcTime), redraw)

  /**
   * Writes a change at the cursor, creating a keyframe there when the event
   * already animates. Changes with the same `coalesce` key in a row are one undo step.
   */
  const edit = (patch: Partial<PanCropState>, coalesce?: string): void => {
    const keys = event.panCrop
    const next = { ...state, ...patch }
    let result: PanCropKey[]
    if (keys.length === 0) result = [{ ...next, time: event.offset, ease: 'smooth' }]
    else if (keys.length === 1 && !keyHere) result = [{ ...keys[0], ...patch }]
    else if (keyHere) result = keys.map((k) => (k === keyHere ? { ...k, ...patch } : k))
    else result = upsertKey(keys, { ...next, time: srcTime, ease: 'smooth' })
    A.setPanCropKeys(event.id, result, coalesce)
  }

  // Arrow keys move the frame by one output pixel (Shift: ten) while this window
  // was the last thing clicked; with Ctrl or Alt they keep their usual commands.
  const nudgeRef = useRef<(dx: number, dy: number) => void>(() => undefined)
  nudgeRef.current = (dx, dy) => {
    const step = frameRect(state, sw, sh, outW, outH).w / outW
    edit({ cx: state.cx + (dx * step) / vw, cy: state.cy + (dy * step) / sh }, `panCropNudge:${event.id}`)
  }
  useEffect(() => {
    let active = false
    const onPointerDown = (e: PointerEvent): void => {
      const win = canvasRef.current?.closest('.floating-window')
      active = !!win && win.contains(e.target as Node)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (!active || e.ctrlKey || e.metaKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return
      const dir = ARROWS[e.key]
      if (!dir) return
      const px = e.shiftKey ? NUDGE_SHIFT_PX : NUDGE_PX
      nudgeRef.current(dir[0] * px, dir[1] * px)
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [])

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
    const xs = [0, vw, ...pts.map((p) => p[0])]
    const ys = [0, sh, ...pts.map((p) => p[1])]
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    const pad = 24
    const fitScale = Math.min((cw - pad * 2) / (maxX - minX), (ch - pad * 2) / (maxY - minY))
    // The view stays put while the frame is dragged (refitting it under the pointer
    // made a frame larger than the picture run away) and while it still shows
    // everything well; otherwise it fits the picture and the frame again.
    const held = viewRef.current
    const inView =
      held.cw === cw &&
      held.ch === ch &&
      held.scale >= fitScale * 0.75 &&
      held.ox + minX * held.scale >= 0 &&
      held.oy + minY * held.scale >= 0 &&
      held.ox + maxX * held.scale <= cw &&
      held.oy + maxY * held.scale <= ch
    if (!(dragRef.current && held.cw === cw && held.ch === ch) && !inView) {
      viewRef.current = {
        scale: fitScale,
        ox: (cw - (maxX - minX) * fitScale) / 2 - minX * fitScale,
        oy: (ch - (maxY - minY) * fitScale) / 2 - minY * fitScale,
        cw,
        ch
      }
    }
    const { scale, ox, oy } = viewRef.current
    const sx = (x: number): number => ox + x * scale
    const sy = (y: number): number => oy + y * scale

    ctx.fillStyle = themeColor('workspace')
    ctx.fillRect(0, 0, cw, ch)
    const source: CanvasImageSource | null =
      media.kind === 'image' ? (imageCache.get(media.id) ?? null) : canDraw(video) ? video : null
    ctx.fillStyle = '#000'
    ctx.fillRect(sx(0), sy(0), vw * scale, sh * scale)
    if (source) ctx.drawImage(source, sx(0), sy(0), vw * scale, sh * scale)

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

    // The event's mask over the picture: it moves with it (or shows where a frame mask cuts it).
    const mask = event.mask
    if (mask) {
      let outline: MaskPoint[]
      if (mask.shape === 'custom') outline = pathAt(mask.path, srcTime).map(([x, y]) => [x * vw, y * sh])
      else if (mask.space === 'picture') outline = shapeOutline(mask).map(([x, y]) => [x * vw, y * sh])
      else {
        const { inverse } = sourceToOutput(state, sw, sh, outW, outH)
        outline = shapeOutline(mask).map(([x, y]) => {
          const [px, py] = inverse(x * outW, y * outH)
          return [px * state.stretch, py]
        })
      }
      if (outline.length >= 2) {
        ctx.save()
        ctx.setLineDash([5, 4])
        ctx.strokeStyle = '#ff9f43'
        ctx.lineWidth = 1.5
        ctx.beginPath()
        outline.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(sx(x), sy(y)) : ctx.lineTo(sx(x), sy(y))))
        ctx.closePath()
        ctx.stroke()
        ctx.restore()
      }
    }
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
      lastX: x,
      lastY: y,
      cx: f.cx,
      cy: f.cy,
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
      // Step by step, so pressing or releasing Shift mid-drag does not make the frame jump.
      const k = e.shiftKey ? FINE_DRAG : 1
      drag.cx += (x - drag.lastX) * k
      drag.cy += (y - drag.lastY) * k
      drag.lastX = x
      drag.lastY = y
      edit({ cx: drag.cx / vw, cy: drag.cy / sh })
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
    // The view held still during the drag: fit it again if the frame left it.
    redraw()
  }

  const f = frameRect(state, sw, sh, outW, outH)
  const fill = framingZoom('fill', state.rotation, sw, sh, outW, outH, state.stretch)
  const fit = framingZoom('fit', state.rotation, sw, sh, outW, outH, state.stretch)
  const fitW = fitFrame(vw, sh, outW, outH).w

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
          <NumberField
            label="Stretch %"
            title={`Width of the picture against its height: 100 = its own proportions, 200 = twice as wide. In the preview, drag a side handle or ${MOD}+drag a corner`}
            value={state.stretch * 100}
            step={1}
            digits={1}
            onChange={(v) => v > 0 && edit(withStretch(state, v / 100, sw, sh, outW, outH))}
          />
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
          <p className="dim pc-hint">Arrow keys move the frame by 1 pixel (Shift: 10). Shift+drag moves it slowly.</p>
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
            title="Drag to move the frame (Shift: slowly) · corners: size · just outside a corner: rotate · arrow keys: 1 pixel (Shift: 10)"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
          <KeyframeBar
            event={event}
            keys={event.panCrop}
            kind="panCrop"
            srcTime={srcTime}
            here={keyHere ? event.panCrop.indexOf(keyHere) : -1}
            local={local}
            frame={frame}
            frameRate={settings.frameRate}
            onAdd={() => A.setPanCropKeys(event.id, upsertKey(event.panCrop, { ...state, time: srcTime, ease: keyHere?.ease ?? 'smooth' }))}
            onChange={(keys) => A.setPanCropKeys(event.id, keys)}
          />
        </div>
      </div>
    </FloatingWindow>
  )
}

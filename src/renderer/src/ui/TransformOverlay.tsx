import { useEffect, useRef, useState } from 'react'
import * as A from '../core/actions'
import { useEditor } from '../core/store'
import { type PanCropKey, type PanCropState, type PictureBox, normalizeAngle, panCropAt, placeBox, placeSource, stretchBox, upsertKey } from '../core/pancrop'
import { eventBox, imageSize, visibleEvents } from '../core/eventBox'
import { eventEnd, sourceTime } from '../core/timeline'
import { moveShape, shapeFromBox } from '../core/shapes'
import type { Project, TimelineEvent } from '../core/types'
import type { Flicks } from '../core/time'
import { getEngine } from '../engine/preview'
import { CORNER_CURSOR_ANGLE, rotateCursor, snapAngle } from './rotateCursor'
import { MOD } from '../platform'

// Direct manipulation in the Video Preview: the selected text / shape / image /
// video event at the cursor gets a box with handles. Dragging moves it, corners
// scale it, just outside a corner rotates it, the side handles of a text change
// its wrap width. The side handles of a picture stretch it one way (the
// opposite side stays put), and Ctrl+drag on a corner stretches it both ways.
// Rectangles and ellipses resize freely from any side or corner; an arrow has a
// handle on each end. Media events are moved, scaled, stretched and rotated
// through their Event Pan/Crop (a keyframe at the cursor when the event already
// has several), so the export matches exactly.

type Box = PictureBox

/** Pan/Crop state that puts the source center at (cx, cy) with the given zoom, rotation (degrees) and stretch. */
function stateFor(ev: TimelineEvent, cx: number, cy: number, s: Pick<PanCropState, 'zoom' | 'rotation' | 'stretch'>, W: number, H: number): PanCropState {
  const src = imageSize(ev) as { w: number; h: number }
  return placeSource(cx, cy, s.zoom, s.rotation, src.w, src.h, W, H, s.stretch)
}

function keysWith(ev: TimelineEvent, t: Flicks, state: PanCropState): PanCropKey[] {
  if (ev.panCrop.length === 0) return [{ time: ev.offset, ...state, ease: 'smooth' }]
  if (ev.panCrop.length === 1) return [{ ...ev.panCrop[0], ...state }]
  const time = sourceTime(ev, t)
  const existing = ev.panCrop.find((k) => k.time === time)
  return upsertKey(ev.panCrop, { time, ...state, ease: existing?.ease ?? 'smooth' })
}

/** Selected visual events under the cursor, front-most first. */
function editableEvents(project: Project, selection: string[], t: Flicks): TimelineEvent[] {
  const order = new Map(project.tracks.map((tr, i) => [tr.id, i]))
  return project.events
    .filter((e) => selection.includes(e.id) && e.kind === 'video' && e.start <= t && t < eventEnd(e))
    .filter((e) => e.text || e.shape || imageSize(e))
    .sort((a, b) => (order.get(a.trackId) ?? 0) - (order.get(b.trackId) ?? 0))
}

function contains(box: Box, x: number, y: number): boolean {
  const dx = x - box.cx
  const dy = y - box.cy
  const lx = dx * Math.cos(-box.angle) - dy * Math.sin(-box.angle)
  const ly = dx * Math.sin(-box.angle) + dy * Math.cos(-box.angle)
  return Math.abs(lx) <= box.w / 2 && Math.abs(ly) <= box.h / 2
}

type Corner = 'nw' | 'ne' | 'sw' | 'se'
type Side = 'n' | 's' | 'w' | 'e'
type Handle = 'move' | 'rotate' | Corner | Side
const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se']
const SIDES: Side[] = ['n', 's', 'w', 'e']
const SNAP = 0.012
/** Shift on an arrow end: the arrow turns in steps of this many degrees. */
const ARROW_STEP = 15
/** Shift while moving: the picture follows the pointer this much slower. */
const FINE_DRAG = 0.2
const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }

/** Moves the event by (dx, dy) project pixels; nudges in a row are one undo step. */
function nudge(ev: TimelineEvent, t: Flicks, dx: number, dy: number, W: number, H: number): void {
  const b = eventBox(ev, t, W, H)
  if (!b) return
  const state = panCropAt(ev.panCrop, sourceTime(ev, t))
  const keys = ev.text || ev.shape ? null : keysWith(ev, t, stateFor(ev, b.cx + dx, b.cy + dy, state, W, H))
  A.commitCoalesced(`nudge:${ev.id}`, (d) => {
    const draft = d.events.find((o) => o.id === ev.id)
    if (!draft) return
    if (draft.text) {
      draft.text.x += dx / W
      draft.text.y += dy / H
    } else if (draft.shape) Object.assign(draft.shape, moveShape(draft.shape, dx, dy, W, H))
    else if (keys) draft.panCrop = keys
  })
}

/** `width`: displayed width of the preview frame in CSS pixels. */
export function TransformOverlay({ width }: { width: number }): React.JSX.Element | null {
  const project = useEditor((s) => s.project)
  const selection = useEditor((s) => s.selection)
  const cursor = useEditor((s) => s.cursor)
  const playing = useEditor((s) => s.playing)
  const dialog = useEditor((s) => s.dialog)
  const ref = useRef<HTMLDivElement>(null)
  const [guides, setGuides] = useState<{ x: boolean; y: boolean }>({ x: false, y: false })
  const [label, setLabel] = useState<string | null>(null)
  const W = project.settings.width
  const H = project.settings.height
  const k = width / W

  // Arrow keys move the picture by one pixel (Shift: ten) after it was clicked
  // in the preview, until something else is clicked.
  useEffect(() => {
    let active = false
    const onPointerDown = (e: PointerEvent): void => {
      active = !!ref.current && ref.current.contains(e.target as Node)
    }
    const onKey = (e: KeyboardEvent): void => {
      const dir = ARROWS[e.key]
      if (!active || !dir || e.ctrlKey || e.metaKey || e.altKey) return
      const s = useEditor.getState()
      if (s.playing || s.dialog?.kind === 'panCrop') return
      const target = editableEvents(s.project, s.selection, s.cursor)[0]
      if (!target) return
      const px = e.shiftKey ? 10 : 1
      nudge(target, s.cursor, dir[0] * px, dir[1] * px, s.project.settings.width, s.project.settings.height)
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

  if (playing || dialog?.kind === 'panCrop' || width === 0) return null

  const target = editableEvents(project, selection, cursor)[0]
  const box = target ? eventBox(target, cursor, W, H) : null

  /** Pointer position in project pixels. */
  const toProject = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = (ref.current as HTMLDivElement).getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H }
  }

  const startDrag = (e: React.PointerEvent, rendered: TimelineEvent, handle: Handle): void => {
    e.preventDefault()
    e.stopPropagation()
    // The gesture starts from the event as it is now, not as it was at the last render.
    const ev = useEditor.getState().project.events.find((o) => o.id === rendered.id)
    if (!ev) return
    const start = toProject(e)
    const b0 = eventBox(ev, cursor, W, H)
    if (!b0) return
    const text0 = ev.text ? { ...ev.text } : null
    const shape0 = ev.shape ? { ...ev.shape } : null
    const state0 = panCropAt(ev.panCrop, sourceTime(ev, cursor))
    const dist0 = Math.max(4, Math.hypot(start.x - b0.cx, start.y - b0.cy))
    const deg0 = (b0.angle * 180) / Math.PI
    // Rotation: the pointer's angle around the center, unwrapped so it can turn more than once.
    let lastAngle = Math.atan2(start.y - b0.cy, start.x - b0.cx)
    let turned = 0
    // Move: the offset so far, built step by step so Shift can slow it down mid-drag.
    let last = start
    let moved = { x: 0, y: 0 }
    A.beginGesture()
    const move = (pe: PointerEvent): void => {
      const p = toProject(pe)
      let dx = p.x - start.x
      let dy = p.y - start.y
      if (handle === 'move') {
        const f = pe.shiftKey ? FINE_DRAG : 1
        moved = { x: moved.x + (p.x - last.x) * f, y: moved.y + (p.y - last.y) * f }
        last = p
        dx = moved.x
        dy = moved.y
      }
      if (handle === 'rotate') {
        const a = Math.atan2(p.y - b0.cy, p.x - b0.cx)
        let step = a - lastAngle
        if (step > Math.PI) step -= Math.PI * 2
        if (step < -Math.PI) step += Math.PI * 2
        turned += step
        lastAngle = a
        const deg = snapAngle(deg0 + (turned * 180) / Math.PI, pe)
        setLabel(`${normalizeAngle(deg).toFixed(1)}°`)
        A.updateGesture((d) => {
          const draft = d.events.find((o) => o.id === ev.id)
          if (!draft) return
          if (draft.text) draft.text.rotation = normalizeAngle(deg)
          else if (draft.shape) draft.shape.rotation = normalizeAngle(deg)
          else draft.panCrop = keysWith(ev, cursor, stateFor(ev, b0.cx, b0.cy, { ...state0, rotation: -deg }, W, H))
        })
        return
      }
      if (handle === 'move') {
        // Snap the center to the frame center lines (Alt moves freely).
        let snapX = false
        let snapY = false
        if (!pe.altKey) {
          if (Math.abs(b0.cx + dx - W / 2) < W * SNAP) {
            dx = W / 2 - b0.cx
            snapX = true
          }
          if (Math.abs(b0.cy + dy - H / 2) < H * SNAP) {
            dy = H / 2 - b0.cy
            snapY = true
          }
        }
        setGuides({ x: snapX, y: snapY })
        A.updateGesture((d) => {
          const draft = d.events.find((o) => o.id === ev.id)
          if (!draft) return
          if (draft.text && text0) {
            draft.text.x = text0.x + dx / W
            draft.text.y = text0.y + dy / H
          } else if (draft.shape && shape0) {
            Object.assign(draft.shape, moveShape(shape0, dx, dy, W, H))
          } else {
            draft.panCrop = keysWith(ev, cursor, stateFor(ev, b0.cx + dx, b0.cy + dy, state0, W, H))
          }
        })
        return
      }
      if (shape0?.kind === 'arrow') {
        // An end follows the pointer; with Shift the arrow turns in steps around the other end.
        const tip = handle === 'e'
        const fx = (tip ? shape0.x1 : shape0.x2) * W
        const fy = (tip ? shape0.y1 : shape0.y2) * H
        let px = (tip ? shape0.x2 : shape0.x1) * W + dx
        let py = (tip ? shape0.y2 : shape0.y1) * H + dy
        const length = Math.hypot(px - fx, py - fy)
        if (pe.shiftKey) {
          const step = (ARROW_STEP * Math.PI) / 180
          const a = Math.round(Math.atan2(py - fy, px - fx) / step) * step
          px = fx + Math.cos(a) * length
          py = fy + Math.sin(a) * length
        }
        const deg = (Math.atan2(tip ? py - fy : fy - py, tip ? px - fx : fx - px) * 180) / Math.PI
        setLabel(`${Math.round(length)} px · ${normalizeAngle(Math.round(deg * 10) / 10).toFixed(1)}°`)
        A.updateGesture((d) => {
          const draft = d.events.find((o) => o.id === ev.id)
          if (!draft?.shape) return
          if (tip) Object.assign(draft.shape, { x2: px / W, y2: py / H })
          else Object.assign(draft.shape, { x1: px / W, y1: py / H })
        })
        return
      }
      if (shape0) {
        // Rectangles and ellipses: the dragged sides follow the pointer (Shift on a corner keeps the proportions).
        const b = stretchBox(b0, handle, dx, dy, { w: b0.w, h: b0.h }, handle.length === 2 && pe.shiftKey ? 'keep' : 'free')
        setLabel(`${Math.round(b.w)} × ${Math.round(b.h)}`)
        A.updateGesture((d) => {
          const draft = d.events.find((o) => o.id === ev.id)
          if (draft?.shape) Object.assign(draft.shape, shapeFromBox(shape0, b, W, H))
        })
        return
      }
      const src = imageSize(ev)
      const sideHandle = handle === 'n' || handle === 's' || handle === 'w' || handle === 'e'
      if (!text0 && src && (sideHandle || pe.ctrlKey || pe.metaKey)) {
        // Stretch: the dragged sides follow the pointer, the opposite ones stay.
        const b = stretchBox(b0, handle, dx, dy, src, pe.altKey ? 'free' : 'snap')
        setLabel(`${Math.round(b.w)} × ${Math.round(b.h)}${b.snapped ? ' · own proportions' : ''}`)
        A.updateGesture((d) => {
          const draft = d.events.find((o) => o.id === ev.id)
          if (draft) draft.panCrop = keysWith(ev, cursor, placeBox(b.cx, b.cy, b.w, b.h, state0.rotation, src.w, src.h, W, H))
        })
        return
      }
      setLabel(null)
      if (handle === 'w' || handle === 'e') {
        // Side handles of a text: wrap width, keeping the size. Measured along
        // the text's own axis, from its anchor (the center for centered text).
        if (!text0) return
        const along = (p.x - b0.cx) * Math.cos(b0.angle) + (p.y - b0.cy) * Math.sin(b0.angle)
        const anchor = text0.align === 'center' ? 0 : text0.x * W - b0.cx
        const half = Math.abs(along - anchor)
        const widthPx = text0.align === 'center' ? half * 2 : half
        A.updateGesture((d) => {
          const draft = d.events.find((o) => o.id === ev.id)
          if (draft?.text) draft.text.maxWidth = Math.max(0.1, Math.min(1.2, widthPx / W))
        })
        return
      }
      const f = Math.max(0.05, Math.hypot(p.x - b0.cx, p.y - b0.cy) / dist0)
      A.updateGesture((d) => {
        const draft = d.events.find((o) => o.id === ev.id)
        if (!draft) return
        if (draft.text && text0) {
          draft.text.size = Math.max(8, Math.min(800, Math.round(text0.size * f * 10) / 10))
          draft.text.maxWidth = Math.max(0.1, Math.min(1.5, text0.maxWidth * f))
          draft.text.strokeWidth = text0.strokeWidth * f
        } else {
          draft.panCrop = keysWith(ev, cursor, stateFor(ev, b0.cx, b0.cy, { ...state0, zoom: Math.max(0.02, state0.zoom * f) }, W, H))
        }
      })
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setGuides({ x: false, y: false })
      setLabel(null)
      A.endGesture()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /** Click in the preview: select the front-most event under the pointer and start moving it. */
  const onBackgroundDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    const p = toProject(e)
    const hit = visibleEvents(project, cursor).find((ev) => {
      const b = eventBox(ev, cursor, W, H)
      return b && contains(b, p.x, p.y)
    })
    if (!hit) return
    A.selectEvents([hit.id], e.ctrlKey || e.metaKey ? 'toggle' : 'replace')
    startDrag(e, hit, 'move')
  }

  const arrow = target?.shape?.kind === 'arrow'
  const handles: Handle[] = target?.text ? [...CORNERS, 'w', 'e'] : arrow ? ['w', 'e'] : [...CORNERS, ...SIDES]
  const boxDegrees = box ? (box.angle * 180) / Math.PI : 0
  return (
    <div
      ref={ref}
      className="xf-overlay"
      onPointerDown={onBackgroundDown}
      onDoubleClick={(e) => e.target === e.currentTarget && getEngine().togglePlay(false)}
    >
      {guides.x && <div className="xf-guide v" />}
      {guides.y && <div className="xf-guide h" />}
      {target && box && (
        <div
          className="xf-box"
          style={{
            left: (box.cx - box.w / 2) * k,
            top: (box.cy - box.h / 2) * k,
            width: box.w * k,
            height: box.h * k,
            transform: `rotate(${box.angle}rad)`
          }}
          onPointerDown={(e) => e.button === 0 && startDrag(e, target, 'move')}
          onDoubleClick={() =>
            target.text ? A.openTextEditor(target.id) : target.shape ? A.openShapeEditor(target.id) : A.openPanCrop(target.id)
          }
          title={
            target.text
              ? 'Drag to move (Shift: slowly, Alt: no snapping) · arrow keys: 1 pixel (Shift: 10) · corners: scale · sides: wrap width · just outside a corner: rotate (Shift: 15° steps) · double-click: edit'
              : arrow
                ? 'Drag to move (Shift: slowly, Alt: no snapping) · arrow keys: 1 pixel (Shift: 10) · ends: point it (Shift: 15° steps) · double-click: edit'
                : target.shape
                  ? 'Drag to move (Shift: slowly, Alt: no snapping) · arrow keys: 1 pixel (Shift: 10) · sides and corners: resize (Shift on a corner: keep proportions) · just outside a corner: rotate (Shift: 15° steps) · double-click: edit'
                  : `Drag to move (Shift: slowly, Alt: no snapping) · arrow keys: 1 pixel (Shift: 10) · corners: scale (${MOD}: stretch freely) · sides: stretch · just outside a corner: rotate (Shift: 15° steps) · double-click: edit`
          }
        >
          {!arrow && CORNERS.map((c) => (
            <div
              key={`rotate-${c}`}
              className={`xf-rotate ${c}`}
              style={{ cursor: rotateCursor(CORNER_CURSOR_ANGLE[c] + boxDegrees) }}
              onPointerDown={(e) => e.button === 0 && startDrag(e, target, 'rotate')}
            />
          ))}
          {handles.map((h) => (
            <div key={h} className={`xf-handle ${h}${arrow ? ' end' : ''}`} onPointerDown={(e) => e.button === 0 && startDrag(e, target, h)} />
          ))}
        </div>
      )}
      {label && box && (
        <div className="xf-angle" style={{ left: box.cx * k, top: box.cy * k }}>
          {label}
        </div>
      )}
    </div>
  )
}

import { useRef, useState } from 'react'
import * as A from '../core/actions'
import { mediaById, useEditor } from '../core/store'
import { textBounds } from '../core/text'
import { type PanCropKey, type PanCropState, normalizeAngle, panCropAt, placeSource, sourcePlacement, upsertKey } from '../core/pancrop'
import { eventEnd, sourceTime } from '../core/timeline'
import type { Project, TimelineEvent } from '../core/types'
import type { Flicks } from '../core/time'
import { getEngine } from '../engine/preview'
import { CORNER_CURSOR_ANGLE, rotateCursor, snapAngle } from './rotateCursor'

// Direct manipulation in the Video Preview: the selected text / image / video
// event at the cursor gets a box with handles. Dragging moves it, corners scale
// it, just outside a corner rotates it, the side handles of a text change its
// wrap width. Media events are moved, scaled and rotated through their Event
// Pan/Crop (a keyframe at the cursor when the event already has several), so
// the export matches exactly.

interface Box {
  /** Center and size in project pixels, rotation in radians (clockwise). */
  cx: number
  cy: number
  w: number
  h: number
  angle: number
}

const imageSize = (ev: TimelineEvent): { w: number; h: number } | null => {
  const m = mediaById(ev.mediaId)
  return m && m.width && m.height ? { w: m.width, h: m.height } : null
}

function mediaBox(ev: TimelineEvent, t: Flicks, W: number, H: number): Box | null {
  const src = imageSize(ev)
  if (!src) return null
  const state = panCropAt(ev.panCrop, sourceTime(ev, t))
  const at = sourcePlacement(state, src.w, src.h, W, H)
  return { cx: at.x, cy: at.y, w: src.w * at.scale, h: src.h * at.scale, angle: (-state.rotation * Math.PI) / 180 }
}

function eventBox(ev: TimelineEvent, t: Flicks, W: number, H: number): Box | null {
  if (ev.text) {
    const b = textBounds(ev.text, W, H)
    return { cx: b.left + b.width / 2, cy: b.top + b.height / 2, w: b.width, h: b.height, angle: (ev.text.rotation * Math.PI) / 180 }
  }
  return mediaBox(ev, t, W, H)
}

/** Pan/Crop state that puts the source center at (cx, cy) with the given zoom and rotation (degrees). */
function stateFor(ev: TimelineEvent, cx: number, cy: number, zoom: number, rotation: number, W: number, H: number): PanCropState {
  const src = imageSize(ev) as { w: number; h: number }
  return placeSource(cx, cy, zoom, rotation, src.w, src.h, W, H)
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
    .filter((e) => e.text || imageSize(e))
    .sort((a, b) => (order.get(a.trackId) ?? 0) - (order.get(b.trackId) ?? 0))
}

/** Every visual event at t, front-most first (click-to-select in the preview). */
function visibleEvents(project: Project, t: Flicks): TimelineEvent[] {
  const order = new Map(project.tracks.map((tr, i) => [tr.id, i]))
  const hidden = new Set(project.tracks.filter((tr) => tr.muted).map((tr) => tr.id))
  return project.events
    .filter((e) => e.kind === 'video' && !hidden.has(e.trackId) && e.start <= t && t < eventEnd(e))
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
type Handle = 'move' | 'rotate' | Corner | 'w' | 'e'
const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se']
const SNAP = 0.012

/** `width`: displayed width of the preview frame in CSS pixels. */
export function TransformOverlay({ width }: { width: number }): React.JSX.Element | null {
  const project = useEditor((s) => s.project)
  const selection = useEditor((s) => s.selection)
  const cursor = useEditor((s) => s.cursor)
  const playing = useEditor((s) => s.playing)
  const dialog = useEditor((s) => s.dialog)
  const ref = useRef<HTMLDivElement>(null)
  const [guides, setGuides] = useState<{ x: boolean; y: boolean }>({ x: false, y: false })
  const [angleLabel, setAngleLabel] = useState<string | null>(null)
  const W = project.settings.width
  const H = project.settings.height
  const k = width / W
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
    const state0 = panCropAt(ev.panCrop, sourceTime(ev, cursor))
    const dist0 = Math.max(4, Math.hypot(start.x - b0.cx, start.y - b0.cy))
    const deg0 = (b0.angle * 180) / Math.PI
    // Rotation: the pointer's angle around the center, unwrapped so it can turn more than once.
    let lastAngle = Math.atan2(start.y - b0.cy, start.x - b0.cx)
    let turned = 0
    A.beginGesture()
    const move = (pe: PointerEvent): void => {
      const p = toProject(pe)
      let dx = p.x - start.x
      let dy = p.y - start.y
      if (handle === 'rotate') {
        const a = Math.atan2(p.y - b0.cy, p.x - b0.cx)
        let step = a - lastAngle
        if (step > Math.PI) step -= Math.PI * 2
        if (step < -Math.PI) step += Math.PI * 2
        turned += step
        lastAngle = a
        const deg = snapAngle(deg0 + (turned * 180) / Math.PI, pe)
        setAngleLabel(`${normalizeAngle(deg).toFixed(1)}°`)
        A.updateGesture((d) => {
          const draft = d.events.find((o) => o.id === ev.id)
          if (!draft) return
          if (draft.text) draft.text.rotation = normalizeAngle(deg)
          else draft.panCrop = keysWith(ev, cursor, stateFor(ev, b0.cx, b0.cy, state0.zoom, -deg, W, H))
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
          } else {
            draft.panCrop = keysWith(ev, cursor, stateFor(ev, b0.cx + dx, b0.cy + dy, state0.zoom, state0.rotation, W, H))
          }
        })
        return
      }
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
          draft.panCrop = keysWith(ev, cursor, stateFor(ev, b0.cx, b0.cy, Math.max(0.02, state0.zoom * f), state0.rotation, W, H))
        }
      })
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setGuides({ x: false, y: false })
      setAngleLabel(null)
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

  const handles: Handle[] = target?.text ? [...CORNERS, 'w', 'e'] : CORNERS
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
          onDoubleClick={() => (target.text ? A.openTextEditor(target.id) : A.openPanCrop(target.id))}
          title="Drag to move (Alt: no snapping) · corners: scale · just outside a corner: rotate (Shift: 15° steps) · double-click: edit"
        >
          {CORNERS.map((c) => (
            <div
              key={`rotate-${c}`}
              className={`xf-rotate ${c}`}
              style={{ cursor: rotateCursor(CORNER_CURSOR_ANGLE[c] + boxDegrees) }}
              onPointerDown={(e) => e.button === 0 && startDrag(e, target, 'rotate')}
            />
          ))}
          {handles.map((h) => (
            <div key={h} className={`xf-handle ${h}`} onPointerDown={(e) => e.button === 0 && startDrag(e, target, h)} />
          ))}
        </div>
      )}
      {angleLabel && box && (
        <div className="xf-angle" style={{ left: box.cx * k, top: box.cy * k }}>
          {angleLabel}
        </div>
      )}
    </div>
  )
}

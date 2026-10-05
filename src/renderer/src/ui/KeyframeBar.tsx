import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Diamond, Minus, Plus } from 'lucide-react'
import * as A from '../core/actions'
import { type Flicks, type FrameRate, formatTimecode } from '../core/time'
import type { MediaItem, TimelineEvent } from '../core/types'
import { sourceLength, timelineTime } from '../core/timeline'
import { previewUrl } from '../media/proxy'
import { MOD } from '../platform'
import { themeColor } from './themes'

// Shared by the keyframed tool windows (Event Pan/Crop, Event Mask): the
// source picture at the cursor and the keyframe bar under the workspace.

/** Elements that decoded a frame once: while a seek decodes the next one they still draw the last. */
const decoded = new WeakSet<HTMLVideoElement>()

/** A frame of the element can be drawn (the last one while it seeks, instead of black). */
export const canDraw = (video: HTMLVideoElement | null): video is HTMLVideoElement =>
  !!video && (video.readyState >= 2 || decoded.has(video))

/** Keeps a muted video element on the frame a tool window is showing. */
export function useSourceFrame(media: MediaItem | undefined, seconds: number, onFrame: () => void): HTMLVideoElement | null {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null)
  useEffect(() => {
    if (!media || media.kind !== 'video') return
    const el = document.createElement('video')
    el.muted = true
    el.preload = 'auto'
    el.src = previewUrl(media)
    setVideo(el)
    return () => {
      el.removeAttribute('src')
      el.load()
      setVideo(null)
    }
  }, [media])
  useEffect(() => {
    if (!video) return
    const done = (): void => {
      decoded.add(video)
      onFrame()
    }
    video.addEventListener('seeked', done)
    video.addEventListener('loadeddata', done)
    if (Math.abs(video.currentTime - seconds) > 0.001) video.currentTime = seconds + 0.001
    return () => {
      video.removeEventListener('seeked', done)
      video.removeEventListener('loadeddata', done)
    }
  }, [video, seconds, onFrame])
  return video
}

interface KeyBase {
  time: Flicks
}

type KeyKind = 'panCrop' | 'mask'

interface Props<K extends KeyBase> {
  event: TimelineEvent
  /** The keyframes, sorted by source time. */
  keys: readonly K[]
  /** Keyframes are copied and pasted between windows of the same kind. */
  kind: KeyKind
  /** Source time at the cursor. */
  srcTime: Flicks
  /** Index in `keys` of the keyframe at the cursor (-1: none). */
  here: number
  /** Cursor position within the event (timeline flicks from its start); the bar shows the project time, like the preview. */
  local: Flicks
  /** One frame, in flicks. */
  frame: Flicks
  frameRate: FrameRate
  onAdd: () => void
  /** Replaces every keyframe (delete, move, paste); a drag runs inside a gesture, so it is one undo step. */
  onChange: (keys: K[]) => void
  /** Why copied keyframes cannot be pasted here (a mask shape with another number of points), or null. */
  pasteProblem?: (keys: readonly K[]) => string | null
}

/** Copied keyframes, times counted from the first one (source time). */
let copied: { kind: KeyKind; keys: KeyBase[] } | null = null

/** The keys with `added` put in, replacing any at the same times, sorted. */
function mergeKeys<K extends KeyBase>(keys: readonly K[], added: readonly K[]): K[] {
  const times = new Set(added.map((k) => k.time))
  return [...keys.filter((k) => !times.has(k.time)), ...added].sort((a, b) => a.time - b.time)
}

/** Grab distance of a keyframe on the bar, in px. */
const KEY_RADIUS = 7

type BarDrag =
  | { kind: 'seek' }
  | { kind: 'keys'; x0: number; base: KeyBase[]; times: Flicks[]; grabbed: Flicks; moved: boolean }

const plural = (n: number): string => `${n} keyframe${n === 1 ? '' : 's'}`

/**
 * Previous / add / delete / next keyframe, and a bar to seek within the event
 * that shows the keyframes. Click a keyframe to select it (Ctrl+click adds
 * more, Shift+click a range), drag to move the selected ones. While the
 * window is in use, Delete removes them, Ctrl+C / Ctrl+X copy them, Ctrl+V
 * pastes them at the cursor (also into another event) and Ctrl+A selects all.
 */
export function KeyframeBar<K extends KeyBase>({
  event,
  keys,
  kind,
  srcTime,
  here,
  local,
  frame,
  frameRate,
  onAdd,
  onChange,
  pasteProblem
}: Props<K>): React.JSX.Element {
  const barRef = useRef<HTMLCanvasElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<BarDrag | null>(null)
  const anchorRef = useRef<Flicks | null>(null)
  /** The window was the last place clicked: Delete and Ctrl+C / V go to its keyframes. */
  const activeRef = useRef(false)
  const [picked, setPicked] = useState<Flicks[]>([])
  // Also in a ref: a key pressed right after a click sees the new selection.
  const pickedRef = useRef<Flicks[]>([])
  const pick = (times: Flicks[]): void => {
    pickedRef.current = times
    setPicked(times)
  }
  const srcLength = sourceLength(event)
  const selected = new Set(picked.filter((t) => keys.some((k) => k.time === t)))
  pickedRef.current = pickedRef.current.filter((t) => keys.some((k) => k.time === t))

  const toX = (t: Flicks, w: number): number => 8 + ((t - event.offset) / Math.max(1, srcLength)) * (w - 16)

  useEffect(() => {
    const canvas = barRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = themeColor('sunken')
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = themeColor('line')
    ctx.fillRect(0, h / 2 - 1, w, 2)
    keys.forEach((key, i) => {
      if (key.time < event.offset - frame || key.time > event.offset + srcLength + frame) return
      const on = selected.has(key.time)
      const size = on ? 12 : 10
      ctx.save()
      ctx.translate(toX(key.time, w), h / 2)
      ctx.rotate(Math.PI / 4)
      ctx.fillStyle = on ? '#ff9f43' : i === here ? '#ffcf70' : '#9fb8e8'
      ctx.fillRect(-size / 2, -size / 2, size, size)
      if (on) {
        ctx.strokeStyle = '#ffffff'
        ctx.lineWidth = 1.5
        ctx.strokeRect(-size / 2, -size / 2, size, size)
      }
      ctx.restore()
    })
    const cx = Math.round(toX(srcTime, w)) + 0.5
    ctx.strokeStyle = '#ff6161'
    ctx.beginPath()
    ctx.moveTo(cx, 0)
    ctx.lineTo(cx, h)
    ctx.stroke()
  })

  // Keyboard: while this window is in use, Delete and Ctrl+C / X / V / A act on the keyframes.
  const latest = useRef({ keys, srcTime, onChange, pasteProblem, kind, pick })
  latest.current = { keys, srcTime, onChange, pasteProblem, kind, pick }
  useEffect(() => {
    const onPointerDown = (e: PointerEvent): void => {
      const win = rootRef.current?.closest('.floating-window')
      activeRef.current = !!win && win.contains(e.target as Node)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (!activeRef.current) return
      const target = e.target as HTMLElement | null
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return
      const { keys, srcTime, onChange, pasteProblem, kind, pick } = latest.current
      const selected = new Set(pickedRef.current)
      const ctrl = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      const chosen = keys.filter((k) => selected.has(k.time))
      const remove = (): void => {
        onChange(keys.filter((k) => !selected.has(k.time)))
        pick([])
      }
      const copy = (): void => {
        const first = chosen[0].time
        copied = { kind, keys: chosen.map((k) => ({ ...structuredClone(k), time: k.time - first })) }
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !ctrl && chosen.length > 0) {
        remove()
        A.setStatus(`Deleted ${plural(chosen.length)}`)
      } else if (ctrl && !e.shiftKey && key === 'c' && chosen.length > 0) {
        copy()
        A.setStatus(`Copied ${plural(chosen.length)}: ${MOD}+V pastes them at the cursor`)
      } else if (ctrl && !e.shiftKey && key === 'x' && chosen.length > 0) {
        copy()
        remove()
        A.setStatus(`Cut ${plural(chosen.length)}`)
      } else if (ctrl && !e.shiftKey && key === 'v' && copied?.kind === kind) {
        const pasted = copied.keys.map((k) => ({ ...structuredClone(k), time: srcTime + k.time })) as unknown as K[]
        const problem = pasteProblem?.(pasted)
        if (problem) A.setStatus(problem)
        else {
          onChange(mergeKeys(keys, pasted))
          pick(pasted.map((k) => k.time))
          A.setStatus(`Pasted ${plural(pasted.length)} at the cursor`)
        }
      } else if (ctrl && !e.shiftKey && key === 'a' && keys.length > 0) {
        pick(keys.map((k) => k.time))
      } else return
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

  const seek = (clientX: number): void => {
    const r = (barRef.current as HTMLCanvasElement).getBoundingClientRect()
    const fraction = Math.min(1, Math.max(0, (clientX - r.left - 8) / (r.width - 16)))
    A.setCursor(event.start + Math.round(fraction * event.length))
  }

  /** Index of the keyframe under the pointer, or -1. */
  const keyAt = (clientX: number): number => {
    const r = (barRef.current as HTMLCanvasElement).getBoundingClientRect()
    let best = -1
    let bestD = KEY_RADIUS
    keys.forEach((k, i) => {
      const d = Math.abs(toX(k.time, r.width) - (clientX - r.left))
      if (d <= bestD) {
        best = i
        bestD = d
      }
    })
    return best
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const i = keyAt(e.clientX)
    const ctrl = e.ctrlKey || e.metaKey
    if (i < 0) {
      if (!ctrl && !e.shiftKey) pick([])
      dragRef.current = { kind: 'seek' }
      seek(e.clientX)
      return
    }
    const t = keys[i].time
    const now = new Set(pickedRef.current)
    if (ctrl) {
      pick(now.has(t) ? [...now].filter((o) => o !== t) : [...now, t])
      anchorRef.current = t
      dragRef.current = null
      return
    }
    let times: Flicks[]
    if (e.shiftKey && anchorRef.current !== null) {
      const lo = Math.min(anchorRef.current, t)
      const hi = Math.max(anchorRef.current, t)
      times = keys.filter((k) => k.time >= lo && k.time <= hi).map((k) => k.time)
    } else {
      times = now.has(t) ? [...now] : [t]
      anchorRef.current = t
    }
    pick(times)
    A.setCursor(timelineTime(event, t))
    dragRef.current = { kind: 'keys', x0: e.clientX, base: keys.map((k) => ({ ...k })), times, grabbed: t, moved: false }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const drag = dragRef.current
    if (!drag) {
      e.currentTarget.style.cursor = keyAt(e.clientX) >= 0 ? 'ew-resize' : 'text'
      return
    }
    if (drag.kind === 'seek') {
      if (e.buttons === 1) seek(e.clientX)
      return
    }
    if (!drag.moved) {
      if (Math.abs(e.clientX - drag.x0) < 3) return
      drag.moved = true
      A.beginGesture()
    }
    // By whole frames, without leaving the event.
    const r = e.currentTarget.getBoundingClientRect()
    const step = Math.max(1, Math.round(frame * event.rate))
    let delta = Math.round((((e.clientX - drag.x0) / Math.max(1, r.width - 16)) * srcLength) / step) * step
    const first = Math.min(...drag.times)
    const last = Math.max(...drag.times)
    delta = Math.min(Math.max(0, event.offset + srcLength - last), Math.max(Math.min(0, event.offset - first), delta))
    const moving = new Set(drag.times)
    const base = drag.base as K[]
    const moved = base.filter((k) => moving.has(k.time)).map((k) => ({ ...k, time: k.time + delta }))
    onChange(mergeKeys(base.filter((k) => !moving.has(k.time)), moved))
    pick(drag.times.map((t) => t + delta))
    A.setCursor(timelineTime(event, drag.grabbed + delta))
  }

  const onPointerUp = (): void => {
    const drag = dragRef.current
    dragRef.current = null
    if (drag?.kind === 'keys' && drag.moved) A.endGesture()
  }

  const jump = (direction: 1 | -1): void => {
    const inside = keys.map((k) => k.time).filter((t) => t >= event.offset && t <= event.offset + srcLength)
    const target =
      direction > 0 ? inside.find((t) => t > srcTime + frame / 2) : [...inside].reverse().find((t) => t < srcTime - frame / 2)
    if (target !== undefined) A.setCursor(timelineTime(event, target))
  }

  const deleteKeys = (): void => {
    if (selected.size > 0) {
      onChange(keys.filter((k) => !selected.has(k.time)))
      pick([])
    } else if (here >= 0) onChange(keys.filter((_, i) => i !== here))
  }

  return (
    <div className="pc-keys" ref={rootRef}>
      <button className="tool-btn" title="Previous keyframe" onClick={() => jump(-1)}>
        <ChevronLeft size={14} />
      </button>
      <button className="tool-btn" title="Add keyframe at cursor" onClick={onAdd}>
        <Plus size={13} />
        <Diamond size={11} />
      </button>
      <button
        className="tool-btn"
        title={selected.size > 0 ? `Delete the selected ${plural(selected.size)} (Del)` : 'Delete keyframe at cursor'}
        disabled={here < 0 && selected.size === 0}
        onClick={deleteKeys}
      >
        <Minus size={13} />
        <Diamond size={11} />
      </button>
      <button className="tool-btn" title="Next keyframe" onClick={() => jump(1)}>
        <ChevronRight size={14} />
      </button>
      <canvas
        ref={barRef}
        className="pc-bar"
        title={`Click a keyframe to select it (${MOD}+click: more, Shift+click: a range), drag to move it. Del deletes, ${MOD}+C / ${MOD}+V copy and paste at the cursor`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      <span className="pc-time" title="Project time at the cursor, as in the preview">
        {formatTimecode(event.start + local, frameRate)}
      </span>
    </div>
  )
}

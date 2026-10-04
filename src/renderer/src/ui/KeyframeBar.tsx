import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Diamond, Minus, Plus } from 'lucide-react'
import * as A from '../core/actions'
import { type Flicks, type FrameRate, formatTimecode } from '../core/time'
import type { MediaItem, TimelineEvent } from '../core/types'
import { sourceLength, timelineTime } from '../core/timeline'
import { previewUrl } from '../media/proxy'
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

interface Props {
  event: TimelineEvent
  /** Source times of the keyframes. */
  keys: readonly Flicks[]
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
  onDelete: () => void
}

/** Previous / add / delete / next keyframe, and a bar to seek within the event that shows the keyframes. */
export function KeyframeBar({ event, keys, srcTime, here, local, frame, frameRate, onAdd, onDelete }: Props): React.JSX.Element {
  const barRef = useRef<HTMLCanvasElement>(null)
  const srcLength = sourceLength(event)

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
    const toX = (t: Flicks): number => 8 + ((t - event.offset) / Math.max(1, srcLength)) * (w - 16)
    keys.forEach((time, i) => {
      if (time < event.offset - frame || time > event.offset + srcLength + frame) return
      ctx.save()
      ctx.translate(toX(time), h / 2)
      ctx.rotate(Math.PI / 4)
      ctx.fillStyle = i === here ? '#ffcf70' : '#9fb8e8'
      ctx.fillRect(-5, -5, 10, 10)
      ctx.restore()
    })
    const cx = Math.round(toX(srcTime)) + 0.5
    ctx.strokeStyle = '#ff6161'
    ctx.beginPath()
    ctx.moveTo(cx, 0)
    ctx.lineTo(cx, h)
    ctx.stroke()
  })

  const seek = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    const fraction = Math.min(1, Math.max(0, (e.clientX - r.left - 8) / (r.width - 16)))
    A.setCursor(event.start + Math.round(fraction * event.length))
  }

  const jump = (direction: 1 | -1): void => {
    const inside = keys.filter((t) => t >= event.offset && t <= event.offset + srcLength)
    const target =
      direction > 0 ? inside.find((t) => t > srcTime + frame / 2) : [...inside].reverse().find((t) => t < srcTime - frame / 2)
    if (target !== undefined) A.setCursor(timelineTime(event, target))
  }

  return (
    <div className="pc-keys">
      <button className="tool-btn" title="Previous keyframe" onClick={() => jump(-1)}>
        <ChevronLeft size={14} />
      </button>
      <button className="tool-btn" title="Add keyframe at cursor" onClick={onAdd}>
        <Plus size={13} />
        <Diamond size={11} />
      </button>
      <button className="tool-btn" title="Delete keyframe at cursor" disabled={here < 0} onClick={onDelete}>
        <Minus size={13} />
        <Diamond size={11} />
      </button>
      <button className="tool-btn" title="Next keyframe" onClick={() => jump(1)}>
        <ChevronRight size={14} />
      </button>
      <canvas
        ref={barRef}
        className="pc-bar"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          seek(e)
        }}
        onPointerMove={(e) => e.buttons === 1 && seek(e)}
      />
      <span className="pc-time" title="Project time at the cursor, as in the preview">
        {formatTimecode(event.start + local, frameRate)}
      </span>
    </div>
  )
}

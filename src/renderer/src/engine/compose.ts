import { mediaById } from '../core/store'
import { drawPanCropped, panCropAt, sourceToOutput } from '../core/pancrop'
import { drawText } from '../core/text'
import { type Flicks, flicksToSeconds, frameFlicks } from '../core/time'
import { eventsOnTrack, sourceTime, videoAlpha } from '../core/timeline'
import type { Project, TimelineEvent } from '../core/types'
import { imageCache } from '../media/cache'
import { type EventMask, type MaskPoint, maskCanvas, pathAt } from '../core/mask'
import { activeFx } from '../core/fx'
import { applyTransition, applyVideoFx } from './videoFx'
import { personMask } from './vision'
import { type ActiveTransition, transitionAt } from '../core/transitions'

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export interface FrameSource {
  source: CanvasImageSource
  width: number
  height: number
}

/** Supplies the decoded picture of a video event for the frame being composed. */
export type FrameLookup = (event: TimelineEvent) => FrameSource | null

/**
 * Composites the video tracks at time t. Shared by the preview and the export
 * so that what you see is what gets rendered.
 */
export function composeFrame(
  ctx: Ctx2D,
  layer: Ctx2D,
  project: Project,
  autoCrossfade: boolean,
  t: Flicks,
  width: number,
  height: number,
  frameFor: FrameLookup
): void {
  ctx.globalAlpha = 1
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, width, height)
  const videoTracks = project.tracks.filter((tr) => tr.kind === 'video')
  const anySolo = videoTracks.some((tr) => tr.solo)
  // Tracks are listed top to bottom; the top track is composited last (in front).
  for (let i = videoTracks.length - 1; i >= 0; i--) {
    const track = videoTracks[i]
    if (track.muted || (anySolo && !track.solo) || track.level <= 0) continue
    const trackEvents = eventsOnTrack(project, track.id)
    const active = trackEvents.filter((e) => e.start <= t && t < e.start + e.length)
    if (active.length === 0) continue
    layer.clearRect(0, 0, width, height)
    let drew = false
    const transition = transitionAt(trackEvents, t, frameFlicks(project.settings.frameRate) / 2)
    if (transition && drawTransition(layer, transition, t, width, height, frameFor)) drew = true
    for (const ev of active) {
      if (transition && (ev === transition.from || ev === transition.to)) continue
      const alpha = videoAlpha(ev, t, trackEvents, autoCrossfade)
      if (alpha > 0 && drawEvent(layer, ev, t, width, height, alpha, frameFor)) drew = true
    }
    if (!drew) continue
    ctx.globalAlpha = track.level
    ctx.drawImage(layer.canvas, 0, 0)
    ctx.globalAlpha = 1
  }
}

let scratch: OffscreenCanvas | null = null
const transitionCanvases: OffscreenCanvas[] = []

function transitionCanvas(i: number, width: number, height: number): OffscreenCanvasRenderingContext2D {
  let c = transitionCanvases[i]
  if (!c || c.width !== width || c.height !== height) transitionCanvases[i] = c = new OffscreenCanvas(width, height)
  const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D
  ctx.clearRect(0, 0, width, height)
  return ctx
}

/** Draws both sides of a transition (each with its own FX and mask) and mixes them on the GPU. */
function drawTransition(
  ctx: Ctx2D,
  tr: ActiveTransition,
  t: Flicks,
  width: number,
  height: number,
  frameFor: FrameLookup
): boolean {
  const a = transitionCanvas(0, width, height)
  if (!drawEvent(a, tr.from, t, width, height, tr.from.gain, frameFor)) return false
  let b = a
  if (tr.to !== tr.from) {
    b = transitionCanvas(1, width, height)
    if (!drawEvent(b, tr.to, t, width, height, tr.to.gain, frameFor)) b = a
  }
  const out = applyTransition(a.canvas, b.canvas, tr.type, tr.p, width, height)
  ctx.drawImage(out ?? (tr.p < 0.5 ? a.canvas : b.canvas), 0, 0)
  return true
}

/**
 * Events with Video FX or a mask are drawn on a scratch canvas first, run
 * through the effects, cut by the mask, then composited.
 */
function drawEvent(
  ctx: Ctx2D,
  ev: TimelineEvent,
  t: Flicks,
  width: number,
  height: number,
  alpha: number,
  frameFor: FrameLookup
): boolean {
  const fx = activeFx(ev.fx, 'video')
  if (!ev.mask && fx.length === 0) return drawEventContent(ctx, ev, t, width, height, alpha, frameFor)
  if (!scratch || scratch.width !== width || scratch.height !== height) scratch = new OffscreenCanvas(width, height)
  const s = scratch.getContext('2d') as OffscreenCanvasRenderingContext2D
  s.clearRect(0, 0, width, height)
  if (!drawEventContent(s, ev, t, width, height, 1, frameFor)) return false
  let out: CanvasImageSource = scratch
  const local = flicksToSeconds(t - ev.start)
  // Remove Background needs where the person is in this frame.
  const mask = fx.some((f) => f.type === 'removeBg') ? personMask(scratch, ev.id, local) : null
  const processed = fx.length > 0 ? applyVideoFx(scratch, fx, width, height, local, mask) : null
  if (processed) out = processed
  if (ev.mask) {
    if (processed) {
      s.clearRect(0, 0, width, height)
      s.drawImage(processed, 0, 0)
    }
    s.globalCompositeOperation = 'destination-in'
    const points = ev.mask.shape === 'custom' ? customMaskPoints(ev, ev.mask, t, width, height) : undefined
    s.drawImage(maskCanvas(ev.mask, width, height, points), 0, 0)
    s.globalCompositeOperation = 'source-over'
    out = scratch
  }
  ctx.globalAlpha = alpha
  ctx.drawImage(out, 0, 0)
  ctx.globalAlpha = 1
  return true
}

/** A custom mask's shape at t, placed in the output frame (pixels) through the event's Pan/Crop. */
function customMaskPoints(ev: TimelineEvent, mask: EventMask, t: Flicks, width: number, height: number): MaskPoint[] {
  const time = sourceTime(ev, t)
  const points = pathAt(mask.path, time)
  // Text has no source picture: its shape is drawn over the frame itself.
  if (ev.text) return points.map(([x, y]) => [x * width, y * height])
  const media = mediaById(ev.mediaId)
  if (!media?.width || !media.height) return []
  const { map } = sourceToOutput(panCropAt(ev.panCrop, time), media.width, media.height, width, height)
  return points.map(([x, y]) => map(x * media.width, y * media.height))
}

function drawEventContent(
  ctx: Ctx2D,
  ev: TimelineEvent,
  t: Flicks,
  width: number,
  height: number,
  alpha: number,
  frameFor: FrameLookup
): boolean {
  if (ev.text) {
    drawText(ctx, ev.text, width, height, alpha, {
      t: flicksToSeconds(t - ev.start),
      length: flicksToSeconds(ev.length),
      origin: flicksToSeconds(ev.offset)
    })
    return true
  }
  const media = mediaById(ev.mediaId)
  if (!media) return false
  let frame: FrameSource | null = null
  if (media.kind === 'image') {
    const bitmap = imageCache.get(media.id)
    if (bitmap) frame = { source: bitmap, width: bitmap.width, height: bitmap.height }
  } else {
    frame = frameFor(ev)
  }
  if (!frame || !frame.width || !frame.height) return false
  ctx.globalAlpha = alpha
  drawPanCropped(ctx, frame.source, frame.width, frame.height, width, height, panCropAt(ev.panCrop, sourceTime(ev, t)))
  ctx.globalAlpha = 1
  return true
}

import { mediaById } from './store'
import { textBounds } from './text'
import { type PictureBox, panCropAt, sourcePlacement } from './pancrop'
import { eventEnd, sourceTime } from './timeline'
import { shapeBox } from './shapes'
import { type SafeSide, type SafeZoneSpec, coveredSides, fillsFrame } from './safeZones'
import type { Project, TimelineEvent } from './types'
import type { Flicks } from './time'

/** The size of an event's picture, when its media is known. */
export const imageSize = (ev: TimelineEvent): { w: number; h: number } | null => {
  const m = mediaById(ev.mediaId)
  return m && m.width && m.height ? { w: m.width, h: m.height } : null
}

function mediaBox(ev: TimelineEvent, t: Flicks, W: number, H: number): PictureBox | null {
  const src = imageSize(ev)
  if (!src) return null
  const state = panCropAt(ev.panCrop, sourceTime(ev, t))
  const at = sourcePlacement(state, src.w, src.h, W, H)
  return { cx: at.x, cy: at.y, w: at.w, h: at.h, angle: (-state.rotation * Math.PI) / 180 }
}

/** Where a text, shape or picture event sits in a W x H frame at time t. */
export function eventBox(ev: TimelineEvent, t: Flicks, W: number, H: number): PictureBox | null {
  if (ev.text) {
    const b = textBounds(ev.text, W, H)
    return { cx: b.left + b.width / 2, cy: b.top + b.height / 2, w: b.width, h: b.height, angle: (ev.text.rotation * Math.PI) / 180 }
  }
  if (ev.shape) return shapeBox(ev.shape, W, H)
  return mediaBox(ev, t, W, H)
}

/** Every visual event at t, front-most first. */
export function visibleEvents(project: Project, t: Flicks): TimelineEvent[] {
  const order = new Map(project.tracks.map((tr, i) => [tr.id, i]))
  const hidden = new Set(project.tracks.filter((tr) => tr.muted).map((tr) => tr.id))
  return project.events
    .filter((e) => e.kind === 'video' && !hidden.has(e.trackId) && e.start <= t && t < eventEnd(e))
    .sort((a, b) => (order.get(a.trackId) ?? 0) - (order.get(b.trackId) ?? 0))
}

/**
 * Texts, shapes and pictures at t that reach into the areas an app covers
 * (backgrounds that fill the frame are left out).
 */
export function coveredEvents(
  project: Project,
  t: Flicks,
  spec: SafeZoneSpec
): { event: TimelineEvent; box: PictureBox; sides: SafeSide[] }[] {
  const { width: W, height: H } = project.settings
  const out: { event: TimelineEvent; box: PictureBox; sides: SafeSide[] }[] = []
  for (const event of visibleEvents(project, t)) {
    const box = eventBox(event, t, W, H)
    if (!box || (!event.text && !event.shape && fillsFrame(box, W, H))) continue
    const sides = coveredSides(box, spec, W, H)
    if (sides.length) out.push({ event, box, sides })
  }
  return out
}

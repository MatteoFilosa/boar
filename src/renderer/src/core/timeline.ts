import type { Flicks } from './time'
import type { Project, TimelineEvent, VolumePoint } from './types'
import { fadeShape } from './fades'

export const eventEnd = (e: TimelineEvent): Flicks => e.start + e.length

/** Source (media) time shown at timeline time t, following the playback rate. */
export const sourceTime = (e: TimelineEvent, t: Flicks): Flicks => e.offset + Math.round((t - e.start) * e.rate)

/** Timeline time at which source time `src` plays. */
export const timelineTime = (e: TimelineEvent, src: Flicks): Flicks => e.start + Math.round((src - e.offset) / e.rate)

/** How much of the media the event plays. */
export const sourceLength = (e: TimelineEvent): Flicks => Math.round(e.length * e.rate)

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

export function projectEnd(p: Project): Flicks {
  let end = 0
  for (const e of p.events) end = Math.max(end, eventEnd(e))
  return end
}

const byStart = (a: TimelineEvent, b: TimelineEvent): number =>
  a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

const trackIndexCache = new WeakMap<TimelineEvent[], Map<string, TimelineEvent[]>>()
const NO_EVENTS: TimelineEvent[] = []

/** Events grouped per track and sorted by start. Cached per events array (immutable updates). */
export function eventsByTrack(p: Project): Map<string, TimelineEvent[]> {
  let index = trackIndexCache.get(p.events)
  if (!index) {
    index = new Map()
    for (const e of p.events) {
      let list = index.get(e.trackId)
      if (!list) index.set(e.trackId, (list = []))
      list.push(e)
    }
    for (const list of index.values()) list.sort(byStart)
    trackIndexCache.set(p.events, index)
  }
  return index
}

export const eventsOnTrack = (p: Project, trackId: string): TimelineEvent[] =>
  eventsByTrack(p).get(trackId) ?? NO_EVENTS

const isEarlier = (o: TimelineEvent, e: TimelineEvent): boolean => byStart(o, e) < 0

/** Overlap with an earlier event on the same track: the automatic crossfade into `e`. */
export function crossfadeIn(e: TimelineEvent, trackEvents: TimelineEvent[]): Flicks {
  let overlap = 0
  for (const o of trackEvents) {
    if (o === e || !isEarlier(o, e)) continue
    const end = eventEnd(o)
    if (end > e.start) overlap = Math.max(overlap, Math.min(end, eventEnd(e)) - e.start)
  }
  return overlap
}

/** Overlap with a later event on the same track: the automatic crossfade out of `e`. */
export function crossfadeOut(e: TimelineEvent, trackEvents: TimelineEvent[]): Flicks {
  let overlap = 0
  const end = eventEnd(e)
  for (const o of trackEvents) {
    if (o === e || !isEarlier(e, o)) continue
    if (o.start < end) overlap = Math.max(overlap, Math.min(end, eventEnd(o)) - o.start)
  }
  return overlap
}

/**
 * Opacity of a video event at time t. In a crossfade the earlier event stays
 * opaque and the later one dissolves in on top of it.
 */
export function videoAlpha(
  e: TimelineEvent,
  t: Flicks,
  trackEvents: TimelineEvent[],
  autoCrossfade: boolean
): number {
  const local = t - e.start
  const remain = eventEnd(e) - t
  const xIn = autoCrossfade ? crossfadeIn(e, trackEvents) : 0
  let a = e.gain
  // A crossfade longer than the event's own fade dissolves linearly.
  if (xIn > e.fadeIn && local < xIn) a *= local / xIn
  else if (e.fadeIn > 0 && local < e.fadeIn) a *= fadeShape(e.fadeInCurve, local / e.fadeIn)
  if (e.fadeOut > 0 && remain < e.fadeOut) a *= fadeShape(e.fadeOutCurve, remain / e.fadeOut)
  return clamp01(a)
}

/** Envelope gain at a source time (linear between points, flat outside). */
export function envelopeAt(points: readonly VolumePoint[], time: Flicks): number {
  if (points.length === 0) return 1
  if (time <= points[0].time) return points[0].gain
  const last = points[points.length - 1]
  if (time >= last.time) return last.gain
  let i = 0
  while (i < points.length - 2 && points[i + 1].time <= time) i++
  const a = points[i]
  const b = points[i + 1]
  return a.gain + ((b.gain - a.gain) * (time - a.time)) / Math.max(1, b.time - a.time)
}

/** Gain of an audio event at time t. Crossfades use equal-power curves. */
export function audioGain(
  e: TimelineEvent,
  t: Flicks,
  trackEvents: TimelineEvent[],
  autoCrossfade: boolean
): number {
  const local = t - e.start
  const remain = eventEnd(e) - t
  const xIn = autoCrossfade ? crossfadeIn(e, trackEvents) : 0
  const xOut = autoCrossfade ? crossfadeOut(e, trackEvents) : 0
  let g = e.gain * envelopeAt(e.envelope, sourceTime(e, t))
  if (xIn > 0 && local < xIn) g *= Math.sin(((local / xIn) * Math.PI) / 2)
  else if (e.fadeIn > 0 && local < e.fadeIn) g *= fadeShape(e.fadeInCurve, local / e.fadeIn)
  if (xOut > 0 && remain < xOut) g *= Math.sin(((remain / xOut) * Math.PI) / 2)
  else if (e.fadeOut > 0 && remain < e.fadeOut) g *= fadeShape(e.fadeOutCurve, remain / e.fadeOut)
  return Math.max(0, g)
}

export function snapPoints(p: Project, cursor: Flicks, exclude: Set<string>): Flicks[] {
  const points: Flicks[] = [0, cursor]
  for (const m of p.markers) points.push(m.time)
  for (const e of p.events) if (!exclude.has(e.id)) points.push(e.start, eventEnd(e))
  return points
}

/** Smallest correction that puts one of `edges` on one of `points`, within `threshold`. */
export function findSnap(
  edges: Flicks[],
  points: Flicks[],
  threshold: Flicks
): { delta: Flicks; at: Flicks } | null {
  let best: { delta: Flicks; at: Flicks } | null = null
  for (const edge of edges) {
    for (const point of points) {
      const delta = point - edge
      if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta))) {
        best = { delta, at: point }
      }
    }
  }
  return best
}

/** Event edges and markers, sorted and unique: targets for Ctrl+Left/Right. */
export function editPoints(p: Project): Flicks[] {
  const set = new Set<Flicks>([0])
  for (const e of p.events) {
    set.add(e.start)
    set.add(eventEnd(e))
  }
  for (const m of p.markers) set.add(m.time)
  return [...set].sort((a, b) => a - b)
}

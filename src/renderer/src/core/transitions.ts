import type { Flicks } from './time'
import type { TimelineEvent } from './types'
import { secondsToFlicks } from './time'

// A transition sits at the start of an event (`transition`) or at its end
// (`transitionOut`). Where two events overlap, the whole overlap is the
// transition (outgoing -> incoming) instead of the plain crossfade. On a plain
// cut it is centered on the cut: the end of the outgoing event and the start of
// the incoming one each play half of it (zoom punch, whip pan...), so adding
// one never changes the edit's timing. At the start or end of an event with
// nothing next to it, the event comes in (or goes out) with the effect: the
// second (or first) half of it, stretched over the whole length.
// A transition between two events always belongs to the start of the second
// one; `transitionOut` only counts where nothing follows (or as a fallback when
// events were moved together).

export interface EventTransition {
  type: string
  duration: Flicks
}

export type TransitionSide = 'in' | 'out'

export interface TransitionDef {
  type: string
  label: string
  description: string
}

export const TRANSITIONS: TransitionDef[] = [
  { type: 'zoomIn', label: 'Zoom In', description: 'Punch in through the cut' },
  { type: 'zoomOut', label: 'Zoom Out', description: 'Pull back through the cut' },
  { type: 'whipLeft', label: 'Whip Pan Left', description: 'Fast blurred pan to the left' },
  { type: 'whipRight', label: 'Whip Pan Right', description: 'Fast blurred pan to the right' },
  { type: 'whipUp', label: 'Whip Pan Up', description: 'Fast blurred pan upward' },
  { type: 'whipDown', label: 'Whip Pan Down', description: 'Fast blurred pan downward' },
  { type: 'spin', label: 'Spin', description: 'Rotating zoom' },
  { type: 'glitch', label: 'Glitch', description: 'Digital glitch burst' },
  { type: 'flash', label: 'Flash', description: 'Flash to white' },
  { type: 'dipBlack', label: 'Dip to Black', description: 'Fade through black' },
  { type: 'blur', label: 'Blur', description: 'Blur out and back in' },
  { type: 'pixelate', label: 'Pixelate', description: 'Big pixels at the cut' }
]

export const transitionDef = (type: string): TransitionDef | undefined => TRANSITIONS.find((t) => t.type === type)
export const transitionLabel = (type: string): string => transitionDef(type)?.label ?? type

/** Default length on a cut between two events. */
export const DEFAULT_TRANSITION_LENGTH = secondsToFlicks(0.5)
/** Default length at the start or end of an event with nothing next to it. */
export const DEFAULT_EDGE_TRANSITION_LENGTH = secondsToFlicks(1)

export type TransitionMode = 'overlap' | 'cut' | 'in' | 'out'

/** A transition placed on the timeline: what plays, where, and where it is stored. */
export interface TransitionSpan {
  /** The event that holds it and on which side (the second event's start between two events). */
  eventId: string
  side: TransitionSide
  type: string
  mode: TransitionMode
  start: Flicks
  end: Flicks
  /** null = no event on that side (start or end of an event with nothing next to it). */
  from: TimelineEvent | null
  to: TimelineEvent | null
}

export interface ActiveTransition {
  from: TimelineEvent
  to: TimelineEvent
  type: string
  /** 0..1 */
  p: number
}

const end = (e: TimelineEvent): Flicks => e.start + e.length

/**
 * The event that leads into list[i] (events of one track sorted by start):
 * the latest earlier one that reaches its start. `adjacency` is how close two
 * events must be to count as a cut.
 */
export function previousEvent(list: readonly TimelineEvent[], i: number, adjacency: Flicks): TimelineEvent | null {
  const b = list[i]
  for (let j = i - 1; j >= 0; j--) {
    if (end(list[j]) >= b.start - adjacency) return list[j]
  }
  return null
}

/** The event list[i] leads into, if any (the one whose previous event it is). */
export function nextEvent(list: readonly TimelineEvent[], i: number, adjacency: Flicks): TimelineEvent | null {
  const a = list[i]
  for (let j = i + 1; j < list.length; j++) {
    if (list[j].start > end(a) + adjacency) break
    if (previousEvent(list, j, adjacency) === a) return list[j]
  }
  return null
}

function junction(
  a: TimelineEvent,
  b: TimelineEvent,
  tr: EventTransition,
  adjacency: Flicks
): TransitionSpan | null {
  const overlap = Math.min(end(a), end(b)) - b.start
  const base = { eventId: b.id, side: 'in' as const, type: tr.type, from: a, to: b }
  if (overlap > adjacency) return { ...base, mode: 'overlap', start: b.start, end: b.start + overlap }
  const half = Math.min(tr.duration / 2, a.length, b.length)
  if (half <= 0) return null
  return { ...base, mode: 'cut', start: b.start - half, end: b.start + half }
}

const spanCache = new WeakMap<readonly TimelineEvent[], { adjacency: Flicks; spans: TransitionSpan[] }>()
const NONE: TransitionSpan[] = []

/** Every transition on a track (events sorted by start), sorted by start. */
export function transitionSpans(list: readonly TimelineEvent[], adjacency: Flicks): TransitionSpan[] {
  if (!list.some((e) => e.transition || e.transitionOut)) return NONE
  const cached = spanCache.get(list)
  if (cached && cached.adjacency === adjacency) return cached.spans
  const spans: TransitionSpan[] = []
  for (let i = 0; i < list.length; i++) {
    const e = list[i]
    const prev = previousEvent(list, i, adjacency)
    const into = e.transition ?? prev?.transitionOut ?? null
    if (into && prev) {
      const span = junction(prev, e, into, adjacency)
      if (span) spans.push(span)
    } else if (into) {
      const d = Math.min(into.duration, e.length)
      if (d > 0) spans.push({ eventId: e.id, side: 'in', type: into.type, mode: 'in', start: e.start, end: e.start + d, from: null, to: e })
    }
    if (e.transitionOut && !nextEvent(list, i, adjacency)) {
      const d = Math.min(e.transitionOut.duration, e.length)
      if (d > 0) {
        spans.push({ eventId: e.id, side: 'out', type: e.transitionOut.type, mode: 'out', start: end(e) - d, end: end(e), from: e, to: null })
      }
    }
  }
  spans.sort((a, b) => a.start - b.start)
  spanCache.set(list, { adjacency, spans })
  return spans
}

/** The transition playing at time t on a track (events sorted by start), if any. */
export function transitionAt(list: readonly TimelineEvent[], t: Flicks, adjacency: Flicks): ActiveTransition | null {
  for (const s of transitionSpans(list, adjacency)) {
    if (s.start > t) break
    if (t >= s.end) continue
    const p = (t - s.start) / (s.end - s.start)
    if (s.mode === 'overlap' && s.from && s.to) return { from: s.from, to: s.to, type: s.type, p }
    if (s.mode === 'in' && s.to) return { from: s.to, to: s.to, type: s.type, p: 0.5 + p / 2 }
    if (s.mode === 'out' && s.from) return { from: s.from, to: s.from, type: s.type, p: p / 2 }
    // Centered on a cut: each side plays its half alone.
    const side = s.to && t >= s.to.start ? s.to : s.from
    if (side) return { from: side, to: side, type: s.type, p }
  }
  return null
}

/** Where a transition is kept: an event's side, and the event before it when they meet. */
export interface TransitionSlot {
  event: TimelineEvent
  side: TransitionSide
  prev: TimelineEvent | null
}

/**
 * Where a transition for one side of list[i] is kept: the end of an event
 * that leads into another is the start of that one.
 */
export function transitionSlot(list: readonly TimelineEvent[], i: number, side: TransitionSide, adjacency: Flicks): TransitionSlot {
  if (side === 'out') {
    const next = nextEvent(list, i, adjacency)
    if (!next) return { event: list[i], side: 'out', prev: null }
    return { event: next, side: 'in', prev: list[i] }
  }
  return { event: list[i], side: 'in', prev: previousEvent(list, i, adjacency) }
}

/** The transition kept in a slot (between two events it may still sit on the end of the first). */
export function slotTransition(slot: TransitionSlot): EventTransition | null {
  if (slot.side === 'out') return slot.event.transitionOut
  return slot.event.transition ?? slot.prev?.transitionOut ?? null
}

/** Default length for a new transition in a slot: shorter on a cut, longer from or to nothing. */
export function defaultTransitionLength(slot: TransitionSlot): Flicks {
  return slot.side === 'in' && slot.prev ? DEFAULT_TRANSITION_LENGTH : DEFAULT_EDGE_TRANSITION_LENGTH
}

/**
 * The transition target under time t on event list[i] when one is dropped
 * there: the overlap with the previous event, else the half of the event.
 */
export function dropSide(list: readonly TimelineEvent[], i: number, t: Flicks, adjacency: Flicks): TransitionSide {
  const e = list[i]
  const prev = previousEvent(list, i, adjacency)
  if (prev && t < Math.min(end(prev), end(e))) return 'in'
  return t < e.start + e.length / 2 ? 'in' : 'out'
}

/** Where a transition would play once set in one side of list[i] (drop preview). */
export function previewSpan(
  list: readonly TimelineEvent[],
  i: number,
  side: TransitionSide,
  type: string,
  adjacency: Flicks
): TransitionSpan | null {
  const slot = transitionSlot(list, i, side, adjacency)
  const current = slotTransition(slot)
  const tr: EventTransition = { type, duration: current?.duration ?? defaultTransitionLength(slot) }
  const key = slot.side === 'in' ? 'transition' : 'transitionOut'
  const next = list.map((e) => (e === slot.event ? { ...e, [key]: tr } : e))
  const spans = transitionSpans(next, adjacency)
  return spans.find((s) => s.eventId === slot.event.id && s.side === slot.side) ?? null
}

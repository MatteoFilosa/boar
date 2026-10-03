import type { Flicks } from './time'
import type { TimelineEvent } from './types'
import { secondsToFlicks } from './time'

// Transitions are stored on the incoming event. Where two events overlap, the
// overlap is the transition (outgoing -> incoming). On a plain cut the
// transition is centered on the cut: the end of the outgoing event and the
// start of the incoming one each play half of it (zoom punch, whip pan...), so
// adding one never changes the edit's timing.

export interface EventTransition {
  type: string
  duration: Flicks
}

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
export const DEFAULT_TRANSITION_LENGTH = secondsToFlicks(0.5)

export interface ActiveTransition {
  from: TimelineEvent
  to: TimelineEvent
  type: string
  /** 0..1 */
  p: number
}

/**
 * The transition playing at time t on a track (events sorted by start), if
 * any. `adjacency` is how close two events must be to count as a cut.
 */
export function transitionAt(trackEvents: TimelineEvent[], t: Flicks, adjacency: Flicks): ActiveTransition | null {
  for (let i = 0; i < trackEvents.length; i++) {
    const b = trackEvents[i]
    const tr = b.transition
    if (!tr || tr.duration <= 0) continue
    const half = tr.duration / 2
    if (t < b.start - half || t > b.start + tr.duration) continue
    // Outgoing event: the latest earlier one that reaches the incoming start.
    let a: TimelineEvent | null = null
    for (let j = i - 1; j >= 0; j--) {
      const o = trackEvents[j]
      if (o.start + o.length >= b.start - adjacency) {
        a = o
        break
      }
    }
    const overlap = a ? a.start + a.length - b.start : 0
    if (a && overlap > adjacency) {
      if (t >= b.start && t < b.start + overlap) return { from: a, to: b, type: tr.type, p: (t - b.start) / overlap }
      continue
    }
    if (t < b.start - half || t >= b.start + half) continue
    const p = (t - (b.start - half)) / tr.duration
    if (t < b.start) return a ? { from: a, to: a, type: tr.type, p } : null
    return { from: b, to: b, type: tr.type, p }
  }
  return null
}

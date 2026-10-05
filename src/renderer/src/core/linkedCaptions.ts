import type { Project, TimelineEvent } from './types'
import type { MediaTranscript } from './transcript'
import { type Flicks, FLICKS_PER_SECOND, frameFlicks, quantizeToFrame, secondsToFlicks } from './time'
import { sourceLength, timelineTime } from './timeline'
import { type CaptionWord, type TextContent, splitWords } from './text'
import { uid } from './ids'

// Captions follow the clips they caption. Caption words made from a transcript
// remember which word of which file they are (CaptionWord.src); when an edit
// cuts, trims, moves or deletes the clips, every such caption is laid back
// over its words: it moves with them, shrinks when some are cut out (they
// leave its text too), splits when its words end up apart and goes away with
// the last one. A caption the user nudged keeps its nudge. Runs inside each
// undoable change (core/actions.ts), so the edit and the captions are one
// undo step.

interface Heard {
  eventId: string
  start: Flicks
  end: Flicks
}

/** The clips of one file, sorted by source in-point, and the longest source span among them. */
interface MediaClips {
  clips: TimelineEvent[]
  span: Flicks
}

/** Clips by media id (events that play a file, text excluded). */
function clipsByMedia(events: readonly TimelineEvent[]): Map<string, MediaClips> {
  const out = new Map<string, MediaClips>()
  for (const e of events) {
    if (e.text || !e.mediaId) continue
    const entry = out.get(e.mediaId)
    if (entry) entry.clips.push(e)
    else out.set(e.mediaId, { clips: [e], span: 0 })
  }
  for (const entry of out.values()) {
    entry.clips.sort((a, b) => a.offset - b.offset)
    entry.span = Math.max(...entry.clips.map(sourceLength))
  }
  return out
}

/** Where a transcript word is heard on the timeline: once per clip that plays its middle (like wordsOnTimeline). */
function heard(media: MediaClips | undefined, word: CaptionWord): Heard[] {
  if (!media) return []
  const middle = secondsToFlicks((word.start + word.end) / 2)
  const { clips, span } = media
  // The first clip that starts after the word; only clips before it, and not too far back, can play it.
  let lo = 0
  let hi = clips.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (clips[mid].offset <= middle) lo = mid + 1
    else hi = mid
  }
  const out: Heard[] = []
  for (let i = lo - 1; i >= 0 && clips[i].offset + span > middle; i--) {
    const e = clips[i]
    if (middle >= e.offset + sourceLength(e)) continue
    out.push({
      eventId: e.id,
      start: Math.max(e.start, timelineTime(e, secondsToFlicks(word.start))),
      end: Math.min(e.start + e.length, timelineTime(e, secondsToFlicks(word.end)))
    })
  }
  return out
}

function closest(list: Heard[], t: Flicks): Heard | null {
  let best: Heard | null = null
  for (const h of list) if (!best || Math.abs(h.start - t) < Math.abs(best.start - t)) best = h
  return best
}

const isLinked = (e: TimelineEvent): boolean => !!e.text?.words?.some((w) => w.src)

/** Start, length, source in-point and rate of every clip, by id. */
function clipTiming(events: readonly TimelineEvent[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const e of events) if (!e.text && e.mediaId) out.set(e.id, `${e.mediaId}:${e.start}:${e.length}:${e.offset}:${e.rate}`)
  return out
}

function sameTiming(a: readonly TimelineEvent[], b: readonly TimelineEvent[]): boolean {
  if (a === b) return true
  const before = clipTiming(a)
  const after = clipTiming(b)
  if (before.size !== after.size) return false
  for (const [id, key] of before) if (after.get(id) !== key) return false
  return true
}

/**
 * `next` with its linked captions laid over their words again, when the edit
 * from `base` changed where the clips play. Returns `next` itself when there
 * is nothing to do.
 */
export function followClips(
  base: Project,
  next: Project,
  transcripts: Record<string, MediaTranscript>,
  quantize: boolean
): Project {
  if (base === next || base.events === next.events) return next
  if (!next.events.some(isLinked) || sameTiming(base.events, next.events)) return next
  return relayCaptions(base, next, transcripts, quantize)
}

/** Two words that end up this much further apart (seconds) than they were go to separate captions. */
const SPLIT_GAP = 0.5

/** Works on plain objects (drafts would make every read slow): changed captions are new objects. */
function relayCaptions(base: Project, next: Project, transcripts: Record<string, MediaTranscript>, quantize: boolean): Project {
  const rate = next.settings.frameRate
  const frame = frameFlicks(rate)
  const before = clipsByMedia(base.events)
  const after = clipsByMedia(next.events)
  const baseById = new Map(base.events.map((e) => [e.id, e]))
  const replaced = new Map<string, TimelineEvent[]>()

  /** The caption placed from `start` to `end` (frames, never shorter than one). */
  const placed = (c: TimelineEvent, start: Flicks, end: Flicks, patch: Partial<TimelineEvent>): TimelineEvent => {
    if (quantize) {
      start = quantizeToFrame(start, rate)
      end = quantizeToFrame(end, rate)
    }
    start = Math.max(0, start)
    if (end - start < frame) end = start + frame
    const length = end - start
    const fadeIn = Math.min(c.fadeIn, length)
    return { ...c, ...patch, start, length, fadeIn, fadeOut: Math.min(c.fadeOut, length - fadeIn) }
  }

  for (const c of next.events) {
    const words = c.text?.words
    if (!c.text || !words || !words.some((w) => w.src)) continue
    const old = baseById.get(c.id)
    // A piece made by this very change (a split) is already where the change put it.
    const fresh = !old?.text
    const ref = old?.text ? old : c
    const originB = ref.start - ref.offset
    const shownB = (seconds: number): Flicks => originB + secondsToFlicks(seconds)
    // The caption's own words are those inside its window (both halves of a split caption keep every word).
    const from = c.offset / FLICKS_PER_SECOND
    const to = (c.offset + c.length) / FLICKS_PER_SECOND
    const own = (w: CaptionWord): boolean => (w.start + w.end) / 2 >= from && (w.start + w.end) / 2 < to
    const where = words.map((w) => {
      const tw = w.src ? transcripts[w.src[0]]?.words[w.src[1]] : undefined
      if (!w.src || !tw) return null
      const was = closest(heard(before.get(w.src[0]), tw), shownB(w.start))
      if (!was) return null
      const now = heard(after.get(w.src[0]), tw)
      return { was, now: now.find((h) => h.eventId === was.eventId) ?? closest(now, was.start) }
    })
    const ownAt = words.map((w, i) => (own(w) ? i : -1)).filter((i) => i >= 0)
    const linkedOwn = ownAt.filter((i) => where[i])
    const keptOwn = linkedOwn.filter((i) => where[i]?.now)
    // Words that were heard and are not any more: cut out of the speech.
    const lost = new Set(words.map((_, i) => i).filter((i) => where[i] && !where[i]?.now))
    if (keptOwn.length === 0) {
      // Nothing it shows is heard any more (a piece left over by a cut, or every
      // word cut out), unless it shows words typed by the user.
      if (ownAt.length === 0 ? words.every((w) => w.src) : linkedOwn.length === ownAt.length) replaced.set(c.id, [])
      continue
    }
    const tokens = splitWords(c.text.text)
    // Words leave the text only while it still matches the words one to one.
    const aligned = tokens.length === words.length
    const at = (i: number): Heard => where[i]?.now as Heard
    const was = (i: number): Heard => where[i]?.was as Heard

    if (fresh) {
      if (aligned && lost.size > 0) {
        const text = { ...c.text, text: tokens.filter((_, i) => !lost.has(i)).join(' '), words: words.filter((_, i) => !lost.has(i)) }
        replaced.set(c.id, [{ ...c, text }])
      }
      continue
    }

    // Runs of words that stay together; words moved apart (or out of order) start another caption.
    const runs: number[][] = [[keptOwn[0]]]
    for (let k = 1; k < keptOwn.length; k++) {
      const a = keptOwn[k - 1]
      const b = keptOwn[k]
      const grew = at(b).start - at(a).end - (was(b).start - was(a).end)
      if (aligned && (at(b).start < at(a).start || grew > secondsToFlicks(SPLIT_GAP))) runs.push([b])
      else runs[runs.length - 1].push(b)
    }
    const winStartB = originB + c.offset
    const winEndB = winStartB + c.length
    // Lead-in before the first word and tail after the last (pauses bridged, or the user's nudge) are kept.
    const lead = was(linkedOwn[0]).start - winStartB
    const tail = winEndB - was(linkedOwn[linkedOwn.length - 1]).end

    if (runs.length === 1) {
      const start = at(keptOwn[0]).start - lead
      const end = at(keptOwn[keptOwn.length - 1]).end + tail
      const shift = start - winStartB
      const origin = start - c.offset
      const relative = (t: Flicks): number => (t - origin) / FLICKS_PER_SECOND
      let retimed: CaptionWord[] = words.map((w, i) => {
        const now = where[i]?.now
        return { ...w, start: relative(now ? now.start : shownB(w.start) + shift), end: relative(now ? now.end : shownB(w.end) + shift) }
      })
      let text = c.text.text
      if (aligned && lost.size > 0) {
        text = tokens.filter((_, i) => !lost.has(i)).join(' ')
        retimed = retimed.filter((_, i) => !lost.has(i))
      }
      const same =
        Math.abs(start - c.start) < 2 &&
        Math.abs(end - (c.start + c.length)) < 2 &&
        text === c.text.text &&
        retimed.length === words.length &&
        retimed.every((w, i) => Math.abs(w.start - words[i].start) < 1e-4 && Math.abs(w.end - words[i].end) < 1e-4)
      if (!same) replaced.set(c.id, [placed(c, start, end, { text: { ...c.text, text, words: retimed } })])
      continue
    }

    // Split: each run becomes a caption with its own words (typed words between them included).
    replaced.set(
      c.id,
      runs.map((run, r) => {
        const first = run[0]
        const last = run[run.length - 1]
        const start = at(first).start - (r === 0 ? lead : 0)
        const end = at(last).end + (r === runs.length - 1 ? tail : 0)
        const shift = at(first).start - was(first).start
        const indices = words.map((_, i) => i).filter((i) => i >= first && i <= last && !lost.has(i))
        const absolute = (i: number, edge: 'start' | 'end'): Flicks => where[i]?.now?.[edge] ?? shownB(words[i][edge]) + shift
        const origin = Math.max(0, quantize ? quantizeToFrame(start, rate) : start)
        const text = {
          ...structuredClone(c.text as TextContent),
          text: indices.map((i) => tokens[i]).join(' '),
          words: indices.map((i) => ({
            ...words[i],
            start: (absolute(i, 'start') - origin) / FLICKS_PER_SECOND,
            end: (absolute(i, 'end') - origin) / FLICKS_PER_SECOND
          }))
        }
        const piece = r === 0 ? c : { ...structuredClone(c), id: uid() }
        return placed(piece, start, end, { offset: 0, text })
      })
    )
  }

  if (replaced.size === 0) return next
  const events: TimelineEvent[] = []
  const moved = new Set<string>()
  for (const e of next.events) {
    const now = replaced.get(e.id)
    if (!now) events.push(e)
    else
      for (const piece of now) {
        events.push(piece)
        moved.add(piece.id)
      }
  }
  // A moved caption never runs into the next one on its track (that would be a crossfade).
  const tracks = new Set(events.filter((e) => moved.has(e.id)).map((e) => e.trackId))
  for (const trackId of tracks) {
    const onTrack = events.filter((e) => e.trackId === trackId).sort((a, b) => a.start - b.start)
    for (let i = 0; i + 1 < onTrack.length; i++) {
      const a = onTrack[i]
      const b = onTrack[i + 1]
      // Only captions made here are new objects, safe to change.
      if (!moved.has(a.id) || a.start + a.length <= b.start) continue
      a.length = Math.max(frame, b.start - a.start)
      a.fadeIn = Math.min(a.fadeIn, a.length)
      a.fadeOut = Math.min(a.fadeOut, a.length - a.fadeIn)
    }
  }
  return { ...next, events }
}

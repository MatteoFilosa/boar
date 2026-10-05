import type { CaptionWord } from './text'
import { type Flicks, FLICKS_PER_SECOND, secondsToFlicks } from './time'
import { sourceLength, timelineTime } from './timeline'
import type { Project, TimelineEvent } from './types'
import { mediaById } from './store'

// Text-based editing: the speech of a media file, word by word, placed on the
// timeline through the events that play it. Deleting words cuts the events.

/** Transcript of a whole media file; word times are seconds of the file. */
export interface MediaTranscript {
  language: string
  model: string
  words: CaptionWord[]
}

/** A transcript word as heard on the timeline. */
export interface TimelineWord {
  text: string
  start: Flicks
  end: Flicks
  eventId: string
  mediaId: string
  /** Index of the word in its media transcript. */
  index: number
}

export type WordFlag = 'filler' | 'maybe' | 'repeat'

/**
 * The words the events play, in timeline order. A word belongs to the event
 * that plays its middle, so a cut in the middle of a word keeps it once.
 */
export function wordsOnTimeline(events: readonly TimelineEvent[], transcripts: Record<string, MediaTranscript>): TimelineWord[] {
  const out: TimelineWord[] = []
  for (const e of [...events].sort((a, b) => a.start - b.start)) {
    const transcript = transcripts[e.mediaId]
    if (!transcript || e.text) continue
    const from = e.offset / FLICKS_PER_SECOND
    const to = (e.offset + sourceLength(e)) / FLICKS_PER_SECOND
    const end = e.start + e.length
    transcript.words.forEach((w, index) => {
      const middle = (w.start + w.end) / 2
      if (middle < from || middle >= to) return
      out.push({
        text: w.text,
        start: Math.max(e.start, timelineTime(e, secondsToFlicks(w.start))),
        end: Math.min(end, timelineTime(e, secondsToFlicks(w.end))),
        eventId: e.id,
        mediaId: e.mediaId,
        index
      })
    })
  }
  return out
}

/** A timeline word as a caption word (seconds), linked to its place in the transcript. */
export const timedWord = (w: TimelineWord): CaptionWord => ({
  text: w.text,
  start: w.start / FLICKS_PER_SECOND,
  end: w.end / FLICKS_PER_SECOND,
  src: [w.mediaId, w.index]
})

/** Lowercase letters and digits only ("Ehm," -> "ehm"). */
export const normalizeWord = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '')

/** Hesitation sounds: ehm, eh, ah, uhm, um, mm, hmm. */
const FILLER = /^(e+h*m+|e+h+|a+h+|u+h+m*|u+m+|m{2,}|m+h+|h+m+)$/

/** Words that are often padding but sometimes meaningful: the user decides. */
const MAYBE = new Set([
  'cioè',
  'tipo',
  'praticamente',
  'diciamo',
  'insomma',
  'allora',
  'appunto',
  'letteralmente',
  'boh',
  'like',
  'basically',
  'actually',
  'literally',
  'so',
  'well'
])

/** Filler, possible filler, or the first of a repeated word ("che che"). */
export function wordFlag(words: readonly TimelineWord[], i: number): WordFlag | null {
  const w = normalizeWord(words[i].text)
  if (!w) return null
  if (FILLER.test(w)) return 'filler'
  const next = words[i + 1]
  if (next && normalizeWord(next.text) === w && next.start - words[i].end < FLICKS_PER_SECOND) return 'repeat'
  if (MAYBE.has(w)) return 'maybe'
  return null
}

const PAD_BEFORE = secondsToFlicks(0.03)
const PAD_AFTER = secondsToFlicks(0.05)

/**
 * Timeline ranges to cut for the selected words (positions in `words`): each
 * run of selected words goes with the pause after it, so the speech closes up
 * naturally.
 */
export function rangesForWords(words: readonly TimelineWord[], selected: ReadonlySet<number>): { start: Flicks; end: Flicks }[] {
  const ranges: { start: Flicks; end: Flicks }[] = []
  const positions = [...selected].filter((i) => i >= 0 && i < words.length).sort((a, b) => a - b)
  let i = 0
  while (i < positions.length) {
    let j = i
    while (j + 1 < positions.length && positions[j + 1] === positions[j] + 1) j++
    const first = words[positions[i]]
    const last = words[positions[j]]
    const previous = words[positions[i] - 1]
    const next = words[positions[j] + 1]
    const start = Math.max(previous ? previous.end : 0, first.start - PAD_BEFORE)
    const end = next ? Math.max(last.end, next.start - PAD_AFTER) : last.end
    if (end > start) ranges.push({ start, end })
    i = j + 1
  }
  return ranges
}

/** Pauses longer than `min` seconds between words, shortened to `keep` seconds when cut. */
export function longPauses(words: readonly TimelineWord[], min: number, keep: number): { start: Flicks; end: Flicks; after: number }[] {
  const out: { start: Flicks; end: Flicks; after: number }[] = []
  const half = secondsToFlicks(keep / 2)
  for (let i = 0; i + 1 < words.length; i++) {
    const gap = words[i + 1].start - words[i].end
    if (gap <= secondsToFlicks(min)) continue
    out.push({ start: words[i].end + half, end: words[i + 1].start - half, after: i })
  }
  return out
}

export const hasSpeech = (e: TimelineEvent): boolean => !e.text && !!mediaById(e.mediaId)?.hasAudio

/** Tracks whose events have sound, audio tracks first. */
export function speechTracks(project: Project): string[] {
  const ids = new Set(project.events.filter(hasSpeech).map((e) => e.trackId))
  const tracks = project.tracks.filter((t) => ids.has(t.id))
  return [...tracks.filter((t) => t.kind === 'audio'), ...tracks.filter((t) => t.kind === 'video')].map((t) => t.id)
}

/** The track to read: the selected event's sound (or its grouped audio), else the first track with speech. */
export function defaultSpeechTrack(project: Project, selection: string[], candidates: string[]): string | null {
  const selected = project.events.filter((e) => selection.includes(e.id) && hasSpeech(e))
  const audio = selected.find((e) => e.kind === 'audio') ?? project.events.find((e) => selected.some((s) => s.groupId && s.groupId === e.groupId && e.kind === 'audio'))
  const pick = audio ?? selected[0]
  if (pick && candidates.includes(pick.trackId)) return pick.trackId
  return candidates[0] ?? null
}

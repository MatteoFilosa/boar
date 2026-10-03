import type { CaptionWord } from './text'

// Speech recognition output -> timed words -> caption chunks.

/** Seconds from the start of the transcribed range. */
export interface TranscriptPiece {
  start: number
  end: number
  text: string
}

export interface Transcript {
  segments: TranscriptPiece[]
  tokens: TranscriptPiece[]
}

/** A caption to place on the timeline; word times are absolute (same clock as start/end). */
export interface CaptionChunk {
  start: number
  end: number
  text: string
  words: CaptionWord[]
}

const squash = (s: string): string => s.toLowerCase().replace(/\s+/g, '')

/** Words of a segment with times shared out by character count (when token times are unusable). */
function proportional(segment: TranscriptPiece): CaptionWord[] {
  const words = segment.text.split(/\s+/).filter(Boolean)
  const total = words.reduce((n, w) => n + w.length + 1, 0)
  let at = segment.start
  return words.map((text) => {
    const span = ((segment.end - segment.start) * (text.length + 1)) / Math.max(1, total)
    const w = { text, start: at, end: at + span }
    at += span
    return w
  })
}

/**
 * Per-word timings. Whisper's tokens are often parts of words ("ben" "ven"
 * "uti"), and the phrases have the spacing but coarse times: the tokens'
 * characters are matched to the phrase's words, so each word starts with its
 * first token and ends with its last. Falls back to proportional timing when
 * the two passes disagree.
 */
export function alignWords(transcript: Transcript): CaptionWord[] {
  const { segments, tokens } = transcript
  const segmentText = squash(segments.map((s) => s.text).join(''))
  const tokenText = squash(tokens.map((t) => t.text).join(''))
  if (tokens.length === 0 || segmentText !== tokenText) return segments.flatMap(proportional)
  const out: CaptionWord[] = []
  let ti = 0
  let used = 0
  for (const segment of segments) {
    for (const text of segment.text.split(/\s+/).filter(Boolean)) {
      let need = squash(text).length
      let start = Number.NaN
      let end = Number.NaN
      while (need > 0 && ti < tokens.length) {
        const token = tokens[ti]
        const length = squash(token.text).length
        if (Number.isNaN(start)) start = token.start
        end = token.end
        const take = Math.min(need, length - used)
        need -= take
        used += take
        if (used >= length) {
          ti++
          used = 0
        }
      }
      if (Number.isNaN(start)) start = end = segment.end
      out.push({ text, start, end: Math.max(end, start + 0.05) })
    }
  }
  return out
}

export interface ChunkOptions {
  maxChars: number
  maxWords: number
  /** A pause longer than this (seconds) starts a new caption. */
  maxGap: number
}

/** Groups timed words into captions: by length, word count, pauses and sentence ends. */
export function chunkWords(words: CaptionWord[], o: ChunkOptions): CaptionChunk[] {
  const out: CaptionChunk[] = []
  let current: CaptionWord[] = []
  const flush = (): void => {
    if (current.length === 0) return
    out.push({
      start: current[0].start,
      end: current[current.length - 1].end,
      text: current.map((w) => w.text).join(' '),
      words: current
    })
    current = []
  }
  for (const word of words) {
    const last = current[current.length - 1]
    const length = current.reduce((n, w) => n + w.text.length + 1, 0) + word.text.length
    if (
      last &&
      (length > o.maxChars || current.length >= o.maxWords || word.start - last.end > o.maxGap || /[.!?…]$/.test(last.text))
    ) {
      flush()
    }
    current.push(word)
  }
  flush()
  return out
}

/** Caption looks: a text preset and how many words go in each caption. */
export const CAPTION_STYLES = [
  { id: 'cap-highlight', label: 'Karaoke: the spoken word lights up', maxChars: 18, maxWords: 4 },
  { id: 'cap-box', label: 'Box on the spoken word', maxChars: 18, maxWords: 4 },
  { id: 'cap-pop', label: 'Words pop in as spoken', maxChars: 18, maxWords: 4 },
  { id: 'cap-single', label: 'One big word at a time', maxChars: 14, maxWords: 3 },
  { id: 'shorts', label: 'Shorts / Reels chunks (static)', maxChars: 20, maxWords: 5 },
  { id: 'subtitle', label: 'Subtitles (bottom, with box)', maxChars: 42, maxWords: 12 }
]

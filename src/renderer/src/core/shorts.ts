import { type Flicks, FLICKS_PER_SECOND } from './time'
import type { TimelineWord } from './transcript'
import { normalizeWord } from './transcript'

// Long video -> Shorts. Candidates come from an AI agent (MCP propose_shorts) or
// from the local finder below, and are kept with the long project.

export interface ShortCandidate {
  id: string
  title: string
  /** Opening line for the hook title at the top ('' = none). */
  hook: string
  /** Timeline ranges of the long video, played in this order. */
  ranges: { start: Flicks; end: Flicks }[]
  /** Why this moment works (shown to the user). */
  reason: string
  /** Who proposed it: an agent's name, or 'Local finder'. */
  source: string
}

export const shortDuration = (c: ShortCandidate): Flicks => c.ranges.reduce((n, r) => n + r.end - r.start, 0)

interface Sentence {
  start: Flicks
  end: Flicks
  text: string
  words: TimelineWord[]
}

function toSentences(words: readonly TimelineWord[]): Sentence[] {
  const out: Sentence[] = []
  let current: TimelineWord[] = []
  const flush = (): void => {
    if (!current.length) return
    out.push({ start: current[0].start, end: current[current.length - 1].end, text: current.map((w) => w.text).join(' '), words: current })
    current = []
  }
  words.forEach((w, i) => {
    const previous = words[i - 1]
    if (previous && (w.start - previous.end > 0.9 * FLICKS_PER_SECOND || current.length >= 40)) flush()
    current.push(w)
    if (/[.!?…]$/.test(w.text)) flush()
  })
  flush()
  return out
}

/** Words that open a strong hook, Italian and English. */
const HOOK_WORDS = new Set(
  (
    'come perché perche cosa quando ecco segreto segreti errore errori mai sempre nessuno tutti stop attenzione incredibile ' +
    'devi dovete vuoi volete sai sapete immagina ecco questo questa trucco verità problema soldi gratis migliore peggiore ' +
    'how why what when secret mistake never always nobody everyone stop wait imagine this truth problem money free best worst you'
  ).split(' ')
)

function hookScore(s: Sentence): number {
  const words = s.words.map((w) => normalizeWord(w.text))
  let score = 0
  if (/\?$/.test(s.text)) score += 2
  if (words.slice(0, 4).some((w) => HOOK_WORDS.has(w))) score += 2
  if (words.some((w) => /\d/.test(w))) score += 1
  if (s.words.length >= 4 && s.words.length <= 18) score += 1
  return score
}

/**
 * Windows of whole sentences between `min` and `max` seconds, scored by the
 * opening line, words per second and a clean ending. Best non-overlapping first.
 */
export function findHighlights(words: readonly TimelineWord[], count: number, min = 20, max = 60): Omit<ShortCandidate, 'id'>[] {
  const sentences = toSentences(words)
  const F = FLICKS_PER_SECOND
  const scored: { start: number; end: number; score: number; first: Sentence }[] = []
  for (let i = 0; i < sentences.length; i++) {
    const first = sentences[i]
    let wordsIn = 0
    for (let j = i; j < sentences.length; j++) {
      const s = sentences[j]
      if (j > i && s.start - sentences[j - 1].end > 3 * F) break
      wordsIn += s.words.length
      const length = (s.end - first.start) / F
      if (length > max) break
      if (length < min) continue
      const rate = wordsIn / length
      const clean = /[.!?…]$/.test(s.text) ? 1 : 0
      const target = 1 - Math.min(1, Math.abs(length - (min + max) / 2) / max)
      scored.push({ start: first.start, end: s.end, score: hookScore(first) * 2 + Math.min(4, rate) + clean + target, first })
    }
  }
  scored.sort((a, b) => b.score - a.score)
  const picked: typeof scored = []
  for (const c of scored) {
    if (picked.length >= count) break
    if (picked.some((p) => c.start < p.end && c.end > p.start)) continue
    picked.push(c)
  }
  return picked
    .sort((a, b) => a.start - b.start)
    .map((c) => {
      const opening = c.first.words.slice(0, 8).map((w) => w.text).join(' ').replace(/[,;:]$/, '')
      return {
        title: opening.length > 48 ? `${opening.slice(0, 47)}…` : opening,
        hook: c.first.words.length <= 10 ? c.first.text : '',
        ranges: [{ start: Math.max(0, c.start - 0.15 * F), end: c.end + 0.25 * F }],
        reason: `Opens with “${opening}”; ${Math.round((c.end - c.start) / F)} s of whole sentences`,
        source: 'Local finder'
      }
    })
}

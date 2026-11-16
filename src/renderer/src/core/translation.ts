// Caption translation: which models a language pair needs, which captions
// are translated together (whole sentences read better than caption-sized
// pieces), and how a translated sentence goes back onto those captions.

/** Languages captions can be translated into (and from, with any other through English). */
export const TRANSLATE_LANGUAGES: { code: string; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'it', label: 'Italian' },
  { code: 'fr', label: 'French' },
  { code: 'es', label: 'Spanish' },
  { code: 'de', label: 'German' }
]

export const languageLabel = (code: string): string => TRANSLATE_LANGUAGES.find((l) => l.code === code)?.label ?? code

/**
 * Models that take `from` to `to`, in order: the pair itself, else through
 * English; a language without its own model goes to English through the
 * multilingual one ('mul-en'). Null when no route exists. `pairs`: the
 * models there are ('it-en', …).
 */
export function translationRoute(from: string, to: string, pairs: readonly string[]): string[] | null {
  if (from === to) return []
  const has = (p: string): boolean => pairs.includes(p)
  if (has(`${from}-${to}`)) return [`${from}-${to}`]
  const toEnglish = has(`${from}-en`) ? `${from}-en` : has('mul-en') ? 'mul-en' : null
  if (!toEnglish) return null
  if (to === 'en') return [toEnglish]
  return has(`en-${to}`) && from !== 'en' ? [toEnglish, `en-${to}`] : null
}

/** A caption's text to translate: emphasis marks, line breaks and emoji left out. */
export function plainCaption(text: string): string {
  return text
    .replace(/\*/g, '')
    .replace(/\p{Extended_Pictographic}️?/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const EMOJI_START = /^(?:\p{Extended_Pictographic}️?\s*)+/u
const EMOJI_END = /(?:\s*\p{Extended_Pictographic}️?)+$/u

/** Emoji a caption starts or ends with, with their spacing (Add Emoji joins them to a word), to put back on the translation. */
export const captionEmoji = (text: string): { before: string; after: string } => ({
  before: text.trim().match(EMOJI_START)?.[0] ?? '',
  after: text.trim().match(EMOJI_END)?.[0] ?? ''
})

export interface CaptionLine {
  /** The plain text (plainCaption). */
  text: string
  /** Timeline seconds. */
  start: number
  end: number
}

const SENTENCE_END = /[.!?…。！？]["')\]»”]*$/
/** Opus-MT reads at most 512 tokens; sentences longer than this many characters are cut at a caption. */
const MAX_CHARS = 400

/**
 * Captions translated together, as lists of indices: a caption ending a
 * sentence ends its group, so does a pause longer than `pause` seconds, and
 * a group never grows past MAX_CHARS. Empty captions are left out.
 */
export function sentenceGroups(lines: readonly CaptionLine[], pause = 1): number[][] {
  const groups: number[][] = []
  let current: number[] = []
  let chars = 0
  const close = (): void => {
    if (current.length) groups.push(current)
    current = []
    chars = 0
  }
  lines.forEach((line, i) => {
    if (!line.text) return
    const prev = current.length ? lines[current[current.length - 1]] : null
    if (prev && (line.start - prev.end > pause || chars + line.text.length > MAX_CHARS)) close()
    current.push(i)
    chars += line.text.length + 1
    if (SENTENCE_END.test(line.text)) close()
  })
  close()
  return groups
}

/**
 * A translated sentence split over the captions it came from, in proportion
 * to their length: each caption gets at least a word while there are enough,
 * and a cut moves by a word to land after punctuation.
 */
export function splitTranslation(translated: string, lengths: readonly number[]): string[] {
  const words = translated.split(/\s+/).filter(Boolean)
  if (lengths.length <= 1) return [words.join(' ')]
  const total = lengths.reduce((a, b) => a + Math.max(1, b), 0)
  const cuts: number[] = []
  let sum = 0
  for (let i = 0; i < lengths.length - 1; i++) {
    sum += Math.max(1, lengths[i])
    let cut = Math.round((words.length * sum) / total)
    const punct = (k: number): boolean => k > 0 && k < words.length && /[,;:.!?…]$/.test(words[k - 1])
    if (!punct(cut)) cut = punct(cut + 1) ? cut + 1 : punct(cut - 1) ? cut - 1 : cut
    const min = (cuts.at(-1) ?? 0) + (words.length >= lengths.length ? 1 : 0)
    const max = words.length - (words.length >= lengths.length ? lengths.length - 1 - i : 0)
    cuts.push(Math.min(max, Math.max(min, cut)))
  }
  return lengths.map((_, i) => words.slice(i === 0 ? 0 : cuts[i - 1], i < cuts.length ? cuts[i] : words.length).join(' '))
}

/** Words broken into `lines` lines of about the same length. */
export function breakLines(text: string, lines: number): string {
  const words = text.split(' ').filter(Boolean)
  if (lines <= 1 || words.length < 2) return words.join(' ')
  const out: string[] = []
  let rest = words
  for (let n = lines; n > 1 && rest.length > 1; n--) {
    const target = rest.join(' ').length / n
    let len = 0
    let k = 0
    while (k < rest.length - 1 && len + rest[k].length / 2 < target) len += rest[k++].length + 1
    k = Math.max(1, k)
    out.push(rest.slice(0, k).join(' '))
    rest = rest.slice(k)
  }
  out.push(rest.join(' '))
  return out.join('\n')
}

/**
 * The translated text of each caption (`originals`: their texts, in order;
 * `groups`: sentenceGroups; `translated`: one text per group). A caption
 * keeps its number of lines and the emoji it starts or ends with; '' when
 * nothing of the translation is left for it.
 */
export function captionTranslations(originals: readonly string[], groups: readonly number[][], translated: readonly string[]): string[] {
  const out = originals.map(() => '')
  groups.forEach((group, k) => {
    const pieces = splitTranslation(translated[k] ?? '', group.map((i) => plainCaption(originals[i]).length))
    group.forEach((i, j) => {
      const piece = pieces[j]
      if (!piece) return
      const { before, after } = captionEmoji(originals[i])
      const lines = originals[i].trim().split('\n').length
      out[i] = `${before}${breakLines(piece, lines)}${after}`
    })
  })
  return out
}

import { splitWords } from './text'

// Caption styling: key words wrapped in *asterisks* and emoji after topic words.
// The word count never changes, so word timings stay valid.

const norm = (w: string): string => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/** Words worth highlighting in Italian and English videos. */
const KEYWORDS = new Set(
  (
    'soldi euro gratis gratuito segreto segreti errore errori mai sempre migliore peggiore subito importante attenzione ' +
    'nuovo nuova incredibile pazzesco assurdo facile veloce trucco trucchi problema soluzione risultato risultati verità ' +
    'milioni mille nessuno primo ultimo oggi adesso basta vero falso fondamentale perfetto enorme zero tutto niente ' +
    'money free secret secrets mistake mistakes never always best worst now important new amazing crazy easy fast hack ' +
    'problem solution result results truth million everyone nobody first last today stop true false perfect huge zero'
  ).split(' ')
)

/** Topic words -> emoji. Patterns match the normalized (lowercase, no punctuation) word. */
const EMOJI: [RegExp, string][] = [
  [/^(soldi|euro|dollari?|money|cash|ricc[oaih]+|rich)$/, '💰'],
  [/^(amore|love|cuore|heart)$/, '❤️'],
  [/^(fuoco|fire|hot)$/, '🔥'],
  [/^(idea|idee|ideas?)$/, '💡'],
  [/^(tempo|time|minuti|ore|hours?|minutes?)$/, '⏰'],
  [/^(casa|home|house)$/, '🏠'],
  [/^(cibo|food|mangiare|pizza|cena|pranzo|eat)$/, '🍕'],
  [/^(lavoro|work|job|business|azienda)$/, '💼'],
  [/^(telefono|phone|smartphone|cellulare)$/, '📱'],
  [/^(auto|macchina|car)$/, '🚗'],
  [/^(viaggio|viaggiare|travel|vacanza|vacanze|trip)$/, '✈️'],
  [/^(musica|canzone|music|song)$/, '🎵'],
  [/^(felice|felici|happy)$/, '😄'],
  [/^(triste|sad)$/, '😢'],
  [/^(ridere|risata|laugh|funny|divertente)$/, '😂'],
  [/^(wow|incredibile|pazzesco|assurdo|amazing|crazy|insane)$/, '🤯'],
  [/^(migliore|migliori|best|top|vincere|win|winner)$/, '🏆'],
  [/^(errore|errori|sbagliato|mistake|mistakes|wrong)$/, '❌'],
  [/^(giusto|corretto|right|correct|perfetto|perfect)$/, '✅'],
  [/^(attenzione|warning|pericolo|danger)$/, '⚠️'],
  [/^(segreto|segreti|secret|secrets)$/, '🤫'],
  [/^(gratis|gratuito|free)$/, '🆓'],
  [/^(nuovo|nuova|new)$/, '✨'],
  [/^(crescita|crescere|growth|grow)$/, '📈'],
  [/^(cervello|brain|intelligente|smart)$/, '🧠'],
  [/^(forte|forza|strong|power)$/, '💪'],
  [/^(guarda|guardate|look|watch)$/, '👀'],
  [/^(regalo|gift)$/, '🎁'],
  [/^(festa|party)$/, '🎉'],
  [/^(caffè|caffe|coffee)$/, '☕'],
  [/^(palestra|gym|allenamento|workout)$/, '🏋️'],
  [/^(libro|libri|studiare|book|books|study)$/, '📚'],
  [/^(video|film|movie)$/, '🎬'],
  [/^(foto|photo)$/, '📸'],
  [/^(mondo|world)$/, '🌍'],
  [/^(estate|sole|summer|sun)$/, '☀️'],
  [/^(notte|night|dormire|sleep)$/, '🌙'],
  [/^(grazie|thanks)$/, '🙏'],
  [/^(ciao|hello)$/, '👋'],
  [/^(perché|perche|why)$/, '❓'],
  [/^(veloce|velocemente|fast|speed)$/, '⚡'],
  [/^(obiettivo|goal|target)$/, '🎯'],
  [/^(sorpresa|surprise|shock)$/, '😱']
]

const hasEmoji = (w: string): boolean => /\p{Extended_Pictographic}/u.test(w)

/**
 * Wraps the key word of a caption in *asterisks* (two in longer captions):
 * numbers first, then known key words, then the longest word.
 */
export function emphasizeKeywords(text: string): string {
  const words = splitWords(text)
  if (words.length === 0 || words.some((w) => w.startsWith('*'))) return text
  const scored = words
    .map((w, i) => {
      const n = norm(w)
      const score = /\d/.test(n) ? 3 : KEYWORDS.has(n) ? 2 : words.length >= 3 && n.length >= 7 ? 1 + n.length / 100 : 0
      return { i, score }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
  const picks = new Set(scored.slice(0, words.length >= 6 ? 2 : 1).map((s) => s.i))
  if (picks.size === 0) return text
  return rebuild(text, (w, i) => (picks.has(i) ? `*${w.replace(/([.,!?…:;]+)$/, '*$1')}${/[.,!?…:;]+$/.test(w) ? '' : '*'}` : w))
}

/** Adds one emoji after the first topic word of a caption (none if it already has one). */
export function addEmoji(text: string): string {
  const words = splitWords(text)
  if (words.some(hasEmoji)) return text
  const index = words.findIndex((w) => EMOJI.some(([re]) => re.test(norm(w))))
  if (index < 0) return text
  const emoji = EMOJI.find(([re]) => re.test(norm(words[index])))?.[1] ?? ''
  return rebuild(text, (w, i) => (i === index ? `${w}${emoji}` : w))
}

/** Rewrites each word, keeping the original spacing and line breaks. */
function rebuild(text: string, map: (word: string, index: number) => string): string {
  let i = 0
  return text.replace(/\S+/g, (w) => map(w, i++))
}

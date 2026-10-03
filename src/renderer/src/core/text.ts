import { fontInfo, fontReady } from './fonts'

/** A spoken word of a caption. Times in seconds from the event's origin (start - offset). */
export interface CaptionWord {
  text: string
  start: number
  end: number
}

/**
 * How timed words animate (captions): the current word gets a color, a box
 * behind it, pops in, is shown alone, or the upcoming words stay dimmed.
 */
export type WordStyle = 'none' | 'highlight' | 'box' | 'pop' | 'single' | 'reveal'

export type TextAnimIn = 'none' | 'fade' | 'pop' | 'zoom' | 'slideUp' | 'slideLeft' | 'bounce' | 'typewriter'
export type TextAnimOut = 'none' | 'fade' | 'pop' | 'zoom' | 'slideDown'

/** Generated text media (titles, captions). Stored on the event itself. */
export interface TextContent {
  text: string
  font: string
  /** Font size in px for a 1080 px short side; scales with the project. */
  size: number
  bold: boolean
  italic: boolean
  uppercase: boolean
  color: string
  strokeColor: string
  /** Outline width in px for a 1080 px short side (0 = none). */
  strokeWidth: number
  /** Background box color ('' = no box). */
  boxColor: string
  boxOpacity: number
  /** One box around the block, or a rounded box behind each line. */
  boxStyle: 'block' | 'lines'
  shadow: boolean
  /** Neon glow color ('' = none). */
  glow: string
  align: 'left' | 'center' | 'right'
  /** Anchor position as a fraction of the frame (x: per align, y: block center). */
  x: number
  y: number
  /** Wrap width as a fraction of the frame width. */
  maxWidth: number
  /** Word timings from speech recognition (null for normal titles). */
  words: CaptionWord[] | null
  wordStyle: WordStyle
  /** Color of the current word (highlight, box, reveal). */
  highlightColor: string
  animIn: TextAnimIn
  animOut: TextAnimOut
  /** Seconds. */
  animDuration: number
  /** Color of emphasized words, written *like this* in the text. */
  emphasisColor: string
  /** Draws a bar that fills over the event's length instead of the text (track: boxColor, fill: highlightColor). */
  progressBar: boolean
}

const BASE: TextContent = {
  text: 'Title',
  font: 'Inter',
  size: 96,
  bold: true,
  italic: false,
  uppercase: false,
  color: '#ffffff',
  strokeColor: '#000000',
  strokeWidth: 0,
  boxColor: '',
  boxOpacity: 0.55,
  boxStyle: 'block',
  shadow: true,
  glow: '',
  align: 'center',
  x: 0.5,
  y: 0.45,
  maxWidth: 0.85,
  words: null,
  wordStyle: 'none',
  highlightColor: '#ffe135',
  animIn: 'none',
  animOut: 'none',
  animDuration: 0.3,
  emphasisColor: '#ffe135',
  progressBar: false
}

/** Fills fields added after a text event was saved. */
export const normalizeText = (t: Partial<TextContent>): TextContent => ({ ...BASE, ...t })

export const WORD_STYLES: { id: WordStyle; label: string }[] = [
  { id: 'none', label: 'Static' },
  { id: 'highlight', label: 'Karaoke highlight' },
  { id: 'box', label: 'Box on current word' },
  { id: 'pop', label: 'Words pop in' },
  { id: 'reveal', label: 'Reveal (dim upcoming)' },
  { id: 'single', label: 'One word at a time' }
]

export const ANIM_IN: { id: TextAnimIn; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'fade', label: 'Fade' },
  { id: 'pop', label: 'Pop' },
  { id: 'zoom', label: 'Zoom out' },
  { id: 'slideUp', label: 'Slide up' },
  { id: 'slideLeft', label: 'Slide from right' },
  { id: 'bounce', label: 'Bounce' },
  { id: 'typewriter', label: 'Typewriter' }
]

export const ANIM_OUT: { id: TextAnimOut; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'fade', label: 'Fade' },
  { id: 'pop', label: 'Pop' },
  { id: 'zoom', label: 'Zoom in' },
  { id: 'slideDown', label: 'Slide down' }
]

export interface TextPreset {
  id: string
  label: string
  description: string
  content: TextContent
}

/** Caption looks for Generate Captions (timed words). */
const CAPTION = {
  ...BASE,
  emphasisColor: '#4ade80',
  font: 'Montserrat',
  size: 78,
  uppercase: true,
  strokeWidth: 9,
  shadow: true,
  y: 0.64,
  maxWidth: 0.82,
  animIn: 'pop' as const,
  animDuration: 0.18
}

export const TEXT_PRESETS: TextPreset[] = [
  { id: 'title', label: 'Title', description: 'Big centered title', content: { ...BASE, animIn: 'fade', animOut: 'fade' } },
  {
    id: 'shorts',
    label: 'Shorts caption',
    description: 'Bold outlined text above the app buttons',
    content: {
      ...BASE,
      text: 'YOUR TEXT HERE',
      font: 'Archivo Black',
      size: 76,
      strokeWidth: 9,
      shadow: false,
      y: 0.66,
      maxWidth: 0.8
    }
  },
  {
    id: 'reel',
    label: 'Reel classic',
    description: 'TikTok Sans with a clean outline',
    content: { ...BASE, text: 'Your text here', font: 'TikTok Sans', size: 72, strokeWidth: 6, shadow: false, y: 0.62, maxWidth: 0.8, animIn: 'pop', animDuration: 0.22 }
  },
  {
    id: 'highlight',
    label: 'Bold highlight',
    description: 'Heavy yellow captions, podcast clip style',
    content: {
      ...BASE,
      text: 'WATCH THIS',
      font: 'Montserrat',
      size: 92,
      color: '#ffe135',
      strokeWidth: 10,
      y: 0.6,
      maxWidth: 0.82,
      animIn: 'pop',
      animDuration: 0.2
    }
  },
  {
    id: 'bubble',
    label: 'Bubble box',
    description: 'Dark text on a rounded box behind each line',
    content: {
      ...BASE,
      text: 'Rounded box\nbehind each line',
      font: 'Poppins',
      size: 60,
      color: '#111111',
      shadow: false,
      boxColor: '#ffffff',
      boxOpacity: 1,
      boxStyle: 'lines',
      y: 0.5,
      maxWidth: 0.8,
      animIn: 'slideUp'
    }
  },
  {
    id: 'neon',
    label: 'Neon',
    description: 'Glowing neon sign',
    content: { ...BASE, text: 'Neon vibes', font: 'Tilt Neon', size: 110, bold: false, color: '#ffe9fb', glow: '#ff3dd8', shadow: false, animIn: 'fade', animDuration: 0.5 }
  },
  {
    id: 'typewriter',
    label: 'Typewriter',
    description: 'Types itself on white strips',
    content: {
      ...BASE,
      text: 'once upon a time...',
      font: 'Special Elite',
      size: 58,
      bold: false,
      color: '#111111',
      shadow: false,
      boxColor: '#ffffff',
      boxOpacity: 0.92,
      boxStyle: 'lines',
      animIn: 'typewriter',
      animDuration: 1
    }
  },
  {
    id: 'elegant',
    label: 'Elegant',
    description: 'Serif italic for quotes and aesthetic edits',
    content: { ...BASE, text: 'golden hour', font: 'Playfair Display', size: 100, bold: false, italic: true, animIn: 'fade', animOut: 'fade', animDuration: 0.6 }
  },
  {
    id: 'script',
    label: 'Script',
    description: 'Handwritten signature style',
    content: { ...BASE, text: 'Summer', font: 'Pacifico', size: 120, bold: false, animIn: 'zoom', animDuration: 0.4 }
  },
  {
    id: 'comic',
    label: 'Comic pop',
    description: 'Comic book lettering',
    content: { ...BASE, text: 'BOOM!', font: 'Bangers', size: 150, bold: false, color: '#ffd23f', strokeWidth: 10, y: 0.5, animIn: 'bounce', animDuration: 0.6 }
  },
  {
    id: 'condensed',
    label: 'Big condensed',
    description: 'Tall headline, sports and news style',
    content: { ...BASE, text: 'HEADLINE', font: 'Bebas Neue', size: 190, bold: false, shadow: true, animIn: 'slideLeft', animOut: 'fade' }
  },
  {
    id: 'marker',
    label: 'Marker',
    description: 'Hand drawn marker',
    content: { ...BASE, text: 'Note to self', font: 'Permanent Marker', size: 90, bold: false, animIn: 'pop' }
  },
  {
    id: 'lower-third',
    label: 'Lower third',
    description: 'Name and role on a box',
    content: {
      ...BASE,
      text: 'Name Surname\nRole',
      size: 46,
      bold: false,
      shadow: false,
      boxColor: '#000000',
      boxOpacity: 0.6,
      align: 'left',
      x: 0.07,
      y: 0.8,
      maxWidth: 0.6,
      animIn: 'slideLeft',
      animOut: 'fade'
    }
  },
  {
    id: 'subtitle',
    label: 'Subtitle',
    description: 'Readable line at the bottom',
    content: {
      ...BASE,
      text: 'Subtitle text',
      size: 44,
      bold: false,
      shadow: false,
      boxColor: '#000000',
      boxOpacity: 0.5,
      y: 0.88
    }
  },
  {
    id: 'number',
    label: 'Big number',
    description: 'Countdowns and lists',
    content: { ...BASE, text: '1', size: 300, color: '#ffcf3f', strokeWidth: 10, shadow: false, y: 0.5, animIn: 'pop', animDuration: 0.25 }
  },
  {
    id: 'hook',
    label: 'Hook (top)',
    description: 'The opening line at the top of a Short, with *emphasis*',
    content: {
      ...BASE,
      text: 'WAIT FOR *THE END*',
      font: 'Montserrat',
      size: 84,
      uppercase: true,
      color: '#111111',
      boxColor: '#ffffff',
      boxOpacity: 1,
      boxStyle: 'lines',
      shadow: false,
      emphasisColor: '#e11d48',
      y: 0.17,
      maxWidth: 0.8,
      animIn: 'pop',
      animDuration: 0.25
    }
  },
  {
    id: 'progress',
    label: 'Progress bar',
    description: 'A bar that fills up over the length of the event: stretch it over the whole video',
    content: {
      ...BASE,
      text: 'Progress bar',
      size: 30,
      boxColor: '#ffffff',
      boxOpacity: 0.35,
      highlightColor: '#ff3b5c',
      shadow: false,
      progressBar: true,
      y: 0.985,
      maxWidth: 1
    }
  },
  {
    id: 'cap-highlight',
    label: 'Karaoke captions',
    description: 'The spoken word lights up',
    content: { ...CAPTION, text: 'THE WORD LIGHTS UP', wordStyle: 'highlight' }
  },
  {
    id: 'cap-box',
    label: 'Word box captions',
    description: 'A colored box follows the spoken word',
    content: { ...CAPTION, text: 'BOX ON EACH WORD', font: 'Poppins', size: 72, strokeWidth: 0, highlightColor: '#7c3aed', wordStyle: 'box' }
  },
  {
    id: 'cap-pop',
    label: 'Pop-in captions',
    description: 'Words appear as they are spoken',
    content: { ...CAPTION, text: 'WORDS POP IN', wordStyle: 'pop', highlightColor: '#3df57a' }
  },
  {
    id: 'cap-single',
    label: 'One-word captions',
    description: 'One big word at a time',
    content: { ...CAPTION, text: 'ONE', size: 130, font: 'Luckiest Guy', bold: false, strokeWidth: 10, wordStyle: 'single', y: 0.55, animIn: 'none' }
  }
]

export const presetById = (id: string): TextPreset | undefined => TEXT_PRESETS.find((p) => p.id === id)

/** The words of a text, in order (what timed words map onto). */
export const splitWords = (text: string): string[] => text.split(/\s+/).filter(Boolean)

/**
 * Keeps word timings in step after the text was edited: same number of words
 * keeps each timing; otherwise the time span is shared by character count.
 */
export function retimeWords(words: CaptionWord[], text: string): CaptionWord[] {
  const next = splitWords(text)
  if (next.length === words.length) return words.map((w, i) => ({ ...w, text: next[i] }))
  if (words.length === 0 || next.length === 0) return []
  const start = words[0].start
  const end = words[words.length - 1].end
  const total = next.reduce((n, w) => n + w.length + 1, 0)
  let at = start
  return next.map((text) => {
    const span = ((end - start) * (text.length + 1)) / total
    const w = { text, start: at, end: at + span }
    at += span
    return w
  })
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

function rgba(hex: string, alpha: number): string {
  const v = hex.replace('#', '')
  const n = parseInt(v.length === 3 ? v.replace(/./g, (c) => c + c) : v, 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}

export const fontCss = (c: TextContent, size: number): string => {
  const info = fontInfo(c.font)
  const weight = c.bold ? (info?.bold ?? 800) : (info?.regular ?? 400)
  return `${c.italic ? 'italic ' : ''}${weight} ${size}px "${c.font}", "Inter", sans-serif`
}

interface PlacedWord {
  text: string
  /** Index among the text's words (matches CaptionWord order). */
  index: number
  x: number
  width: number
  /** Written *like this*: drawn in the emphasis color, a little bigger. */
  emphasis: boolean
  /** Emphasized words take more room: the text is drawn this far into its slot. */
  inset: number
}

const EMPHASIS_SCALE = 1.12

/**
 * Emphasis markers: "*word*," or a span "*two words*". `open` carries an
 * unclosed span from one word to the next.
 */
function parseEmphasis(word: string, open: boolean): { text: string; emphasis: boolean; open: boolean } {
  let text = word
  let emphasis = open
  if (text.startsWith('*') && text.length > 1) {
    text = text.slice(1)
    emphasis = true
    open = true
  }
  const close = /\*([^\p{L}\p{N}]*)$/u.exec(text)
  if (open && close) {
    text = text.slice(0, close.index) + close[1]
    open = false
  }
  return { text, emphasis, open }
}

interface PlacedLine {
  words: PlacedWord[]
  y: number
  left: number
  width: number
}

interface TextLayout {
  size: number
  scale: number
  lineHeight: number
  space: number
  lines: PlacedLine[]
  /** Bounding box of the text block (without outline and box padding). */
  box: { left: number; top: number; width: number; height: number }
}

/** Sets the font on ctx and places every word (lines wrap at maxWidth, \n forces a break). */
function layoutText(ctx: Ctx, c: TextContent, width: number, height: number): TextLayout {
  const scale = Math.min(width, height) / 1080
  const size = c.size * scale
  ctx.font = fontCss(c, size)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  const text = c.uppercase ? c.text.toUpperCase() : c.text
  const space = ctx.measureText(' ').width
  const maxWidth = c.maxWidth * width
  const rows: PlacedWord[][] = []
  let index = 0
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean)
    let row: PlacedWord[] = []
    let rowWidth = 0
    let open = false
    for (const raw of words) {
      const parsed = parseEmphasis(raw, open)
      open = parsed.open
      const { text: word, emphasis } = parsed
      const natural = ctx.measureText(word).width
      const w = emphasis ? natural * EMPHASIS_SCALE : natural
      if (row.length > 0 && rowWidth + space + w > maxWidth) {
        rows.push(row)
        row = []
        rowWidth = 0
      }
      row.push({ text: word, index: index++, x: rowWidth + (row.length > 0 ? space : 0), width: w, emphasis, inset: (w - natural) / 2 })
      rowWidth += (row.length > 1 ? space : 0) + w
    }
    rows.push(row)
  }
  const lineHeight = size * 1.18
  const blockHeight = rows.length * lineHeight
  const top = c.y * height - blockHeight / 2
  const anchor = c.x * width
  const lines = rows.map((words, i): PlacedLine => {
    const lineWidth = words.length ? words[words.length - 1].x + words[words.length - 1].width : 0
    const left = c.align === 'left' ? anchor : c.align === 'right' ? anchor - lineWidth : anchor - lineWidth / 2
    for (const w of words) w.x += left
    return { words, y: top + lineHeight * (i + 0.5), left, width: lineWidth }
  })
  const widest = Math.max(...lines.map((l) => l.width), 0)
  const left = c.align === 'left' ? anchor : c.align === 'right' ? anchor - widest : anchor - widest / 2
  return { size, scale, lineHeight, space, lines, box: { left, top, width: widest, height: blockHeight } }
}

const measureCanvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : null

/** Frame-space rectangle covered by a text event (handles in the preview). */
export function textBounds(c: TextContent, width: number, height: number): { left: number; top: number; width: number; height: number } {
  const ctx = measureCanvas?.getContext('2d')
  if (!ctx) return { left: 0, top: 0, width: 0, height: 0 }
  const { box, size } = layoutText(ctx, c, width, height)
  const pad = c.boxColor ? size * 0.4 : size * 0.08
  return { left: box.left - pad, top: box.top - pad * 0.6, width: box.width + pad * 2, height: box.height + pad * 1.2 }
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, h / 2, w / 2)))
  ctx.fill()
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
const easeOut = (p: number): number => 1 - (1 - p) * (1 - p) * (1 - p)
const easeOutBack = (p: number): number => {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2)
}
const easeOutBounce = (p: number): number => {
  const n = 7.5625
  const d = 2.75
  if (p < 1 / d) return n * p * p
  if (p < 2 / d) return n * (p -= 1.5 / d) * p + 0.75
  if (p < 2.5 / d) return n * (p -= 2.25 / d) * p + 0.9375
  return n * (p -= 2.625 / d) * p + 0.984375
}

/** Where a text event is in time: seconds since its start, its length, and its origin offset (word timings). */
export interface TextClock {
  t: number
  length: number
  origin: number
}

interface BlockMotion {
  alpha: number
  scale: number
  dx: number
  dy: number
  /** Characters shown (typewriter), Infinity = all. */
  chars: number
}

function blockMotion(c: TextContent, clock: TextClock | undefined, size: number, width: number, totalChars: number): BlockMotion {
  const m: BlockMotion = { alpha: 1, scale: 1, dx: 0, dy: 0, chars: Infinity }
  if (!clock) return m
  const d = Math.max(0.05, c.animDuration)
  if (c.animIn !== 'none') {
    const typeTime = Math.max(d, totalChars * 0.045)
    const p = clamp01(clock.t / (c.animIn === 'typewriter' ? Math.min(typeTime, clock.length * 0.8) : d))
    switch (c.animIn) {
      case 'fade':
        m.alpha *= easeOut(p)
        break
      case 'pop':
        m.scale *= Math.max(0, easeOutBack(p))
        m.alpha *= clamp01(p * 3)
        break
      case 'zoom':
        m.scale *= 1.6 - 0.6 * easeOut(p)
        m.alpha *= easeOut(p)
        break
      case 'slideUp':
        m.dy += (1 - easeOut(p)) * size * 1.3
        m.alpha *= easeOut(p)
        break
      case 'slideLeft':
        m.dx += (1 - easeOut(p)) * width * 0.2
        m.alpha *= easeOut(p)
        break
      case 'bounce':
        m.dy -= (1 - easeOutBounce(p)) * size * 2.2
        m.alpha *= clamp01(p * 4)
        break
      case 'typewriter':
        m.chars = Math.floor(totalChars * p + 1e-6)
        break
    }
  }
  if (c.animOut !== 'none') {
    const p = clamp01((clock.length - clock.t) / d)
    switch (c.animOut) {
      case 'fade':
        m.alpha *= easeOut(p)
        break
      case 'pop':
        m.scale *= p < 1 ? Math.max(0, easeOutBack(p)) : 1
        m.alpha *= clamp01(p * 3)
        break
      case 'zoom':
        m.scale *= 1 + (1 - easeOut(p)) * 0.6
        m.alpha *= easeOut(p)
        break
      case 'slideDown':
        m.dy += (1 - easeOut(p)) * size * 1.3
        m.alpha *= easeOut(p)
        break
    }
  }
  return m
}

/** Progress bar text events: a track and a fill that grows from left to right over the event. */
function drawProgressBar(ctx: Ctx, c: TextContent, width: number, height: number, alpha: number, clock?: TextClock): void {
  const scale = Math.min(width, height) / 1080
  const thickness = Math.max(2, c.size * scale * 0.4)
  const barWidth = c.maxWidth * width
  const left = c.align === 'left' ? c.x * width : c.align === 'right' ? c.x * width - barWidth : c.x * width - barWidth / 2
  const top = Math.min(height - thickness, Math.max(0, c.y * height - thickness / 2))
  const progress = clock ? clamp01(clock.t / Math.max(0.001, clock.length)) : 0.6
  const radius = c.maxWidth >= 0.999 ? 0 : thickness / 2
  ctx.save()
  ctx.globalAlpha = alpha
  if (c.boxColor) {
    ctx.fillStyle = rgba(c.boxColor, c.boxOpacity)
    roundRect(ctx, left, top, barWidth, thickness, radius)
  }
  ctx.fillStyle = c.highlightColor
  if (progress > 0) roundRect(ctx, left, top, barWidth * progress, thickness, radius)
  ctx.restore()
}

/** Index of the word being spoken (-1 before the first), from the word timings. */
function activeWord(words: CaptionWord[] | null, clock: TextClock | undefined): number {
  if (!words || words.length === 0) return -1
  if (!clock) return 0
  const t = clock.t + clock.origin
  let active = -1
  for (let i = 0; i < words.length; i++) if (words[i].start <= t) active = i
  return active
}

/**
 * Renders a text event into an output-sized context. `clock` (absent in
 * thumbnails) drives the in/out animation and the timed words of captions.
 */
export function drawText(ctx: Ctx, c: TextContent, width: number, height: number, alpha: number, clock?: TextClock): void {
  if (c.progressBar) {
    drawProgressBar(ctx, c, width, height, alpha, clock)
    return
  }
  fontReady(c.font)
  ctx.save()
  const layout = layoutText(ctx, c, width, height)
  const { size, scale, lineHeight, lines, box } = layout
  const totalChars = lines.reduce((n, l) => n + l.words.reduce((k, w) => k + w.text.length + 1, 0), 0)
  const motion = blockMotion(c, clock, size, width, totalChars)
  ctx.globalAlpha = alpha * motion.alpha
  if (ctx.globalAlpha <= 0.001) {
    ctx.restore()
    return
  }
  // Block transform around its center (pop, zoom, slides).
  const cx = box.left + box.width / 2
  const cy = box.top + box.height / 2
  ctx.translate(cx + motion.dx, cy + motion.dy)
  ctx.scale(motion.scale, motion.scale)
  ctx.translate(-cx, -cy)

  const words = c.words && c.wordStyle !== 'none' && c.words.length === lines.reduce((n, l) => n + l.words.length, 0) ? c.words : null
  const active = words ? activeWord(words, clock) : -1
  const wordT = clock ? clock.t + clock.origin : 0

  // Typewriter: how many characters of each word are visible.
  let budget = motion.chars
  const visibleText = (w: PlacedWord): string => {
    if (budget === Infinity) return w.text
    const shown = w.text.slice(0, Math.max(0, budget))
    budget -= w.text.length + 1
    return shown
  }

  type Item = { word: PlacedWord; y: number; text: string; color: string; scale: number; alpha: number; box: boolean }
  const items: Item[] = []
  for (const line of lines) {
    for (const w of line.words) {
      let text = visibleText(w)
      let color = w.emphasis ? c.emphasisColor : c.color
      let s = w.emphasis ? EMPHASIS_SCALE : 1
      let a = 1
      let wordBox = false
      if (words) {
        const timing = words[w.index]
        const isActive = w.index === active
        const since = wordT - timing.start
        const popIn = clock ? Math.max(0, easeOutBack(clamp01(since / 0.16))) : 1
        switch (c.wordStyle) {
          case 'highlight':
            if (isActive) {
              color = c.highlightColor
              s *= 1 + 0.07 * (1 - clamp01(since / 0.2))
            }
            break
          case 'box':
            if (isActive) wordBox = true
            break
          case 'pop':
            if (clock && w.index > active) text = ''
            else if (isActive) {
              s *= 0.6 + 0.4 * popIn
              color = c.highlightColor
            }
            break
          case 'reveal':
            if (clock && w.index > active) a = 0.35
            else if (isActive) color = c.highlightColor
            break
          case 'single':
            if (!isActive) text = ''
            else s *= 0.55 + 0.45 * popIn
            break
        }
      }
      if (text) items.push({ word: w, y: line.y, text, color, scale: s, alpha: a, box: wordBox })
    }
  }

  // One word at a time: the current word is centered on the anchor.
  if (words && c.wordStyle === 'single') {
    for (const item of items) {
      const center = c.align === 'left' ? c.x * width + item.word.width / 2 : c.align === 'right' ? c.x * width - item.word.width / 2 : c.x * width
      item.word = { ...item.word, x: center - item.word.width / 2 }
      item.y = c.y * height
    }
  }

  // Background boxes.
  if (c.boxColor) {
    ctx.fillStyle = rgba(c.boxColor, c.boxOpacity)
    if (c.boxStyle === 'lines' || (words && c.wordStyle === 'single')) {
      const padX = size * 0.32
      const padY = (lineHeight - size) / 2 + size * 0.06
      const byLine = new Map<number, Item[]>()
      for (const item of items) byLine.set(item.y, [...(byLine.get(item.y) ?? []), item])
      for (const [y, row] of byLine) {
        const first = row[0].word
        const last = row[row.length - 1]
        const right = last.word.x + (last.text === last.word.text ? last.word.width : ctx.measureText(last.text).width)
        roundRect(ctx, first.x - padX, y - lineHeight / 2 - padY + size * 0.04, right - first.x + padX * 2, lineHeight + padY * 2 - size * 0.08, size * 0.28)
      }
    } else if (items.length > 0) {
      const padX = size * 0.45
      const padY = size * 0.22
      ctx.fillRect(box.left - padX, box.top - padY, box.width + padX * 2, box.height + padY * 2)
    }
  }

  for (const item of items) {
    const { word, y, text } = item
    const w = ctx.measureText(text).width
    const x = word.x + word.inset
    ctx.save()
    if (item.scale !== 1) {
      const wx = word.x + word.width / 2
      ctx.translate(wx, y)
      ctx.scale(item.scale, item.scale)
      ctx.translate(-wx, -y)
    }
    ctx.globalAlpha *= item.alpha
    if (item.box) {
      ctx.fillStyle = c.highlightColor
      const padX = size * 0.14
      const padY = size * 0.1
      roundRect(ctx, x - padX, y - size / 2 - padY, w + padX * 2, size + padY * 2, size * 0.2)
    }
    if (c.glow) {
      // Two blurred passes in the glow color, then the sharp text on top.
      ctx.shadowColor = c.glow
      ctx.fillStyle = c.glow
      ctx.shadowBlur = size * 0.5
      ctx.fillText(text, x, y)
      ctx.shadowBlur = size * 0.18
      ctx.fillText(text, x, y)
      ctx.shadowColor = 'transparent'
    } else if (c.shadow) {
      ctx.shadowColor = 'rgba(0,0,0,0.65)'
      ctx.shadowBlur = size * 0.12
      ctx.shadowOffsetY = size * 0.04
    }
    if (c.strokeWidth > 0) {
      ctx.lineJoin = 'round'
      ctx.miterLimit = 2
      ctx.lineWidth = c.strokeWidth * scale * 2
      ctx.strokeStyle = c.strokeColor
      ctx.strokeText(text, x, y)
      ctx.shadowColor = 'transparent'
    }
    ctx.fillStyle = item.color
    ctx.fillText(text, x, y)
    ctx.restore()
  }
  ctx.restore()
}

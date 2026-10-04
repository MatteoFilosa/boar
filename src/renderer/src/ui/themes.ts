import { useEditor } from '../core/store'

// Themes: the interface colors are CSS custom properties (styles.css :root),
// and a theme is a JSON file that sets them. The format is plain data, so
// anyone can write or share one and loading it is safe:
//
//   {
//     "boarTheme": 1,
//     "name": "My theme",
//     "author": "Me",
//     "base": "dark",                       // or "light": fills every color not given
//     "colors": { "accent": "#ff6a3d", "bg": "#101418" },
//     "backdrop": { "gradient": "linear-gradient(160deg, #101418, #2a1b3d)", "stars": true }
//   }
//
// Colors are any CSS color (#hex, rgb(), rgba()...); a see-through panel color
// shows the backdrop behind it. Unknown keys are ignored, invalid values are
// dropped, and nothing can load files or reach the network.

/** Every color a theme can set (the CSS custom properties without "--"). */
export const THEME_COLORS = [
  'bg', 'panel', 'panel-2', 'panel-3', 'input', 'border', 'border-soft',
  'text', 'text-strong', 'text-dim', 'text-faint', 'text-disabled',
  'accent', 'accent-soft', 'accent-strong', 'accent-strong-hover', 'accent-text', 'accent-light', 'on-accent',
  'chrome', 'sunken', 'well', 'raised', 'header', 'tile', 'hover', 'hover-strong', 'selected', 'selected-border',
  'line', 'line-strong', 'scroll-hover', 'button', 'button-hover',
  'warn', 'danger', 'danger-soft', 'ok', 'mute', 'solo', 'play', 'pause', 'stop',
  'timeline-bg', 'ruler', 'ruler-tick', 'ruler-tick-minor', 'ruler-text', 'track-a', 'track-b', 'track-selected', 'track-line', 'grid', 'cursor',
  'workspace'
] as const

export type ThemeColor = (typeof THEME_COLORS)[number]

export interface ThemeFile {
  boarTheme: 1
  name: string
  author?: string
  base: 'dark' | 'light'
  colors: Partial<Record<ThemeColor, string>>
  backdrop?: { gradient?: string; stars?: boolean }
}

export interface Theme extends ThemeFile {
  /** 'dark', 'light'... for the built-in ones, 'user:...' for loaded files. */
  id: string
}

const DARK: Record<ThemeColor, string> = {
  bg: '#1c1c1f', panel: '#26272b', 'panel-2': '#2d2e33', 'panel-3': '#34363c', input: '#18191c', border: '#0e0f11', 'border-soft': '#3a3c42',
  text: '#d8dae0', 'text-strong': '#e9ebf0', 'text-dim': '#9599a3', 'text-faint': '#6b6f79', 'text-disabled': '#575a62',
  accent: '#4f9cff', 'accent-soft': 'rgba(79, 156, 255, 0.18)', 'accent-strong': '#2f6fd0', 'accent-strong-hover': '#3a7ce0',
  'accent-text': '#c4dcff', 'accent-light': '#8fb8ff', 'on-accent': '#ffffff',
  chrome: '#202125', sunken: '#17181b', well: '#111214', raised: '#2b2c31', header: '#222327', tile: '#24252a', hover: '#2f3137',
  'hover-strong': '#3a3d46', selected: '#283244', 'selected-border': '#3f6fb0',
  line: '#34363c', 'line-strong': '#474a52', 'scroll-hover': '#5a5d66', button: '#3a3c42', 'button-hover': '#45474e',
  warn: '#ffb547', danger: '#ff6161', 'danger-soft': '#6b2b2b', ok: '#8fe3a8', mute: '#e0574f', solo: '#e8c33f', play: '#45c463', pause: '#e8b33a', stop: '#ef5350',
  'timeline-bg': '#1d1e21', ruler: '#25262b', 'ruler-tick': '#8d909a', 'ruler-tick-minor': '#5b5e66', 'ruler-text': '#b9bcc6',
  'track-a': '#2a2b30', 'track-b': '#27282d', 'track-selected': '#323642', 'track-line': 'rgba(0, 0, 0, 0.55)', grid: 'rgba(255, 255, 255, 0.035)', cursor: '#f2f2f2',
  workspace: '#141518'
}

const LIGHT: Record<ThemeColor, string> = {
  bg: '#e6e8ec', panel: '#f3f4f6', 'panel-2': '#eaecf0', 'panel-3': '#dcdfe5', input: '#ffffff', border: '#c2c6ce', 'border-soft': '#d3d6dd',
  text: '#23262c', 'text-strong': '#0f1115', 'text-dim': '#5b606a', 'text-faint': '#878c96', 'text-disabled': '#a7abb3',
  accent: '#2f6fd0', 'accent-soft': 'rgba(47, 111, 208, 0.14)', 'accent-strong': '#2f6fd0', 'accent-strong-hover': '#3a7ce0',
  'accent-text': '#1e4c9a', 'accent-light': '#2f6fd0', 'on-accent': '#ffffff',
  chrome: '#f7f8fa', sunken: '#e1e4e9', well: '#d6d9df', raised: '#ffffff', header: '#eceef2', tile: '#f6f7f9', hover: '#e3e7ee',
  'hover-strong': '#d8dfea', selected: '#d4e2fa', 'selected-border': '#6f9be0',
  line: '#d6d9df', 'line-strong': '#b7bcc5', 'scroll-hover': '#9aa0aa', button: '#e6e8ed', 'button-hover': '#dadde4',
  warn: '#b86e00', danger: '#d23c3c', 'danger-soft': '#f4cfcf', ok: '#1f8a3d', mute: '#d6453d', solo: '#c99a00', play: '#2e9e4b', pause: '#c98f00', stop: '#d64040',
  'timeline-bg': '#e2e5ea', ruler: '#eceef2', 'ruler-tick': '#6b707a', 'ruler-tick-minor': '#a3a7af', 'ruler-text': '#3b3f47',
  'track-a': '#eef0f3', 'track-b': '#e7e9ee', 'track-selected': '#d8e3f6', 'track-line': 'rgba(0, 0, 0, 0.12)', grid: 'rgba(0, 0, 0, 0.05)', cursor: '#15171b',
  workspace: '#c9ccd3'
}

/** The themes that come with Boar. */
export const BUILT_IN_THEMES: Theme[] = [
  { id: 'dark', boarTheme: 1, name: 'Dark', author: 'Boar', base: 'dark', colors: {} },
  { id: 'light', boarTheme: 1, name: 'Light', author: 'Boar', base: 'light', colors: {} },
  {
    id: 'galaxy',
    boarTheme: 1,
    name: 'Galaxy',
    author: 'Boar',
    base: 'dark',
    colors: {
      bg: 'rgba(11, 10, 29, 0.3)', panel: 'rgba(20, 16, 46, 0.6)', 'panel-2': 'rgba(30, 24, 64, 0.72)', 'panel-3': '#382e6e', input: 'rgba(12, 10, 32, 0.9)',
      border: '#060512', 'border-soft': '#3a3070', text: '#e2dcfa', 'text-strong': '#f6f2ff', 'text-dim': '#a69dcb', 'text-faint': '#776fa0',
      'text-disabled': '#564e82', accent: '#a36bff', 'accent-soft': 'rgba(163, 107, 255, 0.22)', 'accent-strong': '#7c4dff',
      'accent-strong-hover': '#9066ff', 'accent-text': '#ddcdff', 'accent-light': '#c4a5ff',
      chrome: 'rgba(14, 11, 34, 0.72)', sunken: 'rgba(10, 8, 26, 0.6)', well: 'rgba(6, 5, 18, 0.9)', raised: 'rgba(30, 24, 64, 0.97)',
      header: 'rgba(24, 19, 54, 0.8)', tile: 'rgba(36, 29, 76, 0.8)', hover: 'rgba(60, 48, 120, 0.7)', 'hover-strong': '#3c3184',
      selected: 'rgba(110, 70, 220, 0.38)', 'selected-border': '#8b5cf6', line: 'rgba(120, 100, 220, 0.25)', 'line-strong': '#4b4090',
      'scroll-hover': '#6c5fb0', button: 'rgba(56, 45, 112, 0.85)', 'button-hover': '#46398e',
      'timeline-bg': 'rgba(10, 8, 28, 0.45)', ruler: 'rgba(22, 18, 52, 0.7)', 'ruler-tick': '#9d8fd6', 'ruler-tick-minor': '#5b5388',
      'ruler-text': '#d2c8f6', 'track-a': 'rgba(34, 27, 72, 0.5)', 'track-b': 'rgba(26, 21, 58, 0.5)', 'track-selected': 'rgba(110, 70, 220, 0.34)',
      grid: 'rgba(196, 165, 255, 0.06)', cursor: '#ffffff', workspace: 'rgba(8, 7, 26, 0.55)'
    },
    backdrop: {
      gradient:
        'radial-gradient(ellipse at 18% 12%, rgba(124, 77, 255, 0.38), transparent 52%), radial-gradient(ellipse at 86% 78%, rgba(0, 170, 255, 0.26), transparent 55%), radial-gradient(ellipse at 60% 40%, rgba(255, 80, 180, 0.12), transparent 45%), linear-gradient(160deg, #0b0a1f, #120a2a 50%, #06101f)',
      stars: true
    }
  },
  {
    id: 'ember',
    boarTheme: 1,
    name: 'Ember',
    author: 'Boar',
    base: 'dark',
    colors: {
      bg: '#1b1816', panel: '#25211e', 'panel-2': '#2c2723', 'panel-3': '#3a332d', input: '#171412', border: '#0d0b0a', 'border-soft': '#40372f',
      text: '#ece2d8', 'text-strong': '#fff6ec', 'text-dim': '#a8998b', 'text-faint': '#7b6e62', accent: '#f28c28',
      'accent-soft': 'rgba(242, 140, 40, 0.2)', 'accent-strong': '#d9731a', 'accent-strong-hover': '#ea8226', 'accent-text': '#ffd3a8',
      'accent-light': '#ffb066', 'on-accent': '#1a1006', chrome: '#1f1b18', sunken: '#16130f', well: '#100d0b', raised: '#2b2622',
      header: '#221e1b', tile: '#26211d', hover: '#332c26', 'hover-strong': '#40362d', selected: '#3d2c1c', 'selected-border': '#c96d1c',
      line: '#3a322b', 'line-strong': '#52473d', button: '#3a322b', 'button-hover': '#463c33', 'timeline-bg': '#1d1a17',
      ruler: '#26211d', 'track-a': '#2b2622', 'track-b': '#27221e', 'track-selected': '#3a2c1f', workspace: '#14110f'
    }
  }
]

const isColor = (v: unknown): v is string => typeof v === 'string' && v.length < 80 && !/url\(/i.test(v) && CSS.supports('color', v)
const isGradient = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length < 2000 &&
  /^\s*(repeating-)?(linear|radial|conic)-gradient\(/i.test(v) &&
  !/url\(|image\(|element\(/i.test(v) &&
  CSS.supports('background-image', v)

/** A theme file checked and cleaned (throws a readable error when it is not a theme). */
export function parseTheme(json: string): ThemeFile {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(json) as Record<string, unknown>
  } catch {
    throw new Error('This is not a JSON file')
  }
  if (!data || data.boarTheme !== 1) throw new Error('Not a Boar theme ("boarTheme": 1 is missing)')
  const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim().slice(0, 40) : 'Untitled theme'
  const colors: Partial<Record<ThemeColor, string>> = {}
  const given = (data.colors ?? {}) as Record<string, unknown>
  for (const key of THEME_COLORS) if (isColor(given[key])) colors[key] = (given[key] as string).trim()
  const backdropIn = (data.backdrop ?? {}) as Record<string, unknown>
  const backdrop: ThemeFile['backdrop'] = {}
  if (isGradient(backdropIn.gradient)) backdrop.gradient = backdropIn.gradient.trim()
  if (backdropIn.stars === true) backdrop.stars = true
  return {
    boarTheme: 1,
    name,
    author: typeof data.author === 'string' ? data.author.trim().slice(0, 40) : undefined,
    base: data.base === 'light' ? 'light' : 'dark',
    colors,
    backdrop: backdrop.gradient || backdrop.stars ? backdrop : undefined
  }
}

/** Every color of a theme, its base filling the ones it does not set. */
export function resolvedColors(theme: ThemeFile): Record<ThemeColor, string> {
  return { ...(theme.base === 'light' ? LIGHT : DARK), ...theme.colors }
}

/** A star field as layered gradients, tiled at a few sizes so it does not look like a grid. */
function stars(): { image: string; size: string } {
  const dots: string[] = []
  const sizes: string[] = []
  const tiles = [
    { size: 230, count: 9, alpha: 0.85 },
    { size: 370, count: 7, alpha: 0.6 },
    { size: 610, count: 6, alpha: 0.95 }
  ]
  let seed = 7
  const random = (): number => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646
  for (const tile of tiles) {
    for (let i = 0; i < tile.count; i++) {
      const r = random() < 0.2 ? 1.6 : 1
      dots.push(`radial-gradient(${r}px ${r}px at ${Math.round(random() * tile.size)}px ${Math.round(random() * tile.size)}px, rgba(255, 255, 255, ${tile.alpha}), transparent)`)
      sizes.push(`${tile.size}px ${tile.size}px`)
    }
  }
  return { image: dots.join(', '), size: sizes.join(', ') }
}

const listeners = new Set<() => void>()
const colorCache = new Map<string, string>()

/** Called after a theme is applied (canvases read their colors again). */
export function onThemeChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** A theme color for canvas drawing, e.g. themeColor('timeline-bg'). */
export function themeColor(name: ThemeColor): string {
  let value = colorCache.get(name)
  if (value === undefined) {
    value = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim() || DARK[name]
    colorCache.set(name, value)
  }
  return value
}

/** Puts a theme on the interface. */
export function applyTheme(theme: ThemeFile): void {
  const root = document.documentElement
  for (const [key, value] of Object.entries(resolvedColors(theme))) root.style.setProperty(`--${key}`, value)
  // Native controls (scrollbars, pickers, menus of selects) follow the base.
  root.style.colorScheme = theme.base
  const body = document.body
  const layers: { image: string; size: string }[] = []
  if (theme.backdrop?.stars) layers.push(stars())
  if (theme.backdrop?.gradient) layers.push({ image: theme.backdrop.gradient, size: theme.backdrop.gradient.split(/,(?![^(]*\))/).map(() => '100% 100%').join(', ') })
  body.style.backgroundImage = layers.map((l) => l.image).join(', ')
  body.style.backgroundSize = layers.map((l) => l.size).join(', ')
  body.style.backgroundAttachment = layers.length ? 'fixed' : ''
  colorCache.clear()
  for (const listener of listeners) listener()
}

// Loaded theme files are kept in this browser profile (they are small).

const USER_KEY = 'boar.themes'

export function userThemes(): Theme[] {
  try {
    const list = JSON.parse(localStorage.getItem(USER_KEY) ?? '[]') as Theme[]
    return Array.isArray(list) ? list.filter((t) => typeof t?.id === 'string' && t.id.startsWith('user:')) : []
  } catch {
    return []
  }
}

function saveUserThemes(list: Theme[]): void {
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(list))
  } catch {
    // Storage full or unavailable: the theme still applies for this session.
  }
}

export function addUserTheme(file: ThemeFile): Theme {
  const theme: Theme = { ...file, id: `user:${Date.now().toString(36)}` }
  saveUserThemes([...userThemes(), theme])
  return theme
}

export function removeUserTheme(id: string): void {
  saveUserThemes(userThemes().filter((t) => t.id !== id))
}

export function allThemes(): Theme[] {
  return [...BUILT_IN_THEMES, ...userThemes()]
}

export const themeById = (id: string): Theme => allThemes().find((t) => t.id === id) ?? BUILT_IN_THEMES[0]

/** Applies the theme in the options now and whenever it changes. */
export function startThemes(): void {
  let id = useEditor.getState().options.theme
  applyTheme(themeById(id))
  useEditor.subscribe((s) => {
    if (s.options.theme === id) return
    id = s.options.theme
    applyTheme(themeById(id))
  })
}

/** A theme as a file to share or edit: every color written out, so it is a complete template. */
export function themeFileText(theme: ThemeFile): string {
  const file: ThemeFile = {
    boarTheme: 1,
    name: theme.name,
    author: theme.author,
    base: theme.base,
    colors: resolvedColors(theme),
    ...(theme.backdrop ? { backdrop: theme.backdrop } : {})
  }
  return `${JSON.stringify(file, null, 2)}\n`
}

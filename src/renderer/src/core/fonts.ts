// Bundled fonts for text events (Fontsource, Latin subset), loaded lazily. Other
// scripts fall back to the system font.
import abrilFatface from '@fontsource/abril-fatface/files/abril-fatface-latin-400-normal.woff2?url'
import anton from '@fontsource/anton/files/anton-latin-400-normal.woff2?url'
import archivoBlack from '@fontsource/archivo-black/files/archivo-black-latin-400-normal.woff2?url'
import bangers from '@fontsource/bangers/files/bangers-latin-400-normal.woff2?url'
import barlowCondensed500 from '@fontsource/barlow-condensed/files/barlow-condensed-latin-500-normal.woff2?url'
import barlowCondensed800 from '@fontsource/barlow-condensed/files/barlow-condensed-latin-800-normal.woff2?url'
import bebasNeue from '@fontsource/bebas-neue/files/bebas-neue-latin-400-normal.woff2?url'
import bungee from '@fontsource/bungee/files/bungee-latin-400-normal.woff2?url'
import courierPrime400 from '@fontsource/courier-prime/files/courier-prime-latin-400-normal.woff2?url'
import courierPrime700 from '@fontsource/courier-prime/files/courier-prime-latin-700-normal.woff2?url'
import dmSerifDisplay from '@fontsource/dm-serif-display/files/dm-serif-display-latin-400-normal.woff2?url'
import instrumentSerif from '@fontsource/instrument-serif/files/instrument-serif-latin-400-normal.woff2?url'
import lilitaOne from '@fontsource/lilita-one/files/lilita-one-latin-400-normal.woff2?url'
import lobster from '@fontsource/lobster/files/lobster-latin-400-normal.woff2?url'
import luckiestGuy from '@fontsource/luckiest-guy/files/luckiest-guy-latin-400-normal.woff2?url'
import monoton from '@fontsource/monoton/files/monoton-latin-400-normal.woff2?url'
import pacifico from '@fontsource/pacifico/files/pacifico-latin-400-normal.woff2?url'
import permanentMarker from '@fontsource/permanent-marker/files/permanent-marker-latin-400-normal.woff2?url'
import poppins400 from '@fontsource/poppins/files/poppins-latin-400-normal.woff2?url'
import poppins800 from '@fontsource/poppins/files/poppins-latin-800-normal.woff2?url'
import poppins900 from '@fontsource/poppins/files/poppins-latin-900-normal.woff2?url'
import pressStart2p from '@fontsource/press-start-2p/files/press-start-2p-latin-400-normal.woff2?url'
import righteous from '@fontsource/righteous/files/righteous-latin-400-normal.woff2?url'
import shrikhand from '@fontsource/shrikhand/files/shrikhand-latin-400-normal.woff2?url'
import specialElite from '@fontsource/special-elite/files/special-elite-latin-400-normal.woff2?url'
import yellowtail from '@fontsource/yellowtail/files/yellowtail-latin-400-normal.woff2?url'
import caveat from '@fontsource-variable/caveat/files/caveat-latin-wght-normal.woff2?url'
import dancingScript from '@fontsource-variable/dancing-script/files/dancing-script-latin-wght-normal.woff2?url'
import fredoka from '@fontsource-variable/fredoka/files/fredoka-latin-wght-normal.woff2?url'
import inter from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url'
import leagueSpartan from '@fontsource-variable/league-spartan/files/league-spartan-latin-wght-normal.woff2?url'
import montserrat from '@fontsource-variable/montserrat/files/montserrat-latin-wght-normal.woff2?url'
import montserratItalic from '@fontsource-variable/montserrat/files/montserrat-latin-wght-italic.woff2?url'
import nunito from '@fontsource-variable/nunito/files/nunito-latin-wght-normal.woff2?url'
import oswald from '@fontsource-variable/oswald/files/oswald-latin-wght-normal.woff2?url'
import outfit from '@fontsource-variable/outfit/files/outfit-latin-wght-normal.woff2?url'
import playfairDisplay from '@fontsource-variable/playfair-display/files/playfair-display-latin-wght-normal.woff2?url'
import playfairDisplayItalic from '@fontsource-variable/playfair-display/files/playfair-display-latin-wght-italic.woff2?url'
import rubik from '@fontsource-variable/rubik/files/rubik-latin-wght-normal.woff2?url'
import sora from '@fontsource-variable/sora/files/sora-latin-wght-normal.woff2?url'
import spaceGrotesk from '@fontsource-variable/space-grotesk/files/space-grotesk-latin-wght-normal.woff2?url'
import tiktokSans from '@fontsource-variable/tiktok-sans/files/tiktok-sans-latin-wght-normal.woff2?url'
import tiltNeon from '@fontsource-variable/tilt-neon/files/tilt-neon-latin-full-normal.woff2?url'
import unbounded from '@fontsource-variable/unbounded/files/unbounded-latin-wght-normal.woff2?url'

export type FontCategory = 'Captions & Sans' | 'Condensed' | 'Display & Fun' | 'Serif' | 'Script & Hand' | 'Typewriter' | 'System'

interface FontFile {
  url: string
  /** CSS font-weight descriptor: a single weight or a range for variable fonts. */
  weight: string
  style?: 'normal' | 'italic'
}

export interface FontInfo {
  family: string
  category: FontCategory
  /** Weights used for regular and bold text (fonts with one weight never get a fake bold). */
  regular: number
  bold: number
  /** Bundled files; none for fonts installed with Windows. */
  files: FontFile[]
}

const variable = (url: string, range: string, italic?: string): FontFile[] =>
  italic ? [{ url, weight: range }, { url: italic, weight: range, style: 'italic' }] : [{ url, weight: range }]
const single = (url: string): FontFile[] => [{ url, weight: '400' }]

export const FONT_CATALOG: FontInfo[] = [
  { family: 'TikTok Sans', category: 'Captions & Sans', regular: 400, bold: 800, files: variable(tiktokSans, '300 900') },
  { family: 'Montserrat', category: 'Captions & Sans', regular: 400, bold: 900, files: variable(montserrat, '100 900', montserratItalic) },
  {
    family: 'Poppins',
    category: 'Captions & Sans',
    regular: 400,
    bold: 800,
    files: [
      { url: poppins400, weight: '400' },
      { url: poppins800, weight: '800' },
      { url: poppins900, weight: '900' }
    ]
  },
  { family: 'Inter', category: 'Captions & Sans', regular: 400, bold: 800, files: variable(inter, '100 900') },
  { family: 'Outfit', category: 'Captions & Sans', regular: 400, bold: 800, files: variable(outfit, '100 900') },
  { family: 'League Spartan', category: 'Captions & Sans', regular: 400, bold: 800, files: variable(leagueSpartan, '100 900') },
  { family: 'Rubik', category: 'Captions & Sans', regular: 400, bold: 800, files: variable(rubik, '300 900') },
  { family: 'Nunito', category: 'Captions & Sans', regular: 400, bold: 900, files: variable(nunito, '200 1000') },
  { family: 'Space Grotesk', category: 'Captions & Sans', regular: 400, bold: 700, files: variable(spaceGrotesk, '300 700') },
  { family: 'Sora', category: 'Captions & Sans', regular: 400, bold: 800, files: variable(sora, '100 800') },
  { family: 'Unbounded', category: 'Captions & Sans', regular: 400, bold: 800, files: variable(unbounded, '200 900') },
  { family: 'Bebas Neue', category: 'Condensed', regular: 400, bold: 400, files: single(bebasNeue) },
  { family: 'Anton', category: 'Condensed', regular: 400, bold: 400, files: single(anton) },
  { family: 'Oswald', category: 'Condensed', regular: 400, bold: 700, files: variable(oswald, '200 700') },
  {
    family: 'Barlow Condensed',
    category: 'Condensed',
    regular: 500,
    bold: 800,
    files: [
      { url: barlowCondensed500, weight: '500' },
      { url: barlowCondensed800, weight: '800' }
    ]
  },
  { family: 'Archivo Black', category: 'Condensed', regular: 400, bold: 400, files: single(archivoBlack) },
  { family: 'Luckiest Guy', category: 'Display & Fun', regular: 400, bold: 400, files: single(luckiestGuy) },
  { family: 'Bangers', category: 'Display & Fun', regular: 400, bold: 400, files: single(bangers) },
  { family: 'Lilita One', category: 'Display & Fun', regular: 400, bold: 400, files: single(lilitaOne) },
  { family: 'Fredoka', category: 'Display & Fun', regular: 400, bold: 700, files: variable(fredoka, '300 700') },
  { family: 'Bungee', category: 'Display & Fun', regular: 400, bold: 400, files: single(bungee) },
  { family: 'Righteous', category: 'Display & Fun', regular: 400, bold: 400, files: single(righteous) },
  { family: 'Shrikhand', category: 'Display & Fun', regular: 400, bold: 400, files: single(shrikhand) },
  { family: 'Tilt Neon', category: 'Display & Fun', regular: 400, bold: 400, files: single(tiltNeon) },
  { family: 'Monoton', category: 'Display & Fun', regular: 400, bold: 400, files: single(monoton) },
  { family: 'Press Start 2P', category: 'Display & Fun', regular: 400, bold: 400, files: single(pressStart2p) },
  {
    family: 'Playfair Display',
    category: 'Serif',
    regular: 400,
    bold: 800,
    files: variable(playfairDisplay, '400 900', playfairDisplayItalic)
  },
  { family: 'DM Serif Display', category: 'Serif', regular: 400, bold: 400, files: single(dmSerifDisplay) },
  { family: 'Abril Fatface', category: 'Serif', regular: 400, bold: 400, files: single(abrilFatface) },
  { family: 'Instrument Serif', category: 'Serif', regular: 400, bold: 400, files: single(instrumentSerif) },
  { family: 'Pacifico', category: 'Script & Hand', regular: 400, bold: 400, files: single(pacifico) },
  { family: 'Lobster', category: 'Script & Hand', regular: 400, bold: 400, files: single(lobster) },
  { family: 'Dancing Script', category: 'Script & Hand', regular: 400, bold: 700, files: variable(dancingScript, '400 700') },
  { family: 'Yellowtail', category: 'Script & Hand', regular: 400, bold: 400, files: single(yellowtail) },
  { family: 'Caveat', category: 'Script & Hand', regular: 400, bold: 700, files: variable(caveat, '400 700') },
  { family: 'Permanent Marker', category: 'Script & Hand', regular: 400, bold: 400, files: single(permanentMarker) },
  { family: 'Special Elite', category: 'Typewriter', regular: 400, bold: 400, files: single(specialElite) },
  {
    family: 'Courier Prime',
    category: 'Typewriter',
    regular: 400,
    bold: 700,
    files: [
      { url: courierPrime400, weight: '400' },
      { url: courierPrime700, weight: '700' }
    ]
  },
  ...['Segoe UI', 'Arial', 'Arial Black', 'Bahnschrift', 'Impact', 'Georgia', 'Times New Roman', 'Consolas', 'Comic Sans MS'].map(
    (family): FontInfo => ({ family, category: 'System', regular: 400, bold: 800, files: [] })
  )
]

export const FONT_CATEGORIES: FontCategory[] = [
  'Captions & Sans',
  'Condensed',
  'Display & Fun',
  'Serif',
  'Script & Hand',
  'Typewriter',
  'System'
]

const byFamily = new Map(FONT_CATALOG.map((f) => [f.family, f]))
export const fontInfo = (family: string): FontInfo | undefined => byFamily.get(family)

const installed = new Map<string, boolean>()

/** Whether a system font exists here: a sample drawn with it differs from the fallback's. */
export function systemFontInstalled(family: string): boolean {
  let known = installed.get(family)
  if (known === undefined) {
    const ctx = document.createElement('canvas').getContext('2d')
    const sample = 'mmmmmmmmmmlli WQ@ 0123456789'
    known =
      !ctx ||
      ['monospace', 'serif'].some((fallback) => {
        ctx.font = `72px ${fallback}`
        const base = ctx.measureText(sample).width
        ctx.font = `72px "${family}", ${fallback}`
        return ctx.measureText(sample).width !== base
      })
    installed.set(family, known)
  }
  return known
}

// Loading

const loading = new Map<string, Promise<void>>()
const loaded = new Set<string>()
const listeners = new Set<() => void>()

/** Called when a bundled font finished loading (canvases drawn with a fallback must redraw). */
export function onFontLoaded(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function loadFont(family: string): Promise<void> {
  const info = byFamily.get(family)
  if (!info || info.files.length === 0 || loaded.has(family)) return Promise.resolve()
  let pending = loading.get(family)
  if (!pending) {
    pending = Promise.all(
      info.files.map((f) => {
        const face = new FontFace(family, `url(${f.url})`, { weight: f.weight, style: f.style ?? 'normal', display: 'block' })
        document.fonts.add(face)
        return face.load()
      })
    ).then(
      () => {
        loaded.add(family)
        for (const listener of listeners) listener()
      },
      (err: unknown) => {
        loading.delete(family)
        console.warn(`[fonts] cannot load ${family}`, err)
      }
    )
    loading.set(family, pending)
  }
  return pending
}

/** True when the font can be drawn now; otherwise starts loading it. */
export function fontReady(family: string): boolean {
  const info = byFamily.get(family)
  if (!info || info.files.length === 0 || loaded.has(family)) return true
  void loadFont(family)
  return false
}

export const loadFonts = (families: Iterable<string>): Promise<void> =>
  Promise.all([...new Set(families)].map(loadFont)).then(() => undefined)

export const loadAllFonts = (): Promise<void> => loadFonts(FONT_CATALOG.map((f) => f.family))

import { uid } from './ids'

// Event FX: a chain of effects stored on each event.
// Video effects run in WebGL (engine/videoFx.ts), audio effects in Web Audio
// (engine/audioFx.ts); both run the same way in the preview and in the export.

export type FxKind = 'video' | 'audio'

export interface EventFx {
  id: string
  type: string
  enabled: boolean
  params: Record<string, number>
}

export interface FxParam {
  key: string
  label: string
  min: number
  max: number
  step: number
  default: number
  unit?: string
  /** Shown value = value * scale (e.g. 100 for percentages). */
  scale?: number
  /** Choice parameter: the value is an index into these labels. */
  options?: string[]
}

export interface FxDef {
  type: string
  kind: FxKind
  label: string
  category: string
  description: string
  params: FxParam[]
}

const pct = (key: string, label: string, def: number, min = 0, max = 1): FxParam => ({
  key,
  label,
  min,
  max,
  step: 0.01,
  default: def,
  unit: '%',
  scale: 100
})
const num = (key: string, label: string, def: number, min: number, max: number, step: number, unit = ''): FxParam => ({
  key,
  label,
  min,
  max,
  step,
  default: def,
  unit
})
const choice = (key: string, label: string, options: string[], def = 0): FxParam => ({
  key,
  label,
  min: 0,
  max: options.length - 1,
  step: 1,
  default: def,
  options
})
const center = (): FxParam[] => [pct('cx', 'Center X', 0.5), pct('cy', 'Center Y', 0.5)]

export const LOOKS = ['Vivid', 'Warm', 'Cool', 'Faded', 'Teal & Orange', 'Vintage', 'Noir', 'Cinematic', 'Pastel', 'Golden hour']

export const VIDEO_FX: FxDef[] = [
  // AI
  {
    type: 'removeBg',
    kind: 'video',
    label: 'Remove Background (AI)',
    category: 'AI',
    description: 'Cuts out the person, no green screen needed (local AI)',
    params: [
      choice('mode', 'Background', ['Transparent', 'Blur', 'Darken', 'Black and white']),
      pct('threshold', 'Threshold', 0.5, 0.05, 0.95),
      pct('softness', 'Edge softness', 0.15, 0.01, 0.5),
      num('blur', 'Blur', 30, 2, 100, 1, ' px')
    ]
  },
  // Color
  { type: 'look', kind: 'video', label: 'Looks (filters)', category: 'Color', description: 'One-click color filters, Instagram style', params: [choice('look', 'Look', LOOKS), pct('intensity', 'Intensity', 1)] },
  {
    type: 'colorCorrector',
    kind: 'video',
    label: 'Color Corrector',
    category: 'Color',
    description: 'Exposure, contrast, saturation, temperature and more',
    params: [
      num('exposure', 'Exposure', 0, -2, 2, 0.01, ' EV'),
      pct('brightness', 'Brightness', 0, -1, 1),
      pct('contrast', 'Contrast', 0, -1, 1),
      pct('saturation', 'Saturation', 0, -1, 1),
      num('gamma', 'Gamma', 1, 0.2, 3, 0.01),
      num('hue', 'Hue shift', 0, -180, 180, 1, '°'),
      pct('temperature', 'Temperature', 0, -1, 1),
      pct('tint', 'Tint', 0, -1, 1)
    ]
  },
  { type: 'sepia', kind: 'video', label: 'Sepia', category: 'Color', description: 'Old photo brown tone', params: [pct('amount', 'Amount', 1)] },
  { type: 'blackWhite', kind: 'video', label: 'Black and White', category: 'Color', description: 'Removes color', params: [pct('amount', 'Amount', 1)] },
  { type: 'negative', kind: 'video', label: 'Negative', category: 'Color', description: 'Inverts the colors', params: [pct('amount', 'Amount', 1)] },
  {
    type: 'colorize',
    kind: 'video',
    label: 'Colorize (tint)',
    category: 'Color',
    description: 'Tints the picture with one color',
    params: [num('hue', 'Hue', 200, 0, 360, 1, '°'), pct('saturation', 'Saturation', 0.6), pct('amount', 'Amount', 0.8)]
  },
  { type: 'posterize', kind: 'video', label: 'Posterize', category: 'Color', description: 'Reduces the number of colors', params: [num('levels', 'Levels', 5, 2, 16, 1)] },
  {
    type: 'chromaKey',
    kind: 'video',
    label: 'Chroma Keyer (green screen)',
    category: 'Color',
    description: 'Makes a green or blue background transparent',
    params: [num('hue', 'Key hue', 120, 0, 360, 1, '°'), pct('tolerance', 'Tolerance', 0.3), pct('softness', 'Softness', 0.1), pct('spill', 'Spill removal', 0.5)]
  },
  // Blur
  { type: 'blur', kind: 'video', label: 'Gaussian Blur', category: 'Blur & Sharpen', description: 'Soft blur', params: [num('radius', 'Radius', 12, 0, 100, 0.5, ' px')] },
  { type: 'sharpen', kind: 'video', label: 'Sharpen', category: 'Blur & Sharpen', description: 'Crisper details', params: [num('amount', 'Amount', 0.8, 0, 3, 0.01)] },
  {
    type: 'glow',
    kind: 'video',
    label: 'Glow',
    category: 'Blur & Sharpen',
    description: 'Bright areas bloom',
    params: [pct('threshold', 'Threshold', 0.6), num('radius', 'Radius', 24, 1, 100, 0.5, ' px'), num('intensity', 'Intensity', 1, 0, 3, 0.01)]
  },
  { type: 'radialBlur', kind: 'video', label: 'Zoom Blur', category: 'Blur & Sharpen', description: 'Radial speed blur', params: [pct('amount', 'Amount', 0.3), ...center()] },
  // Stylize
  {
    type: 'vignette',
    kind: 'video',
    label: 'Vignette',
    category: 'Stylize',
    description: 'Darkens the edges',
    params: [pct('amount', 'Amount', 0.6), pct('size', 'Size', 0.5), pct('softness', 'Softness', 0.5)]
  },
  { type: 'grain', kind: 'video', label: 'Film Grain', category: 'Stylize', description: 'Animated film noise', params: [pct('amount', 'Amount', 0.25), num('size', 'Grain size', 1.5, 1, 6, 0.1, ' px')] },
  { type: 'vhs', kind: 'video', label: 'VHS', category: 'Stylize', description: 'Old tape: scanlines, color bleed, jitter', params: [pct('amount', 'Amount', 0.7)] },
  { type: 'glitch', kind: 'video', label: 'Glitch', category: 'Stylize', description: 'Digital glitch bursts', params: [pct('amount', 'Amount', 0.5), num('speed', 'Speed', 4, 0.5, 15, 0.1)] },
  {
    type: 'chromatic',
    kind: 'video',
    label: 'RGB Split',
    category: 'Stylize',
    description: 'Chromatic aberration',
    params: [num('amount', 'Amount', 6, 0, 40, 0.5, ' px'), num('angle', 'Angle', 0, 0, 360, 1, '°')]
  },
  { type: 'pixelate', kind: 'video', label: 'Pixelate', category: 'Stylize', description: 'Mosaic blocks', params: [num('size', 'Block size', 16, 2, 120, 1, ' px')] },
  {
    type: 'mirror',
    kind: 'video',
    label: 'Mirror / Flip',
    category: 'Stylize',
    description: 'Mirror halves or flip the picture',
    params: [choice('mode', 'Mode', ['Left half → right', 'Right half → left', 'Top half → bottom', 'Bottom half → top', 'Quad', 'Flip horizontal', 'Flip vertical'])]
  },
  {
    type: 'shake',
    kind: 'video',
    label: 'Camera Shake',
    category: 'Stylize',
    description: 'Handheld / impact shake',
    params: [pct('amount', 'Amount', 0.3), num('speed', 'Speed', 8, 0.5, 30, 0.1), num('zoom', 'Zoom', 1.1, 1, 1.5, 0.01, '×')]
  },
  // Distort
  { type: 'spherize', kind: 'video', label: 'Spherize', category: 'Distort', description: 'Bulge (positive) or pinch (negative)', params: [pct('amount', 'Amount', 0.6, -1, 1), pct('radius', 'Radius', 0.5, 0.05, 1), ...center()] },
  { type: 'twirl', kind: 'video', label: 'Twirl', category: 'Distort', description: 'Swirl around a point', params: [num('angle', 'Angle', 180, -720, 720, 1, '°'), pct('radius', 'Radius', 0.5, 0.05, 1), ...center()] },
  {
    type: 'wave',
    kind: 'video',
    label: 'Wave',
    category: 'Distort',
    description: 'Animated ripple',
    params: [num('amplitude', 'Amplitude', 0.02, 0, 0.1, 0.001), num('frequency', 'Frequency', 8, 1, 40, 0.1), num('speed', 'Speed', 1, 0, 10, 0.1), choice('direction', 'Direction', ['Horizontal', 'Vertical'])]
  }
]

export const EQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
const bandLabel = (f: number): string => (f >= 1000 ? `${f / 1000}k` : String(f))

export const NOISE_ALGORITHMS = ['AI voice (GTCRN)', 'AI voice (RNNoise)', 'Classic (Speex)']

export const AUDIO_FX: FxDef[] = [
  {
    type: 'noiseReduction',
    kind: 'audio',
    label: 'Noise Reduction',
    category: 'Clean Up',
    description: 'Removes background noise from voice (local AI)',
    params: [choice('algorithm', 'Algorithm', NOISE_ALGORITHMS), pct('amount', 'Amount', 1)]
  },
  {
    type: 'noiseGate',
    kind: 'audio',
    label: 'Noise Gate',
    category: 'Clean Up',
    description: 'Silences the audio below a threshold',
    params: [
      num('threshold', 'Threshold', -45, -80, 0, 0.5, ' dB'),
      num('range', 'Reduction', -60, -80, 0, 0.5, ' dB'),
      num('attack', 'Attack', 2, 0.1, 50, 0.1, ' ms'),
      num('release', 'Release', 150, 10, 1000, 1, ' ms')
    ]
  },
  {
    type: 'filter',
    kind: 'audio',
    label: 'Low / High Cut',
    category: 'Clean Up',
    description: 'High-pass, low-pass, band-pass or notch filter',
    params: [
      choice('mode', 'Mode', ['Low cut (high-pass)', 'High cut (low-pass)', 'Band-pass', 'Notch']),
      num('frequency', 'Frequency', 100, 20, 20000, 1, ' Hz'),
      num('q', 'Q', 0.71, 0.1, 20, 0.01)
    ]
  },
  {
    type: 'graphicEq',
    kind: 'audio',
    label: 'Graphic EQ (10 band)',
    category: 'EQ & Dynamics',
    description: 'Boost or cut 10 frequency bands',
    params: [...EQ_BANDS.map((f) => num(`b${f}`, bandLabel(f), 0, -12, 12, 0.1, ' dB')), num('output', 'Output', 0, -12, 12, 0.1, ' dB')]
  },
  {
    type: 'compressor',
    kind: 'audio',
    label: 'Compressor',
    category: 'EQ & Dynamics',
    description: 'Evens out loud and quiet parts',
    params: [
      num('threshold', 'Threshold', -24, -60, 0, 0.5, ' dB'),
      num('ratio', 'Ratio', 4, 1, 20, 0.1, ':1'),
      num('attack', 'Attack', 5, 0, 200, 0.5, ' ms'),
      num('release', 'Release', 150, 10, 1000, 1, ' ms'),
      num('knee', 'Knee', 10, 0, 40, 0.5, ' dB'),
      num('makeup', 'Makeup gain', 6, 0, 24, 0.1, ' dB')
    ]
  },
  {
    type: 'gain',
    kind: 'audio',
    label: 'Volume / Mono',
    category: 'EQ & Dynamics',
    description: 'Gain and mono downmix',
    params: [num('gain', 'Gain', 0, -24, 24, 0.1, ' dB'), choice('mode', 'Channels', ['Stereo', 'Mono'])]
  },
  {
    type: 'reverb',
    kind: 'audio',
    label: 'Reverb',
    category: 'Space',
    description: 'Room, hall or cathedral ambience',
    params: [
      num('decay', 'Decay', 2, 0.1, 10, 0.05, ' s'),
      num('preDelay', 'Pre-delay', 20, 0, 200, 1, ' ms'),
      pct('damping', 'Damping', 0.5),
      pct('mix', 'Mix', 0.3)
    ]
  },
  {
    type: 'echo',
    kind: 'audio',
    label: 'Echo / Delay',
    category: 'Space',
    description: 'Repeating echoes',
    params: [num('time', 'Time', 350, 10, 2000, 1, ' ms'), pct('feedback', 'Feedback', 0.4, 0, 0.95), pct('mix', 'Mix', 0.35)]
  },
  {
    type: 'chorus',
    kind: 'audio',
    label: 'Chorus / Flanger',
    category: 'Space',
    description: 'Modulated delay (feedback high = flanger)',
    params: [
      num('delay', 'Delay', 15, 1, 30, 0.1, ' ms'),
      num('rate', 'Rate', 1.2, 0.05, 10, 0.01, ' Hz'),
      pct('depth', 'Depth', 0.5),
      pct('feedback', 'Feedback', 0, 0, 0.9),
      pct('mix', 'Mix', 0.5)
    ]
  },
  {
    type: 'pitchShift',
    kind: 'audio',
    label: 'Pitch Shift',
    category: 'Creative',
    description: 'Higher (chipmunk) or deeper voice, same speed',
    params: [num('semitones', 'Pitch', 0, -12, 12, 0.1, ' st')]
  },
  {
    type: 'lofiVoice',
    kind: 'audio',
    label: 'Telephone / Radio',
    category: 'Creative',
    description: 'Telephone, old radio or megaphone voice',
    params: [choice('mode', 'Type', ['Telephone', 'Old radio', 'Megaphone']), pct('mix', 'Mix', 1)]
  },
  {
    type: 'distortion',
    kind: 'audio',
    label: 'Distortion',
    category: 'Creative',
    description: 'Overdrive and saturation',
    params: [pct('drive', 'Drive', 0.5), num('tone', 'Tone', 6000, 500, 16000, 10, ' Hz'), pct('mix', 'Mix', 1)]
  }
]

const DEFS = new Map([...VIDEO_FX, ...AUDIO_FX].map((d) => [d.type, d]))

export const fxDef = (type: string): FxDef | undefined => DEFS.get(type)

export function createFx(type: string): EventFx | null {
  const def = DEFS.get(type)
  if (!def) return null
  return { id: uid(), type, enabled: true, params: Object.fromEntries(def.params.map((p) => [p.key, p.default])) }
}

/** Parameter value with the default filled in (effects saved before a parameter existed). */
export function fxParam(fx: EventFx, key: string): number {
  const v = fx.params[key]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  return DEFS.get(fx.type)?.params.find((p) => p.key === key)?.default ?? 0
}

/** Enabled effects of one kind, in chain order. */
export function activeFx(fx: readonly EventFx[] | undefined, kind: FxKind): EventFx[] {
  if (!fx || fx.length === 0) return []
  return fx.filter((f) => f.enabled && DEFS.get(f.type)?.kind === kind)
}

export const cloneFx = (fx: readonly EventFx[]): EventFx[] => fx.map((f) => ({ ...f, params: { ...f.params } }))

export function formatParam(p: FxParam, value: number): string {
  if (p.options) return p.options[Math.round(value)] ?? ''
  const shown = value * (p.scale ?? 1)
  const digits = p.step * (p.scale ?? 1) >= 1 ? 0 : p.step * (p.scale ?? 1) >= 0.1 ? 1 : 2
  return `${shown.toFixed(digits)}${p.unit ?? ''}`
}

import type { ExportCodec, ExportEncoder } from './export'

// Which video encoders a render can use at the project's size and frame rate.
// Chromium rates a graphics card's encoder by the frame rate it keeps up in
// real time at the largest size of a tier (4K for anything above 1080p), so
// some cards are refused 1440p at 60 fps although they encode it. A render
// does not run in real time: told 30 fps (the lowest rate Chromium offers a
// tier at), the encoder takes the size, and each frame keeps its own time.
// Kept apart from export.ts so tests can load it.

export const VIDEO_CODECS: readonly ExportCodec[] = ['avc', 'hevc', 'av1', 'vp9']

export type Acceleration = 'prefer-hardware' | 'prefer-software'

export interface EncoderSupport {
  /** The graphics card has an encoder for this codec at this size and frame rate. */
  gpu: boolean
  /** A software encoder (on the processor) is available. */
  cpu: boolean
  /** The graphics card's encoder takes this size only when told this frame rate, lower than the project's. */
  gpuRate?: number
}

/** The frame rate a graphics card's encoder is told when it refuses the project's own. */
export const TOLD_RATE = 30

/** What can encode a codec at frame rate `rate`; `canEncode` asks the system about one setup. */
export async function codecSupport(rate: number, canEncode: (acceleration: Acceleration, frameRate: number) => Promise<boolean>): Promise<EncoderSupport> {
  const [gpu, cpu] = await Promise.all([canEncode('prefer-hardware', rate), canEncode('prefer-software', rate)])
  if (gpu || rate <= TOLD_RATE) return { gpu, cpu }
  return (await canEncode('prefer-hardware', TOLD_RATE)) ? { gpu: true, cpu, gpuRate: TOLD_RATE } : { gpu, cpu }
}

/** The frame rate to tell the encoder instead of the project's, or undefined for the project's own. */
export const toldRate = (support: EncoderSupport, encoder: ExportEncoder): number | undefined =>
  encoder !== 'cpu' && support.gpu ? support.gpuRate : undefined

/**
 * Tells an encoder config `told` fps instead of `rate`. Bitrate rate control
 * gives each frame its share of the bitrate at the told rate, so the bitrate
 * goes down by as much to come out as asked; constant quality is unchanged.
 */
export function tellRate(config: { framerate?: number; bitrate?: number; bitrateMode?: string }, rate: number, told: number): void {
  config.framerate = told
  if (config.bitrate !== undefined && config.bitrateMode !== 'quantizer') config.bitrate = Math.max(1, Math.round((config.bitrate * told) / rate))
}

/** For the problem log: "graphics card only told 30 fps, processor yes". */
export const describeSupport = (s: EncoderSupport): string =>
  `graphics card ${s.gpu ? (s.gpuRate ? `only told ${s.gpuRate} fps` : 'yes') : 'no'}, processor ${s.cpu ? 'yes' : 'no'}`

/**
 * Why `codec` (`name` for the user) cannot be rendered with `encoder` here,
 * or null when it can. `format` is the size and rate, e.g. "2560x1440, 59.940 fps".
 */
export function encoderProblem(codec: ExportCodec, name: string, encoder: ExportEncoder, support: EncoderSupport, format: string): string | null {
  const other = codec === 'avc' ? 'another format' : 'H.264'
  if (!support.gpu && !support.cpu) {
    return `This system cannot encode ${name} at ${format}: the graphics card's encoder does not take this size and frame rate, and there is no software encoder for it. Render ${other}, or lower the frame rate or size in Project Settings.`
  }
  if (encoder === 'gpu' && !support.gpu) return `The graphics card cannot encode ${name} at ${format} on this system: choose Automatic or Processor as the encoder.`
  if (encoder === 'cpu' && !support.cpu) return `There is no software encoder for ${name} on this system: choose Automatic or Graphics card as the encoder.`
  return null
}

/**
 * The codec and encoder choice to use when the remembered one cannot work
 * here: the first codec that can, and Automatic for an encoder the codec lacks.
 */
export function usableChoice(
  support: Record<ExportCodec, EncoderSupport>,
  codec: ExportCodec,
  encoder: ExportEncoder
): { codec: ExportCodec; encoder: ExportEncoder } | null {
  const ok = (c: ExportCodec): boolean => support[c].gpu || support[c].cpu
  const next = ok(codec) ? codec : VIDEO_CODECS.find(ok)
  if (!next) return null
  const missing = (encoder === 'gpu' && !support[next].gpu) || (encoder === 'cpu' && !support[next].cpu)
  return { codec: next, encoder: missing ? 'auto' : encoder }
}

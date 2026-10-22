import type { ExportSettings } from './export'

// Renders that stop moving. A decoder or encoder of the system can stop
// answering (some graphics card drivers do, with some settings): each render
// step gets a deadline, and a stalled render starts again another way.
// Kept apart from export.ts so tests can load it.

export class ExportCancelled extends Error {
  constructor() {
    super('Export cancelled')
  }
}

export type RenderStage = 'decoder' | 'videoEncoder' | 'audioEncoder'

const STAGE_NAMES: Record<RenderStage, string> = {
  decoder: 'Decoding the media',
  videoEncoder: 'The video encoder',
  audioEncoder: 'The audio encoder'
}

/** A render step that did not finish in time. */
export class RenderStalled extends Error {
  constructor(
    readonly stage: RenderStage,
    readonly frame: number,
    /** The video encoder ran with constant quality (quantizer) rate control. */
    readonly quantizer: boolean,
    /** Frames sent, packets out, the encoder's settings: for the problem log. */
    readonly detail: string
  ) {
    super(`${STAGE_NAMES[stage]} stopped answering at frame ${frame}`)
  }
}

/** Seconds a render step may take before the render counts as stalled. */
export const STALL_SECONDS = { decoder: 30, firstFrame: 45, frame: 20, finalize: 60 }

/** `step`, unless it takes longer than `seconds` (`stalled()` is thrown) or the render is cancelled meanwhile. */
export async function guarded<T>(step: Promise<T>, seconds: number, isCancelled: () => boolean, stalled: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const started = performance.now()
  const watch = new Promise<never>((_, reject) => {
    const check = (): void => {
      if (isCancelled()) reject(new ExportCancelled())
      else if (performance.now() - started > seconds * 1000) reject(stalled())
      else timer = setTimeout(check, 250)
    }
    timer = setTimeout(check, 250)
  })
  try {
    return await Promise.race([step, watch])
  } finally {
    clearTimeout(timer)
  }
}

/** Gives up on a cleanup step that hangs (a stalled decoder or encoder may never answer). */
export const atMost = <T>(step: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([step.catch(() => undefined), new Promise<undefined>((resolve) => setTimeout(resolve, ms))])

export type StallRetry = Pick<ExportSettings, 'preferBitrate' | 'softwareDecode' | 'encoder' | 'audioCodec'>

/**
 * The next way to render after `stall`, and what the user is told, or null
 * when there is none left. Video encoder: bitrate rate control first (the
 * constant quality mode is the one some hardware encoders choke on), then the
 * processor's encoder. `canEncode` says whether this system has a hardware or
 * software encoder for the codec.
 */
export async function stallFallback(
  stall: RenderStalled,
  settings: ExportSettings,
  canEncode: (hardwareAcceleration: 'prefer-hardware' | 'prefer-software') => Promise<boolean>
): Promise<{ retry: StallRetry; note: string } | null> {
  switch (stall.stage) {
    case 'decoder':
      return settings.softwareDecode ? null : { retry: { softwareDecode: true }, note: 'Decoding the media stopped answering, so this render decodes it with the processor.' }
    case 'audioEncoder':
      return settings.audioCodec === 'opus' ? null : { retry: { audioCodec: 'opus' }, note: 'The AAC sound encoder stopped answering, so this render uses Opus sound.' }
    case 'videoEncoder':
      if (stall.quantizer && !settings.preferBitrate) {
        return { retry: { preferBitrate: true }, note: 'The video encoder stopped answering, so this render uses bitrate rate control instead of constant quality.' }
      }
      if (settings.encoder === 'cpu') return null
      // Automatic without a graphics card encoder was the processor's already.
      if (settings.encoder !== 'gpu' && !(await canEncode('prefer-hardware'))) return null
      if (!(await canEncode('prefer-software'))) return null
      return { retry: { encoder: 'cpu', preferBitrate: false }, note: "The graphics card's video encoder stopped answering, so this render uses the processor (slower)." }
  }
}

import type { EditorOptions } from '../core/store'
import { type Flicks, flicksToSeconds, fps, rateLabel } from '../core/time'
import type { Project } from '../core/types'
import { CODEC_LABELS, type ExportProgress, type ExportQuality, type ExportSettings, exportProject, videoEncoderSupport } from './export'
import { describeSupport, encoderProblem, toldRate } from './encoders'
import { ExportCancelled, RenderStalled, type StallRetry, stallFallback } from './stall'
import { exportGif } from './exportGif'
import { SOUND_FORMAT_INFO, type SoundFormat, exportSound } from './exportSound'
import type { LoudnessResult } from './loudness'
import { type ExportDestination, type FileType, MP4_FILE } from './targets'
import { describeError, logLine } from '../log'

// One render of Render As (or the MCP render tool): a video, an animated GIF
// or sound only, with the choices remembered in the editor options. When a
// decoder or encoder of the system stops answering (some graphics card
// drivers do), the render starts again another way instead of hanging.

export type RenderKind = EditorOptions['renderKind']

export const GIF_FILE: FileType = { description: 'Animated GIF', mimeType: 'image/gif', extension: 'gif' }

export const soundFile = (format: SoundFormat): FileType => ({
  description: `${format.toUpperCase()} audio`,
  mimeType: SOUND_FORMAT_INFO[format].mimeType,
  extension: SOUND_FORMAT_INFO[format].extension
})

/** The file a render makes with these options. */
export const renderFileType = (options: Pick<EditorOptions, 'renderKind' | 'renderSound'>): FileType =>
  options.renderKind === 'gif' ? GIF_FILE : options.renderKind === 'sound' ? soundFile(options.renderSound) : MP4_FILE

export interface RenderJob {
  quality: ExportQuality
  range: { start: Flicks; end: Flicks }
  /** Sound only: the audio tracks to render (default: every track that is heard). */
  tracks?: string[]
  /** GIF: play once instead of forever. */
  once?: boolean
}

export interface RenderResult {
  loudness: LoudnessResult | null
  /** What was changed to get past a stall (this render, or an earlier one this session), for the user. */
  note: string | null
  /** The video ended up encoded by the processor after the graphics card's encoder stalled. */
  movedToProcessor: boolean
}

/** Changes that got renders past a stall this session, by codec and encoder choice: later renders start with them. */
const known = new Map<string, { retry: StallRetry; note: string }>()

async function renderVideo(
  project: Project,
  destination: ExportDestination,
  base: ExportSettings,
  job: RenderJob,
  onProgress: (p: ExportProgress) => void,
  isCancelled: () => boolean
): Promise<RenderResult> {
  const { width, height, frameRate } = project.settings
  const support = await videoEncoderSupport(base.codec, width, height, fps(frameRate))
  logLine('info', `Video encoders for ${base.codec} here: ${describeSupport(support)}`)
  const format = `${width}x${height}, ${rateLabel(frameRate)} fps`
  const problem = encoderProblem(base.codec, CODEC_LABELS[base.codec].replace(/ \(.*\)$/, ''), base.encoder ?? 'auto', support, format)
  if (problem) throw new Error(problem)
  const key = `${base.codec}/${base.encoder ?? 'auto'}`
  const earlier = known.get(key)
  let settings: ExportSettings = { ...base, ...earlier?.retry }
  let note = earlier?.note ?? null
  if (earlier) logLine('info', `Using what worked after an earlier stall: ${JSON.stringify(earlier.retry)}`)
  for (;;) {
    settings.encoderRate = toldRate(support, settings.encoder ?? 'auto')
    if (settings.encoderRate) logLine('info', `The graphics card's encoder takes ${format} only told ${settings.encoderRate} fps: every frame is encoded all the same`)
    try {
      const result = await exportProject(project, destination.target, settings, (p) => onProgress(note ? { ...p, note } : p), isCancelled, job.range)
      return { loudness: result.loudness, note, movedToProcessor: settings.encoder === 'cpu' && base.encoder !== 'cpu' }
    } catch (err) {
      if (!(err instanceof RenderStalled)) throw err
      logLine('warn', `${err.message} (${err.detail})`)
      const next = await stallFallback(err, settings, async (hardwareAcceleration) => (hardwareAcceleration === 'prefer-hardware' ? support.gpu : support.cpu))
      if (!next) throw err
      logLine('info', `Rendering again: ${JSON.stringify(next.retry)}`)
      settings = { ...settings, ...next.retry }
      note = next.note
      known.set(key, { retry: { ...known.get(key)?.retry, ...next.retry }, note })
      onProgress({ phase: 'video', progress: 0, note })
      await destination.restart()
    }
  }
}

/** Renders into `destination` (already chosen by the user) as the options say. */
export async function renderProject(
  project: Project,
  destination: ExportDestination,
  options: EditorOptions,
  job: RenderJob,
  onProgress: (p: ExportProgress) => void,
  isCancelled: () => boolean
): Promise<RenderResult> {
  const mix = { masterDb: options.masterDb, autoCrossfade: options.autoCrossfade }
  const { width, height, frameRate } = project.settings
  const seconds = flicksToSeconds(job.range.end - job.range.start).toFixed(1)
  const started = performance.now()
  try {
    let result: RenderResult
    switch (options.renderKind) {
      case 'gif': {
        logLine('info', `Render GIF: ${options.gifWidth} px at ${options.gifFps} fps, ${seconds} s, quality ${job.quality}`)
        const settings = { width: options.gifWidth, fps: options.gifFps, quality: job.quality, autoCrossfade: options.autoCrossfade, once: job.once }
        let gif: Uint8Array<ArrayBuffer>
        try {
          gif = await exportGif(project, settings, onProgress, isCancelled, job.range)
        } catch (err) {
          if (!(err instanceof RenderStalled)) throw err
          logLine('warn', `${err.message} (${err.detail}): rendering again with the processor decoding`)
          gif = await exportGif(project, { ...settings, softwareDecode: true }, onProgress, isCancelled, job.range)
        }
        await destination.writeAll(gif)
        result = { loudness: null, note: null, movedToProcessor: false }
        break
      }
      case 'sound': {
        logLine('info', `Render sound: ${options.renderSound}, ${seconds} s, quality ${job.quality}`)
        const settings = { ...mix, format: options.renderSound, quality: job.quality, loudness: options.renderLoudness, tracks: job.tracks }
        const sound = await exportSound(project, destination.target, settings, onProgress, isCancelled, job.range)
        result = { loudness: sound.loudness, note: null, movedToProcessor: false }
        break
      }
      case 'video': {
        const settings: ExportSettings = {
          ...mix,
          codec: options.renderCodec,
          quality: job.quality,
          encoder: options.renderEncoder,
          includeAudio: options.renderAudio !== 'none',
          audioCodec: options.renderAudio === 'opus' ? 'opus' : 'aac',
          loudness: options.renderLoudness
        }
        const rate = frameRate.num / frameRate.den
        logLine(
          'info',
          `Render video: ${settings.codec}, encoder ${settings.encoder}, quality ${job.quality}, ${width}x${height} at ${rate.toFixed(3)} fps, ${seconds} s, sound ${settings.includeAudio ? settings.audioCodec : 'none'}`
        )
        result = await renderVideo(project, destination, settings, job, onProgress, isCancelled)
        break
      }
    }
    logLine('info', `Render finished in ${((performance.now() - started) / 1000).toFixed(1)} s`)
    return result
  } catch (err) {
    if (err instanceof ExportCancelled) logLine('info', 'Render cancelled')
    else logLine('error', `Render failed: ${describeError(err)}${err instanceof RenderStalled ? ` (${err.detail})` : ''}`)
    throw err
  }
}

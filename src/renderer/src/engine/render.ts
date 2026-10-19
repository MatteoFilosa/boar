import type { EditorOptions } from '../core/store'
import type { Flicks } from '../core/time'
import type { Project } from '../core/types'
import { type ExportProgress, type ExportQuality, exportProject } from './export'
import { exportGif } from './exportGif'
import { SOUND_FORMAT_INFO, type SoundFormat, exportSound } from './exportSound'
import type { LoudnessResult } from './loudness'
import { type ExportDestination, type FileType, MP4_FILE } from './targets'

// One render of Render As (or the MCP render tool): a video, an animated GIF
// or sound only, with the choices remembered in the editor options.

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

/** Renders into `destination` (already chosen by the user) as the options say. */
export async function renderProject(
  project: Project,
  destination: ExportDestination,
  options: EditorOptions,
  job: RenderJob,
  onProgress: (p: ExportProgress) => void,
  isCancelled: () => boolean
): Promise<{ loudness: LoudnessResult | null }> {
  const mix = { masterDb: options.masterDb, autoCrossfade: options.autoCrossfade }
  switch (options.renderKind) {
    case 'gif': {
      const settings = { width: options.gifWidth, fps: options.gifFps, quality: job.quality, autoCrossfade: options.autoCrossfade, once: job.once }
      await destination.writeAll(await exportGif(project, settings, onProgress, isCancelled, job.range))
      return { loudness: null }
    }
    case 'sound': {
      const settings = { ...mix, format: options.renderSound, quality: job.quality, loudness: options.renderLoudness, tracks: job.tracks }
      return exportSound(project, destination.target, settings, onProgress, isCancelled, job.range)
    }
    case 'video': {
      const settings = {
        ...mix,
        codec: options.renderCodec,
        quality: job.quality,
        encoder: options.renderEncoder,
        includeAudio: options.renderAudio !== 'none',
        audioCodec: options.renderAudio === 'opus' ? ('opus' as const) : ('aac' as const),
        loudness: options.renderLoudness
      }
      return exportProject(project, destination.target, settings, onProgress, isCancelled, job.range)
    }
  }
}

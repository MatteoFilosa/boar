import { loadFonts } from '../core/fonts'
import { type Flicks, secondsToFlicks } from '../core/time'
import { projectEnd } from '../core/timeline'
import type { Project } from '../core/types'
import { composeFrame } from './compose'
import { ExportCancelled, type ExportProgress, FrameDecoder } from './export'
import { GIF_QUALITIES, type GifSettings, GifWriter, gifDelays, gifFormat } from './gif'
import { prepareSegmenter } from './vision'

// Animated GIF renders: the same compositor as video renders, scaled down,
// at a lower frame rate, without sound.

/** Renders the project (or `range` of it) as an animated GIF; returns the file. */
export async function exportGif(
  project: Project,
  settings: GifSettings,
  onProgress: (p: ExportProgress) => void,
  isCancelled: () => boolean,
  range?: { start: Flicks; end: Flicks }
): Promise<Uint8Array<ArrayBuffer>> {
  const span = range ?? { start: 0, end: projectEnd(project) }
  if (span.end - span.start <= 0) throw new Error('Nothing to render: the timeline or the selection is empty')
  const { width, height, fps: rate } = gifFormat(project, settings)
  const frames = Math.max(1, Math.ceil(((span.end - span.start) * rate) / secondsToFlicks(1)))
  const delays = gifDelays(frames, rate)
  const quality = GIF_QUALITIES[settings.quality]

  await loadFonts(project.events.flatMap((e) => (e.text ? [e.text.font] : [])))
  if (project.events.some((e) => e.fx.some((f) => f.enabled && f.type === 'removeBg'))) await prepareSegmenter()

  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true }) as OffscreenCanvasRenderingContext2D
  const layer = new OffscreenCanvas(width, height)
  const layerCtx = layer.getContext('2d') as OffscreenCanvasRenderingContext2D
  ctx.imageSmoothingQuality = 'high'
  const writer = new GifWriter(width, height, { colors: quality.colors, dither: quality.dither, loop: !settings.once })
  const decoder = new FrameDecoder()
  try {
    for (let i = 0; i < frames; i++) {
      if (isCancelled()) throw new ExportCancelled()
      const t = span.start + Math.round((i * secondsToFlicks(1)) / rate)
      await decoder.prepare(project, t)
      composeFrame(ctx, layerCtx, project, settings.autoCrossfade, t, width, height, decoder.frameFor)
      writer.add(ctx.getImageData(0, 0, width, height).data, delays[i])
      if (i % 3 === 0) onProgress({ phase: 'video', progress: i / frames, frame: i, frames })
    }
  } finally {
    await decoder.dispose()
  }
  onProgress({ phase: 'finalizing', progress: 1, frame: frames, frames })
  return writer.finish()
}

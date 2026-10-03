// Development helpers, loaded only by the dev server (see main.tsx).
// Used by automated UI checks: window.__boarDev.renderToBuffer()
import { ALL_FORMATS, AudioBufferSink, BufferSource, BufferTarget, CanvasSink, Input } from 'mediabunny'
import * as actions from './core/actions'
import { type TimeRange, useEditor } from './core/store'
import { type ExportCodec, type ExportProgress, exportProject } from './engine/export'

/** Renders the project (or `range`, in flicks, like Render loop region only) into memory. */
async function renderToBuffer(codec: ExportCodec = 'avc', range?: TimeRange): Promise<unknown> {
  const s = useEditor.getState()
  const target = new BufferTarget()
  const started = performance.now()
  const result = await exportProject(
    s.project,
    target,
    {
      codec,
      quality: 'medium',
      includeAudio: true,
      masterDb: s.options.masterDb,
      autoCrossfade: s.options.autoCrossfade,
      loudness: s.options.renderLoudness
    },
    (p) => (lastProgress = p),
    () => false,
    range
  )
  const buffer = target.buffer
  if (!buffer) throw new Error('No output')
  lastRender = buffer
  const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(buffer) })
  const video = await input.getPrimaryVideoTrack()
  const audio = await input.getPrimaryAudioTrack()
  return {
    ms: Math.round(performance.now() - started),
    bytes: buffer.byteLength,
    duration: await input.computeDuration(),
    loudness: result.loudness,
    video: video && { codec: video.codec, width: video.displayWidth, height: video.displayHeight },
    audio: audio && { codec: audio.codec, sampleRate: audio.sampleRate, channels: audio.numberOfChannels }
  }
}

let lastRender: ArrayBuffer | null = null
/** Progress of the running (or last) render, for checks that cannot await it. */
let lastProgress: ExportProgress | null = null

/** Overlays a frame of the last render on the page (null to remove it). */
async function showRenderedFrame(seconds: number | null): Promise<string> {
  document.getElementById('boar-render-check')?.remove()
  if (seconds === null || !lastRender) return 'removed'
  const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(lastRender) })
  const track = await input.getPrimaryVideoTrack()
  if (!track) return 'no video'
  const height = 420
  const width = Math.round((height * track.displayWidth) / track.displayHeight)
  const frame = await new CanvasSink(track, { width, height, fit: 'fill' }).getCanvas(seconds)
  if (!frame) return 'no frame'
  const canvas = frame.canvas
  const blob =
    'convertToBlob' in canvas
      ? await canvas.convertToBlob({ type: 'image/png' })
      : await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  const img = document.createElement('img')
  img.id = 'boar-render-check'
  img.src = URL.createObjectURL(blob as Blob)
  img.style.cssText = 'position:fixed;left:8px;top:8px;z-index:9999;border:3px solid #4f9cff'
  document.body.appendChild(img)
  return `frame at ${frame.timestamp.toFixed(3)} s`
}

/**
 * RGB of points of a frame of the last render (fractions of width/height).
 * Reads the decoded frame directly: works while the page is hidden.
 */
async function sampleRenderedFrame(seconds: number, points: [number, number][]): Promise<number[][]> {
  if (!lastRender) return []
  const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(lastRender) })
  const track = await input.getPrimaryVideoTrack()
  if (!track) return []
  const frame = await new CanvasSink(track).getCanvas(seconds)
  if (!frame) return []
  const canvas = frame.canvas
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
  if (!ctx) return []
  return points.map(([fx, fy]) =>
    Array.from(ctx.getImageData(Math.round((canvas.width - 1) * fx), Math.round((canvas.height - 1) * fy), 1, 1).data.slice(0, 3))
  )
}

/** RMS level (dBFS) of the last render's audio per half second: checks Audio FX and unwanted silence. */
async function renderedAudioLevels(): Promise<number[]> {
  if (!lastRender) return []
  const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(lastRender) })
  const track = await input.getPrimaryAudioTrack()
  if (!track) return []
  const sums: number[] = []
  const counts: number[] = []
  for await (const { buffer, timestamp } of new AudioBufferSink(track).buffers()) {
    const data = buffer.getChannelData(0)
    for (let i = 0; i < data.length; i++) {
      const bucket = Math.floor((timestamp + i / buffer.sampleRate) * 2)
      sums[bucket] = (sums[bucket] ?? 0) + data[i] * data[i]
      counts[bucket] = (counts[bucket] ?? 0) + 1
    }
  }
  return sums.map((sum, i) => Math.round(10 * Math.log10(sum / Math.max(1, counts[i]) + 1e-12)))
}

;(window as unknown as { __boarDev: unknown }).__boarDev = {
  store: useEditor,
  actions,
  renderToBuffer,
  renderProgress: (): ExportProgress | null => lastProgress,
  sampleRenderedFrame,
  showRenderedFrame,
  renderedAudioLevels
}

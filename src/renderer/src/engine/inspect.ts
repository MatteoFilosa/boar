import { ALL_FORMATS, CanvasSink, Input, type Source } from 'mediabunny'

// Looking into media files without putting them on the timeline (MCP tools
// look_at_media, media_info, freeze_frame): an agent can skim hours of
// recordings, see how long they are and take stills from them.

export interface MediaFacts {
  /** Seconds. */
  duration: number
  width: number
  height: number
  fps: number
  videoCodec: string
  audioTracks: number
}

async function openInput<T>(source: Source, use: (input: Input, first: number) => Promise<T>): Promise<T> {
  const input = new Input({ formats: ALL_FORMATS, source })
  try {
    if (!(await input.canRead())) throw new Error('container format not supported')
    return await use(input, Math.max(0, await input.getFirstTimestamp()))
  } finally {
    input.dispose()
  }
}

export function probeMedia(source: Source): Promise<MediaFacts> {
  return openInput(source, async (input, first) => {
    const [video, audio] = await Promise.all([input.getPrimaryVideoTrack(), input.getAudioTracks()])
    const duration = Math.max(0, (await input.computeDuration()) - first)
    if (!video) return { duration, width: 0, height: 0, fps: 0, videoCodec: '', audioTracks: audio.length }
    const stats = await video.computePacketStats(90)
    return {
      duration,
      width: await video.getDisplayWidth(),
      height: await video.getDisplayHeight(),
      fps: Math.round(stats.averagePacketRate * 100) / 100,
      videoCodec: (await video.getCodec()) ?? '',
      audioTracks: audio.length
    }
  })
}

/** "1:02:03" or "2:03.5": times printed on contact sheets. */
export function clock(seconds: number, tenths = false): string {
  const s = Math.max(0, seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const rest = s % 60
  const sec = tenths ? rest.toFixed(1).padStart(4, '0') : String(Math.floor(rest)).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/**
 * Frames spread over [from, to) (source seconds) in one picture, each with its
 * time, `columns` across, `cellWidth` pixels wide.
 */
export function contactSheet(
  source: Source,
  o: { from?: number; to?: number; count: number; cellWidth: number; columns: number }
): Promise<{ blob: Blob; times: number[]; duration: number }> {
  return openInput(source, async (input, first) => {
    const video = await input.getPrimaryVideoTrack()
    if (!video || !(await video.canDecode())) throw new Error('this file has no picture that can be decoded here')
    const duration = Math.max(0, (await input.computeDuration()) - first)
    const from = Math.min(Math.max(0, o.from ?? 0), duration)
    const to = Math.min(duration, Math.max(from, o.to ?? duration))
    if (to - from <= 0) throw new Error(`the range is outside the file (${clock(duration)} long)`)
    const times = Array.from({ length: o.count }, (_, i) => from + ((i + 0.5) * (to - from)) / o.count)
    const aspect = (await video.getDisplayWidth()) / Math.max(1, await video.getDisplayHeight()) || 16 / 9
    const cellW = Math.round(o.cellWidth)
    const cellH = Math.round(cellW / aspect)
    const columns = Math.min(o.columns, o.count)
    const rows = Math.ceil(o.count / columns)
    const gap = 4
    const sheet = new OffscreenCanvas(columns * cellW + (columns - 1) * gap, rows * cellH + (rows - 1) * gap)
    const ctx = sheet.getContext('2d') as OffscreenCanvasRenderingContext2D
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, sheet.width, sheet.height)
    ctx.font = `600 ${Math.max(11, Math.round(cellW / 18))}px sans-serif`
    ctx.textBaseline = 'bottom'
    const sink = new CanvasSink(video, { width: cellW, height: cellH, fit: 'contain' })
    let i = 0
    for await (const frame of sink.canvasesAtTimestamps(times.map((t) => first + t))) {
      const x = (i % columns) * (cellW + gap)
      const y = Math.floor(i / columns) * (cellH + gap)
      if (frame) ctx.drawImage(frame.canvas, x, y, cellW, cellH)
      const label = clock(times[i], to - from < o.count * 2)
      const w = ctx.measureText(label).width + 10
      const h = Math.round(cellW / 18) + 8
      ctx.fillStyle = 'rgba(0, 0, 0, 0.7)'
      ctx.fillRect(x, y + cellH - h, w, h)
      ctx.fillStyle = '#fff'
      ctx.fillText(label, x + 5, y + cellH - 4)
      i++
    }
    return { blob: await sheet.convertToBlob({ type: 'image/jpeg', quality: 0.8 }), times, duration }
  })
}

/** The frame shown at a source time, full size, as a PNG. */
export function frameImage(source: Source, seconds: number): Promise<{ blob: Blob; width: number; height: number }> {
  return openInput(source, async (input, first) => {
    const video = await input.getPrimaryVideoTrack()
    if (!video || !(await video.canDecode())) throw new Error('this file has no picture that can be decoded here')
    const frame = await new CanvasSink(video).getCanvas(first + Math.max(0, seconds))
    if (!frame) throw new Error('no frame at that time')
    const { width, height } = frame.canvas
    const canvas = frame.canvas instanceof OffscreenCanvas ? frame.canvas : null
    const blob = canvas
      ? await canvas.convertToBlob({ type: 'image/png' })
      : await new Promise<Blob>((resolve, reject) =>
          (frame.canvas as HTMLCanvasElement).toBlob((b) => (b ? resolve(b) : reject(new Error('cannot encode the frame'))), 'image/png')
        )
    return { blob, width, height }
  })
}

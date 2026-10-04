import {
  ALL_FORMATS,
  AudioBufferSink,
  AudioBufferSource,
  CanvasSink,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  QUALITY_MEDIUM,
  QUALITY_VERY_HIGH,
  type Target,
  type WrappedCanvas,
  canEncodeAudio,
  canEncodeVideo
} from 'mediabunny'
import { mediaById } from '../core/store'
import { type Flicks, flicksToSeconds, fps, frameFlicks } from '../core/time'
import { audioGain, eventsByTrack, projectEnd, sourceTime } from '../core/timeline'
import type { MediaItem, Project, TimelineEvent } from '../core/types'
import { composeFrame } from './compose'
import { inputSource } from '../media/source'
import { type AudioFxChain, buildAudioFxChain, prepareAudioFx } from './audioFx'
import { activeFx } from '../core/fx'
import { loadFonts } from '../core/fonts'
import { prepareSegmenter } from './vision'
import { timeStretch } from './stretch'
import { type LoudnessResult, normalizeLoudness } from './loudness'

export type ExportCodec = 'avc' | 'hevc' | 'av1' | 'vp9'
export type ExportQuality = 'medium' | 'high' | 'veryHigh'
/** Who encodes the video: the graphics card's encoder, the software one on the processor, or the best available. */
export type ExportEncoder = 'auto' | 'gpu' | 'cpu'
export type ExportAudioCodec = 'aac' | 'opus'

export interface ExportSettings {
  codec: ExportCodec
  quality: ExportQuality
  /** Default 'auto'. */
  encoder?: ExportEncoder
  includeAudio: boolean
  /** Default 'aac' (Opus when this system has no AAC encoder). */
  audioCodec?: ExportAudioCodec
  masterDb: number
  autoCrossfade: boolean
  /** Integrated loudness target in LUFS for the audio (null or absent = leave the mix as is). */
  loudness?: number | null
}

export interface ExportResult {
  /** Set when the audio was normalized. */
  loudness: LoudnessResult | null
}

export interface ExportProgress {
  phase: 'audio' | 'video' | 'finalizing'
  /** 0..1 */
  progress: number
  frame?: number
  frames?: number
}

export const CODEC_LABELS: Record<ExportCodec, string> = {
  avc: 'H.264 / AVC (most compatible)',
  hevc: 'H.265 / HEVC (smaller files)',
  av1: 'AV1 (smallest files)',
  vp9: 'VP9 (open format)'
}

export interface EncoderSupport {
  /** The graphics card has an encoder for this codec at this size. */
  gpu: boolean
  /** A software encoder (on the processor) is available. */
  cpu: boolean
}

/** For each codec, whether the graphics card and the processor can encode it at the project size. */
export async function encoderSupport(width: number, height: number): Promise<Record<ExportCodec, EncoderSupport>> {
  const check = (codec: ExportCodec, hardwareAcceleration: 'prefer-hardware' | 'prefer-software'): Promise<boolean> =>
    canEncodeVideo(codec, { width, height, hardwareAcceleration }).catch(() => false)
  const entries = await Promise.all(
    (['avc', 'hevc', 'av1', 'vp9'] as const).map(async (codec) => {
      const [gpu, cpu] = await Promise.all([check(codec, 'prefer-hardware'), check(codec, 'prefer-software')])
      return [codec, { gpu, cpu }] as const
    })
  )
  return Object.fromEntries(entries) as Record<ExportCodec, EncoderSupport>
}

/** Audio codecs this system can encode for the render. */
export async function audioSupport(): Promise<Record<ExportAudioCodec, boolean>> {
  const check = (codec: ExportAudioCodec): Promise<boolean> =>
    canEncodeAudio(codec, { numberOfChannels: 2, sampleRate: 48000 }).catch(() => false)
  const [aac, opus] = await Promise.all([check('aac'), check('opus')])
  return { aac, opus }
}

const ACCELERATION = { auto: 'no-preference', gpu: 'prefer-hardware', cpu: 'prefer-software' } as const

const QUALITIES = { medium: QUALITY_MEDIUM, high: QUALITY_HIGH, veryHigh: QUALITY_VERY_HIGH }

/** Codecs this machine can encode at the project size. */
export async function supportedCodecs(width: number, height: number): Promise<ExportCodec[]> {
  const out: ExportCodec[] = []
  for (const codec of ['avc', 'hevc', 'av1', 'vp9'] as const) {
    try {
      if (await canEncodeVideo(codec, { width, height })) out.push(codec)
    } catch {
      // Not supported here.
    }
  }
  return out
}

export class ExportCancelled extends Error {
  constructor() {
    super('Export cancelled')
  }
}

const dbToGain = (db: number): number => (db <= -60 ? 0 : Math.pow(10, db / 20))

interface OpenMedia {
  input: Input
  first: number
}

/** Opens each media file once and decodes frames sequentially for every event. */
class FrameDecoder {
  private readonly media = new Map<string, Promise<OpenMedia>>()
  private readonly streams = new Map<
    string,
    { iterator: AsyncGenerator<WrappedCanvas, void, unknown>; current: WrappedCanvas | null; next: WrappedCanvas | null }
  >()

  private open(m: MediaItem): Promise<OpenMedia> {
    let pending = this.media.get(m.id)
    if (!pending) {
      pending = (async () => {
        const input = new Input({ formats: ALL_FORMATS, source: inputSource(m) })
        return { input, first: Math.max(0, await input.getFirstTimestamp()) }
      })()
      this.media.set(m.id, pending)
    }
    return pending
  }

  /** Advances every active event's decoder to the frame shown at time t. */
  async prepare(project: Project, t: Flicks): Promise<void> {
    for (const ev of project.events) {
      const end = ev.start + ev.length
      const stream = this.streams.get(ev.id)
      if (t >= end || t < ev.start) {
        if (stream && t >= end) {
          await stream.iterator.return(undefined)
          this.streams.delete(ev.id)
        }
        continue
      }
      if (ev.kind !== 'video' || ev.text) continue
      const media = mediaById(ev.mediaId)
      if (!media || media.kind !== 'video' || media.status !== 'ready') continue
      const { input, first } = await this.open(media)
      const src = first + flicksToSeconds(sourceTime(ev, t))
      let s = stream
      if (!s) {
        const track = await input.getPrimaryVideoTrack()
        if (!track) continue
        const sink = new CanvasSink(track)
        const iterator = sink.canvases(src)
        const firstFrame = await iterator.next()
        s = { iterator, current: null, next: firstFrame.done ? null : firstFrame.value }
        this.streams.set(ev.id, s)
      }
      while (s.next && s.next.timestamp <= src + 1e-6) {
        s.current = s.next
        const result = await s.iterator.next()
        s.next = result.done ? null : result.value
      }
      if (!s.current && s.next) s.current = s.next
    }
  }

  frameFor = (ev: TimelineEvent): { source: CanvasImageSource; width: number; height: number } | null => {
    const current = this.streams.get(ev.id)?.current
    if (!current) return null
    return { source: current.canvas, width: current.canvas.width, height: current.canvas.height }
  }

  async dispose(): Promise<void> {
    for (const stream of this.streams.values()) await stream.iterator.return(undefined).catch(() => undefined)
    this.streams.clear()
    for (const pending of this.media.values()) (await pending.catch(() => null))?.input.dispose()
    this.media.clear()
  }
}

/**
 * The sound of an event between timeline times `from` and `to`, at the event's
 * playback rate (time-stretched, same pitch).
 */
async function decodeEventAudio(media: MediaItem, ev: TimelineEvent, from: Flicks, to: Flicks): Promise<AudioBuffer | null> {
  const seconds = flicksToSeconds(to - from)
  const buffer = await decodeAudio(media, flicksToSeconds(sourceTime(ev, from)), seconds * ev.rate)
  if (!buffer || Math.abs(ev.rate - 1) < 1e-4) return buffer
  return timeStretch(buffer, ev.rate, Math.max(1, Math.ceil(seconds * buffer.sampleRate)))
}

/** Decodes [offset, offset + length) of a media file's audio into one AudioBuffer. */
async function decodeAudio(media: MediaItem, offset: number, length: number): Promise<AudioBuffer | null> {
  const input = new Input({ formats: ALL_FORMATS, source: inputSource(media) })
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track) return null
    const first = Math.max(0, await input.getFirstTimestamp())
    const start = first + offset
    const sink = new AudioBufferSink(track)
    const rate = track.sampleRate
    const channels = Math.min(2, Math.max(1, track.numberOfChannels))
    const total = Math.max(1, Math.ceil(length * rate))
    const out = new AudioBuffer({ length: total, numberOfChannels: channels, sampleRate: rate })
    for await (const { buffer, timestamp } of sink.buffers(start, start + length)) {
      const at = Math.round((timestamp - start) * rate)
      for (let c = 0; c < channels; c++) {
        const src = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1))
        const from = Math.max(0, -at)
        const to = Math.min(src.length, total - at)
        if (to > from) out.getChannelData(c).set(src.subarray(from, to), at + from)
      }
    }
    return out
  } finally {
    input.dispose()
  }
}

/** Mixes every audible audio event in [range.start, range.end) offline, with the same gains as the preview. */
async function mixAudio(
  project: Project,
  settings: ExportSettings,
  range: { start: Flicks; end: Flicks },
  onProgress: (fraction: number) => void,
  isCancelled: () => boolean
): Promise<AudioBuffer> {
  const rate = project.settings.sampleRate
  const seconds = flicksToSeconds(range.end - range.start)
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.max(1, Math.ceil(seconds * rate)), sampleRate: rate })
  const master = ctx.createGain()
  master.gain.value = dbToGain(settings.masterDb)
  master.connect(ctx.destination)
  const audioTracks = project.tracks.filter((t) => t.kind === 'audio')
  const anySolo = audioTracks.some((t) => t.solo)
  const byTrack = eventsByTrack(project)
  const events = project.events.filter((e) => e.kind === 'audio')
  if (events.some((e) => activeFx(e.fx, 'audio').length > 0)) await prepareAudioFx(ctx)
  const chains: AudioFxChain[] = []
  let done = 0
  for (const track of audioTracks) {
    if (track.muted || (anySolo && !track.solo)) continue
    const bus = ctx.createGain()
    bus.gain.value = dbToGain(track.volumeDb)
    const pan = ctx.createStereoPanner()
    pan.pan.value = track.pan
    bus.connect(pan)
    pan.connect(master)
    const trackEvents = byTrack.get(track.id) ?? []
    for (const ev of trackEvents) {
      if (isCancelled()) throw new ExportCancelled()
      done++
      onProgress(done / Math.max(1, events.length))
      // Only the part of the event inside the rendered range.
      const from = Math.max(ev.start, range.start)
      const to = Math.min(ev.start + ev.length, range.end)
      if (to <= from) continue
      const media = mediaById(ev.mediaId)
      if (!media || !media.hasAudio) continue
      const buffer = await decodeEventAudio(media, ev, from, to)
      if (!buffer) continue
      const source = ctx.createBufferSource()
      source.buffer = buffer
      const gain = ctx.createGain()
      // Envelope (fades, crossfades, event gain) sampled 200 times per second.
      const startSec = flicksToSeconds(from - range.start)
      const durSec = flicksToSeconds(to - from)
      const points = Math.max(2, Math.ceil(durSec * 200))
      const curve = new Float32Array(points)
      for (let i = 0; i < points; i++) {
        const t = from + ((to - from) * i) / (points - 1)
        curve[i] = audioGain(ev, Math.min(t, ev.start + ev.length - 1), trackEvents, settings.autoCrossfade)
      }
      gain.gain.setValueCurveAtTime(curve, startSec, durSec)
      // Event FX sit before the envelope; like in the preview, tails stop at the event end.
      const chain = buildAudioFxChain(ctx, ev.fx)
      if (chain) {
        chains.push(chain)
        source.connect(chain.input)
        chain.output.connect(gain)
        gain.gain.setValueAtTime(0, startSec + durSec)
      } else {
        source.connect(gain)
      }
      gain.connect(bus)
      source.start(startSec, 0, durSec)
    }
  }
  if (chains.some((c) => c.warmup)) {
    // Noise reduction models start asynchronously inside the audio thread:
    // hold the render at 0 until they are ready, or the first seconds come out silent.
    void ctx.suspend(0).then(() => setTimeout(() => void ctx.resume(), 400))
  }
  return ctx.startRendering()
}

/**
 * One audio event as it sounds in the project (trim, fades, event gain and,
 * optionally, its Audio FX), without track volume/pan. Used by Save as Sound Effect.
 */
export async function renderEventAudio(ev: TimelineEvent, withFx: boolean, sampleRate = 48000): Promise<AudioBuffer | null> {
  const media = mediaById(ev.mediaId)
  if (!media || !media.hasAudio) return null
  const buffer = await decodeEventAudio(media, ev, ev.start, ev.start + ev.length)
  if (!buffer) return null
  const seconds = flicksToSeconds(ev.length)
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.max(1, Math.ceil(seconds * sampleRate)), sampleRate })
  if (withFx && activeFx(ev.fx, 'audio').length > 0) await prepareAudioFx(ctx)
  const source = ctx.createBufferSource()
  source.buffer = buffer
  const gain = ctx.createGain()
  const points = Math.max(2, Math.ceil(seconds * 200))
  const curve = new Float32Array(points)
  for (let i = 0; i < points; i++) {
    const t = ev.start + (ev.length * i) / (points - 1)
    curve[i] = audioGain(ev, Math.min(t, ev.start + ev.length - 1), [ev], false)
  }
  gain.gain.setValueCurveAtTime(curve, 0, seconds)
  const chain = withFx ? buildAudioFxChain(ctx, ev.fx) : null
  if (chain) {
    source.connect(chain.input)
    chain.output.connect(gain)
  } else {
    source.connect(gain)
  }
  gain.connect(ctx.destination)
  source.start(0, 0, seconds)
  if (chain?.warmup) void ctx.suspend(0).then(() => setTimeout(() => void ctx.resume(), 400))
  return ctx.startRendering()
}

/** One frame of the project at time `t`, `width` pixels wide, composed like a render. */
export async function renderStill(project: Project, t: Flicks, width: number, autoCrossfade = true): Promise<Blob> {
  const scale = Math.min(1, width / project.settings.width)
  const w = Math.max(2, Math.round(project.settings.width * scale))
  const h = Math.max(2, Math.round(project.settings.height * scale))
  await loadFonts(project.events.flatMap((e) => (e.text ? [e.text.font] : [])))
  if (project.events.some((e) => e.fx.some((f) => f.enabled && f.type === 'removeBg'))) await prepareSegmenter()
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d', { alpha: false }) as OffscreenCanvasRenderingContext2D
  const layer = new OffscreenCanvas(w, h)
  const layerCtx = layer.getContext('2d') as OffscreenCanvasRenderingContext2D
  ctx.imageSmoothingQuality = 'high'
  const decoder = new FrameDecoder()
  try {
    await decoder.prepare(project, t)
    composeFrame(ctx, layerCtx, project, autoCrossfade, t, w, h, decoder.frameFor)
  } finally {
    await decoder.dispose()
  }
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
}

function sliceAudio(buffer: AudioBuffer, from: number, to: number): AudioBuffer | null {
  const a = Math.max(0, Math.min(buffer.length, from))
  const b = Math.max(a, Math.min(buffer.length, to))
  if (b <= a) return null
  const out = new AudioBuffer({ length: b - a, numberOfChannels: buffer.numberOfChannels, sampleRate: buffer.sampleRate })
  for (let c = 0; c < buffer.numberOfChannels; c++) out.getChannelData(c).set(buffer.getChannelData(c).subarray(a, b))
  return out
}

/**
 * Renders the project (or `range` of it, e.g. the time selection) to MP4 with
 * the preview's compositor and WebCodecs encoders (hardware when available).
 */
export async function exportProject(
  project: Project,
  target: Target,
  settings: ExportSettings,
  onProgress: (p: ExportProgress) => void,
  isCancelled: () => boolean,
  range?: { start: Flicks; end: Flicks }
): Promise<ExportResult> {
  const { width, height, frameRate } = project.settings
  const span = range ?? { start: 0, end: projectEnd(project) }
  if (span.end - span.start <= 0) throw new Error('Nothing to render: the timeline or the selection is empty')
  const frameDuration = frameFlicks(frameRate)
  const frames = Math.ceil((span.end - span.start) / frameDuration)
  const rate = fps(frameRate)

  const hasAudio =
    settings.includeAudio && project.events.some((e) => e.kind === 'audio' && mediaById(e.mediaId)?.hasAudio)
  let mix: AudioBuffer | null = null
  if (hasAudio) {
    onProgress({ phase: 'audio', progress: 0 })
    mix = await mixAudio(project, settings, span, (f) => onProgress({ phase: 'audio', progress: f }), isCancelled)
  }
  const loudness = mix && settings.loudness != null ? normalizeLoudness(mix, settings.loudness) : null

  // Text fonts and the background removal model must be ready before the first frame.
  await loadFonts(project.events.flatMap((e) => (e.text ? [e.text.font] : [])))
  if (project.events.some((e) => e.fx.some((f) => f.enabled && f.type === 'removeBg'))) await prepareSegmenter()

  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { alpha: false }) as OffscreenCanvasRenderingContext2D
  const layer = new OffscreenCanvas(width, height)
  const layerCtx = layer.getContext('2d') as OffscreenCanvasRenderingContext2D
  ctx.imageSmoothingQuality = 'high'

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target })
  const video = new CanvasSource(canvas, {
    codec: settings.codec,
    quality: QUALITIES[settings.quality],
    keyFrameInterval: 2,
    // Automatic: the graphics card's encoder when it has one for this codec, otherwise software.
    hardwareAcceleration: ACCELERATION[settings.encoder ?? 'auto']
  })
  output.addVideoTrack(video, { frameRate: rate })
  let audio: AudioBufferSource | null = null
  if (mix) {
    const codec = settings.audioCodec === 'opus' || !(await canEncodeAudio('aac')) ? 'opus' : 'aac'
    audio = new AudioBufferSource({ codec, quality: QUALITY_HIGH })
    output.addAudioTrack(audio)
  }

  const decoder = new FrameDecoder()
  let finished = false
  try {
    await output.start()
    let audioWritten = 0
    const audioChunk = project.settings.sampleRate // one second per chunk
    for (let i = 0; i < frames; i++) {
      if (isCancelled()) throw new ExportCancelled()
      const t = span.start + i * frameDuration
      await decoder.prepare(project, t)
      composeFrame(ctx, layerCtx, project, settings.autoCrossfade, t, width, height, decoder.frameFor)
      await video.add(i / rate, 1 / rate)
      // Keep audio slightly ahead of video so the muxer can interleave.
      if (audio && mix) {
        const wanted = Math.min(mix.length, Math.ceil(((i + 1) / rate + 1) * mix.sampleRate))
        while (audioWritten < wanted) {
          const piece = sliceAudio(mix, audioWritten, Math.min(wanted, audioWritten + audioChunk))
          if (!piece) break
          await audio.add(piece)
          audioWritten += piece.length
        }
      }
      if (i % 5 === 0) onProgress({ phase: 'video', progress: i / frames, frame: i, frames })
    }
    if (audio && mix && audioWritten < mix.length) {
      const rest = sliceAudio(mix, audioWritten, mix.length)
      if (rest) await audio.add(rest)
    }
    onProgress({ phase: 'finalizing', progress: 1, frame: frames, frames })
    video.close()
    audio?.close()
    await output.finalize()
    finished = true
  } finally {
    await decoder.dispose()
    if (!finished) await output.cancel().catch(() => undefined)
  }
  return { loudness }
}

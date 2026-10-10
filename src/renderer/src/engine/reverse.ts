import {
  ALL_FORMATS,
  AudioBufferSink,
  AudioBufferSource,
  BufferTarget,
  EncodedPacketSink,
  Input,
  type InputAudioTrack,
  type InputVideoTrack,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  QUALITY_VERY_HIGH,
  StreamTarget,
  type StreamTargetChunk,
  type Target,
  VideoSample,
  type VideoSamplePixelFormat,
  VideoSampleSink,
  VideoSampleSource,
  canEncodeAudio,
  canEncodeVideo
} from 'mediabunny'
import * as A from '../core/actions'
import { mediaById, useEditor } from '../core/store'
import { type Flicks, flicksToSeconds, secondsToFlicks } from '../core/time'
import { sourceLength } from '../core/timeline'
import type { MediaItem, ReverseLink, TimelineEvent } from '../core/types'
import { canRead, inputSource } from '../media/source'
import { importFiles, importPaths } from '../media/importer'
import { bridge } from '../platform'

// Reverse: a clip plays backwards from a reversed copy of the part of its media
// file it uses (picture and sound), made here with WebCodecs and kept in the
// app's folder like a proxy. The events move onto the copy, so the preview,
// the render and every tool read it like any other file; reversing again puts
// them back on the original.

/** Decoded frames held at once: a stretch of video is decoded forward, then written backward. */
const MEMORY_BUDGET = 512 * 1024 * 1024
/** Longest stretch decoded at once, in seconds. */
const MAX_STRETCH = 8
/** Files up to this long (seconds) are reversed whole; longer ones around the clips, with room to trim. */
const WHOLE_FILE = 120
const HANDLE = 2
/** Keyframes of the copy, so it seeks as fast as a proxy. */
const KEYFRAME_INTERVAL = 0.5
/** Pixel layouts encoders take as they are; others are copied as 8-bit RGB. */
const KEEP_FORMATS = new Set<VideoSamplePixelFormat>(['I420', 'I420A', 'NV12', 'RGBA', 'RGBX', 'BGRA', 'BGRX'])

export class ReverseCancelled extends Error {
  constructor() {
    super('Reverse cancelled')
  }
}

interface HeldFrame {
  data: Uint8Array
  layout: PlaneLayout[]
  format: VideoSamplePixelFormat
  width: number
  height: number
  timestamp: number
  duration: number
  colorSpace?: VideoColorSpaceInit
}

const copyOptions = (sample: VideoSample): VideoFrameCopyToOptions | undefined =>
  sample.format && KEEP_FORMATS.has(sample.format) ? undefined : { format: 'RGBX' }

/** The frame's pixels in memory: decoder frames must go back to the decoder quickly. */
async function hold(sample: VideoSample): Promise<HeldFrame> {
  const options = copyOptions(sample)
  const data = new Uint8Array(sample.allocationSize(options))
  const layout = await sample.copyTo(data, options)
  return {
    data,
    layout,
    format: options ? 'RGBX' : (sample.format as VideoSamplePixelFormat),
    width: sample.visibleRect.width,
    height: sample.visibleRect.height,
    timestamp: sample.timestamp,
    duration: sample.duration,
    colorSpace: options ? undefined : sample.colorSpace.toJSON()
  }
}

/** The graphics card's encoder first, any encoder otherwise; H.264 when possible (plays everywhere). */
async function pickVideoEncoder(
  width: number,
  height: number
): Promise<{ codec: 'avc' | 'hevc' | 'vp9' | 'av1'; hardwareAcceleration: 'prefer-hardware' | 'no-preference' } | null> {
  const tries = [
    ['avc', 'prefer-hardware'],
    ['hevc', 'prefer-hardware'],
    ['avc', 'no-preference'],
    ['hevc', 'no-preference'],
    ['vp9', 'no-preference'],
    ['av1', 'no-preference']
  ] as const
  for (const [codec, hardwareAcceleration] of tries) {
    if (await canEncodeVideo(codec, { width, height, hardwareAcceleration }).catch(() => false)) return { codec, hardwareAcceleration }
  }
  return null
}

/** Keyframe times from the one at or before `from` up to `to` (file timestamps). */
async function keyTimes(video: InputVideoTrack, from: number, to: number): Promise<number[]> {
  const sink = new EncodedPacketSink(video)
  const out: number[] = []
  let key = await sink.getKeyPacket(from, { metadataOnly: true })
  while (key && key.timestamp < to) {
    out.push(key.timestamp)
    key = await sink.getNextKeyPacket(key, { metadataOnly: true })
  }
  return out
}

/**
 * Stretches covering [from, to), latest first, each at most `longest` seconds.
 * They start on a keyframe when one is close enough, so each frame is decoded once.
 */
function stretches(from: number, to: number, keys: readonly number[], longest: number): [number, number][] {
  const out: [number, number][] = []
  let end = to
  while (end > from + 1e-6) {
    const earliest = end - longest
    const key = keys.find((k) => k >= earliest - 1e-6 && k < end - 1e-6 && k > from + 1e-6)
    const start = key ?? Math.max(from, earliest)
    out.push([start <= from + 1e-6 ? from : start, end])
    end = start
  }
  return out
}

/** A part of a media file opened for reversing, snapped to whole frames (or samples). */
interface Reversal {
  /** File timestamps of the reversed part. */
  from: number
  to: number
  /** The same part in source time (seconds from the file's first timestamp). */
  start: number
  end: number
  write(target: Target, onProgress: (seconds: number) => void, isCancelled: () => boolean): Promise<void>
  dispose(): void
}

async function openReversal(media: MediaItem, start: number, end: number, withVideo: boolean): Promise<Reversal> {
  const input = new Input({ formats: ALL_FORMATS, source: inputSource(media) })
  try {
    const first = Math.max(0, await input.getFirstTimestamp())
    let video: InputVideoTrack | null = withVideo && media.hasVideo ? await input.getPrimaryVideoTrack() : null
    if (video && !(await video.canDecode())) video = null
    let audio: InputAudioTrack | null = media.hasAudio ? await input.getPrimaryAudioTrack() : null
    if (audio && !(await audio.canDecode())) audio = null
    if (!video && !audio) throw new Error('nothing in this file can be decoded here')
    let from = first + start
    let to = first + end
    if (video) {
      // Whole frames: the one shown at the start through the one shown just before the end.
      const packets = new EncodedPacketSink(video)
      const head = (await packets.getPacket(from, { metadataOnly: true })) ?? (await packets.getFirstPacket({ metadataOnly: true }))
      const tail = await packets.getPacket(Math.max(from, to - 1e-6), { metadataOnly: true })
      if (!head || !tail) throw new Error('no video frames in this part of the file')
      const frame = 1 / (media.fps || 30)
      from = head.timestamp
      to = Math.max(tail.timestamp + (tail.duration || frame), head.timestamp + (head.duration || frame))
    } else if (audio) {
      const rate = audio.sampleRate
      from = Math.floor(from * rate) / rate
      to = Math.ceil(to * rate) / rate
    }

    const write = async (target: Target, onProgress: (seconds: number) => void, isCancelled: () => boolean): Promise<void> => {
      const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target })
      let videoSource: VideoSampleSource | null = null
      let longest = MAX_STRETCH
      let keys: number[] = []
      if (video) {
        const probe = await new VideoSampleSink(video).getSample(from)
        if (!probe) throw new Error('no video frames in this part of the file')
        const bytes = probe.allocationSize(copyOptions(probe))
        const { width, height } = probe.visibleRect
        probe.close()
        const encoder = await pickVideoEncoder(width, height)
        if (!encoder) throw new Error(`a ${width}x${height} video cannot be encoded here`)
        videoSource = new VideoSampleSource({ ...encoder, bitrate: QUALITY_VERY_HIGH, keyFrameInterval: KEYFRAME_INTERVAL })
        output.addVideoTrack(videoSource, { rotation: await video.getRotation(), flip: await video.getFlip() })
        const fps = media.fps || 30
        longest = Math.min(MAX_STRETCH, Math.max(1, Math.floor(MEMORY_BUDGET / Math.max(1, bytes))) / fps)
        keys = await keyTimes(video, from, to)
      }
      let audioSource: AudioBufferSource | null = null
      const channels = audio ? Math.min(2, Math.max(1, audio.numberOfChannels)) : 0
      if (audio) {
        const aac = await canEncodeAudio('aac', { numberOfChannels: channels, sampleRate: audio.sampleRate }).catch(() => false)
        // Without an AAC encoder: Opus, which needs 48 kHz.
        audioSource = new AudioBufferSource(
          aac ? { codec: 'aac', bitrate: QUALITY_HIGH } : { codec: 'opus', bitrate: QUALITY_HIGH, transform: { sampleRate: 48000 } }
        )
        output.addAudioTrack(audioSource)
      }

      const frameSink = video ? new VideoSampleSink(video) : null
      const soundSink = audio ? new AudioBufferSink(audio) : null
      const rate = audio?.sampleRate ?? 48000
      const sampleAt = (t: number): number => Math.round(t * rate)
      let finished = false
      try {
        await output.start()
        for (const [a, b] of stretches(from, to, keys, video ? longest : MAX_STRETCH)) {
          if (frameSink && videoSource) {
            const held: HeldFrame[] = []
            try {
              for await (const sample of frameSink.samples(a, b)) {
                try {
                  if (isCancelled()) throw new ReverseCancelled()
                  // Each frame belongs to the stretch it starts in.
                  if (sample.timestamp >= a - 1e-6 && sample.timestamp < b - 1e-6) {
                    held.push(await hold(sample))
                    // Half of the work is decoding a frame, half encoding it.
                    onProgress(sample.duration / 2)
                  }
                } finally {
                  sample.close()
                }
              }
              for (let i = held.length - 1; i >= 0; i--) {
                if (isCancelled()) throw new ReverseCancelled()
                const f = held[i]
                const reversed = new VideoSample(f.data, {
                  format: f.format,
                  codedWidth: f.width,
                  codedHeight: f.height,
                  layout: f.layout,
                  colorSpace: f.colorSpace,
                  timestamp: Math.max(0, to - f.timestamp - f.duration),
                  duration: f.duration
                })
                try {
                  await videoSource.add(reversed)
                } finally {
                  reversed.close()
                }
                onProgress(f.duration / 2)
                held.length = i
              }
            } finally {
              held.length = 0
            }
          }
          if (soundSink && audioSource) {
            const length = sampleAt(b) - sampleAt(a)
            if (length > 0) {
              const out = new AudioBuffer({ length, numberOfChannels: channels, sampleRate: rate })
              const data = Array.from({ length: channels }, (_, c) => out.getChannelData(c))
              for await (const { buffer, timestamp } of soundSink.buffers(a, b)) {
                if (isCancelled()) throw new ReverseCancelled()
                const at = sampleAt(timestamp) - sampleAt(a)
                for (let c = 0; c < channels; c++) {
                  const src = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1))
                  const lo = Math.max(0, -at)
                  const hi = Math.min(src.length, length - at)
                  if (hi > lo) data[c].set(src.subarray(lo, hi), at + lo)
                }
              }
              for (const channel of data) channel.reverse()
              await audioSource.add(out)
            }
            if (!frameSink) onProgress(b - a)
          }
        }
        videoSource?.close()
        audioSource?.close()
        await output.finalize()
        finished = true
      } finally {
        if (!finished) await output.cancel().catch(() => undefined)
      }
    }

    return { from, to, start: from - first, end: to - first, write, dispose: () => input.dispose() }
  } catch (err) {
    input.dispose()
    throw err
  }
}

const stemOf = (name: string): string => name.replace(/\.[^.]*$/, '') || 'Media'

/** Writes the reversed copy and imports it; reuses one made earlier for the same part of the same file. */
async function makeReversedCopy(
  media: MediaItem,
  start: number,
  end: number,
  withVideo: boolean,
  onProgress: (seconds: number) => void,
  isCancelled: () => boolean
): Promise<MediaItem> {
  const reversal = await openReversal(media, start, end, withVideo)
  const name = `${stemOf(media.name)} (reversed).${withVideo && media.hasVideo ? 'mp4' : 'm4a'}`
  const link: ReverseLink = { mediaId: media.id, start: secondsToFlicks(reversal.start), end: secondsToFlicks(reversal.end) }
  const key = `${reversal.from.toFixed(6)}-${reversal.to.toFixed(6)}-${withVideo ? 'av' : 'a'}`
  let imported: MediaItem | null
  try {
    if (bridge && media.path) {
      let path = await bridge.findReversed(media.path, key, name)
      if (!path) {
        const id = await bridge.createReversed(media.path, key, name)
        const writable = new WritableStream<StreamTargetChunk>({ write: (chunk) => bridge!.writeProxy(id, chunk.position, chunk.data) })
        try {
          await reversal.write(new StreamTarget(writable, { chunked: true }), onProgress, isCancelled)
          path = await bridge.finishProxy(id)
        } catch (err) {
          await bridge.abortProxy(id).catch(() => undefined)
          throw err
        }
      }
      imported = await importPaths([path])[0]
    } else {
      // Browser: the copy lives in memory, like the files imported there.
      const target = new BufferTarget()
      await reversal.write(target, onProgress, isCancelled)
      if (!target.buffer) throw new Error('nothing was written')
      const type = withVideo && media.hasVideo ? 'video/mp4' : 'audio/mp4'
      imported = await importFiles([new File([target.buffer], name, { type })])[0]
    }
  } finally {
    reversal.dispose()
  }
  if (!imported) throw new Error('the reversed copy cannot be read')
  A.updateMedia(imported.id, { reverseOf: link })
  return { ...imported, reverseOf: link }
}

// Jobs: one at a time, shown by the Reverse window (ui/ReverseDialog.tsx).

export interface ReverseJob {
  /** 0..1 */
  progress: number
  label: string
  state: 'running' | 'done' | 'failed' | 'cancelled'
  message: string
  cancelled: boolean
}

let job: ReverseJob | null = null
const listeners = new Set<() => void>()

export const currentReverseJob = (): ReverseJob | null => job

export function onReverseJob(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function publish(patch: Partial<ReverseJob>): void {
  if (!job) return
  job = { ...job, ...patch }
  for (const listener of listeners) listener()
}

export function cancelReverse(): void {
  if (job?.state === 'running') publish({ cancelled: true })
}

useEditor.subscribe((s, prev) => {
  if (prev.dialog?.kind !== 'reverse' || s.dialog?.kind === 'reverse' || !job) return
  // The window closed (Esc, close button): a running job stops, a finished one is forgotten.
  if (job.state === 'running') publish({ cancelled: true })
  else {
    job = null
    for (const listener of listeners) listener()
  }
})

/** Media events that can play backwards: video and sound clips (not stills or text). */
const reversible = (e: TimelineEvent): boolean => {
  if (e.text) return false
  const media = mediaById(e.mediaId)
  return !!media && media.kind !== 'image' && media.status === 'ready'
}

/** A copy in Project Media that already covers source [start, end] of `media` with the tracks needed. */
function existingCopy(media: MediaItem, start: Flicks, end: Flicks, withVideo: boolean): MediaItem | undefined {
  return useEditor
    .getState()
    .media.find(
      (m) =>
        m.reverseOf?.mediaId === media.id &&
        m.status === 'ready' &&
        canRead(m) &&
        m.reverseOf.start <= start &&
        m.reverseOf.end >= end &&
        (m.hasVideo || !withVideo || !media.hasVideo) &&
        (m.hasAudio || !media.hasAudio)
    )
}

/**
 * Plays the events (and their groups) backwards: they keep their place and
 * length and move onto a reversed copy of their media, made when needed; events
 * already on a copy go back to the original. One undo step. Resolves with the
 * number of events changed.
 */
export async function reverseEvents(eventIds: readonly string[]): Promise<number> {
  if (job?.state === 'running') {
    A.setStatus('A clip is already being reversed')
    return 0
  }
  const { project } = useEditor.getState()
  const ids = new Set(A.expandGroups(eventIds, project.events))
  const targets = project.events.filter((e) => ids.has(e.id) && reversible(e))
  if (targets.length === 0) {
    A.setStatus('Select a video or audio clip to reverse')
    return 0
  }

  // Where each event goes: media id and the end of the mapping (see ReverseLink).
  const swaps = new Map<string, { mediaId: string; end: Flicks }>()
  const needed = new Map<string, { media: MediaItem; start: Flicks; end: Flicks; video: boolean; events: TimelineEvent[] }>()
  for (const e of targets) {
    const media = mediaById(e.mediaId) as MediaItem
    const original = media.reverseOf ? mediaById(media.reverseOf.mediaId) : undefined
    if (media.reverseOf && original && original.status === 'ready') {
      swaps.set(e.id, { mediaId: original.id, end: media.reverseOf.end })
      continue
    }
    const entry = needed.get(media.id) ?? { media, start: Infinity, end: -Infinity, video: false, events: [] }
    entry.start = Math.min(entry.start, e.offset)
    entry.end = Math.max(entry.end, e.offset + sourceLength(e))
    entry.video ||= e.kind === 'video'
    entry.events.push(e)
    needed.set(media.id, entry)
  }

  // Parts of files still to reverse: whole short files, otherwise the clips with some room around.
  const work: { media: MediaItem; start: number; end: number; video: boolean; events: TimelineEvent[] }[] = []
  for (const entry of needed.values()) {
    const copy = existingCopy(entry.media, entry.start, entry.end, entry.video)
    if (copy?.reverseOf) {
      for (const e of entry.events) swaps.set(e.id, { mediaId: copy.id, end: copy.reverseOf.end })
      continue
    }
    const duration = flicksToSeconds(entry.media.duration)
    const whole = duration > 0 && duration <= WHOLE_FILE
    const start = whole ? 0 : Math.max(0, flicksToSeconds(entry.start) - HANDLE)
    const end = whole ? duration : Math.min(duration > 0 ? duration : Infinity, flicksToSeconds(entry.end) + HANDLE)
    work.push({ media: entry.media, start, end, video: entry.video, events: entry.events })
  }

  if (work.length > 0) {
    const total = work.reduce((sum, w) => sum + (w.end - w.start), 0)
    job = { progress: 0, label: '', state: 'running', message: '', cancelled: false }
    A.openDialog({ kind: 'reverse' })
    let done = 0
    try {
      for (const [i, w] of work.entries()) {
        publish({ label: work.length > 1 ? `${w.media.name} (${i + 1}/${work.length})` : w.media.name })
        const copy = await makeReversedCopy(
          w.media,
          w.start,
          w.end,
          w.video,
          (seconds) => {
            done += seconds
            const progress = Math.min(0.99, done / Math.max(1e-6, total))
            if (progress - (job?.progress ?? 0) >= 0.005) publish({ progress })
          },
          () => job?.cancelled === true
        )
        for (const e of w.events) swaps.set(e.id, { mediaId: copy.id, end: copy.reverseOf!.end })
      }
    } catch (err) {
      const cancelled = err instanceof ReverseCancelled
      const message = cancelled ? 'Reverse cancelled' : `Cannot reverse: ${err instanceof Error ? err.message : String(err)}`
      publish({ state: cancelled ? 'cancelled' : 'failed', message })
      A.setStatus(message)
      return 0
    }
  }

  const changed = A.reverseEventMedia(swaps)
  if (work.length > 0) publish({ state: 'done', progress: 1, message: `Reversed ${changed} event${changed === 1 ? '' : 's'}` })
  return changed
}

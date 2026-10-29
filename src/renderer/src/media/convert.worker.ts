import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  BufferSource,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  Input,
  MkvOutputFormat,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  VideoSample,
  VideoSampleSource,
  canEncodeAudio,
  canEncodeVideo,
  type StreamTargetChunk
} from 'mediabunny'
import { registerAc3Decoder } from '@mediabunny/ac3'
import { ProgramStreamReader, ticksBetween, type PesPacket } from './mpeg/programStream'
import { Mpeg2VideoDecoder, type DecodedPicture, type SequenceInfo } from './mpeg/video'
import { deinterlacePlane, type InterlacedFrame } from './mpeg/deinterlace'
import { bicubicTaps, resampleLines, squareWidth, type Taps } from './mpeg/resample'
import { GpuFields } from './mpeg/gpuFields'
import { lpcmToS16, splitAc3, splitMpegAudio, type AudioFrames } from './mpeg/audio'

// Makes an editable copy of a camcorder file the editor cannot read (an MPEG-1
// or MPEG-2 program stream: .mpg, .mod, .vob): its picture decoded here,
// deinterlaced to one frame per field and stretched to square pixels, its
// sound decoded, both encoded to an MP4 (H.264, AAC) written through the main
// thread. See media/convert.ts.

export type ConvertRequest =
  | { type: 'start'; file: File | null; url: string }
  /** The main thread wrote chunk `id`. */
  | { type: 'written'; id: number }

export type ConvertReply =
  | { type: 'write'; id: number; position: number; data: Uint8Array }
  | { type: 'progress'; value: number }
  | { type: 'done'; summary: string }
  | { type: 'failed'; error: string }

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ConvertRequest>) => void) | null
  postMessage(message: ConvertReply, transfer?: Transferable[]): void
}

const writes = new Map<number, () => void>()
let nextWrite = 1

scope.onmessage = (event) => {
  const message = event.data
  if (message.type === 'start') {
    convert(message.file, message.url).then(
      (summary) => scope.postMessage({ type: 'done', summary }),
      (err: unknown) => scope.postMessage({ type: 'failed', error: err instanceof Error ? err.message : String(err) })
    )
  } else if (message.type === 'written') {
    writes.get(message.id)?.()
    writes.delete(message.id)
  }
}

/** Reads the file from start to end in chunks, reporting the share read. */
async function* readAll(file: File | null, url: string, onRead: (share: number) => void): AsyncGenerator<Uint8Array> {
  let stream: ReadableStream<Uint8Array>
  let size: number
  if (file) {
    stream = file.stream()
    size = file.size
  } else {
    const response = await fetch(url)
    if (!response.ok || !response.body) throw new Error(`cannot read the file (${response.status})`)
    stream = response.body
    size = Number(response.headers.get('content-length')) || 0
  }
  const reader = stream.getReader()
  let read = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      read += value.length
      if (size) onRead(Math.min(1, read / size))
      yield value
    }
  } finally {
    reader.releaseLock()
  }
}

const isVideo = (p: PesPacket): boolean => p.stream >= 0xe0 && p.stream <= 0xef
const isAudio = (p: PesPacket): boolean =>
  (p.stream >= 0xc0 && p.stream <= 0xdf) || (p.stream === 0xbd && ((p.substream >= 0x80 && p.substream <= 0x87) || (p.substream >= 0xa0 && p.substream <= 0xa7)))
const audioKey = (p: PesPacket): number => (p.stream << 8) | p.substream

interface Sound {
  /** Decoded samples from the sound's first frame on (time 0). */
  samples: () => AsyncGenerator<AudioSample>
  /** 90 kHz time of the first frame. */
  pts: number
  codec: string
}

/** The first sound track: its packets gathered (they are small), ready to decode; or why there is none. */
async function gatherSound(file: File | null, url: string, onRead: (share: number) => void): Promise<Sound | string> {
  const reader = new ProgramStreamReader()
  let key = -1
  let pts: number | null = null
  const parts: Uint8Array[] = []
  let length = 0
  const take = (packets: PesPacket[]): void => {
    for (const p of packets) {
      if (!isAudio(p)) continue
      if (key < 0) key = audioKey(p)
      if (audioKey(p) !== key) continue
      pts ??= p.pts
      parts.push(p.data)
      length += p.data.length
    }
  }
  for await (const chunk of readAll(file, url, onRead)) take(reader.push(chunk))
  take(reader.finish())
  if (key < 0 || pts === null) return 'no sound track'
  const stream = new Uint8Array(length)
  let at = 0
  for (const part of parts) {
    stream.set(part, at)
    at += part.length
  }
  const substream = key & 0xff
  if (key >> 8 === 0xbd && substream >= 0xa0) {
    const format = reader.lpcm.get(substream)
    if (!format || format.bits !== 16) return `no sound: ${format?.bits ?? '?'}-bit LPCM is not supported`
    return { samples: () => lpcmSamples(stream, format.sampleRate, format.channels), pts, codec: 'lpcm' }
  }
  const frames = key >> 8 === 0xbd ? splitAc3(stream) : splitMpegAudio(stream)
  if (!frames) return 'no sound: no complete sound frames'
  if (frames.codec === 'mp2') return 'no sound: MPEG audio layer I/II cannot be decoded here'
  if (frames.codec === 'ac3') registerAc3Decoder()
  const sink = await decoderFor(frames)
  return sink ? { samples: () => sink.samples(), pts, codec: frames.codec } : `no sound: ${frames.codec} cannot be decoded here`
}

async function* lpcmSamples(stream: Uint8Array, sampleRate: number, channels: number): AsyncGenerator<AudioSample> {
  const all = lpcmToS16(stream)
  const step = sampleRate * channels
  for (let i = 0; i < all.length; i += step) {
    yield new AudioSample({ data: all.subarray(i, i + step), format: 's16', numberOfChannels: channels, sampleRate, timestamp: i / step })
  }
}

/** Puts the frames in a Matroska file in memory, so Mediabunny decodes them (AC-3 through its extension). */
async function decoderFor(frames: AudioFrames): Promise<AudioSampleSink | null> {
  const target = new BufferTarget()
  const output = new Output({ format: new MkvOutputFormat(), target })
  const source = new EncodedAudioPacketSource(frames.codec === 'ac3' ? 'ac3' : 'mp3')
  output.addAudioTrack(source)
  await output.start()
  const duration = frames.samplesPerFrame / frames.sampleRate
  for (let i = 0; i < frames.frames.length; i++) {
    const packet = new EncodedPacket(frames.frames[i], 'key', i * duration, duration)
    await source.add(
      packet,
      i === 0 ? { decoderConfig: { codec: frames.codec === 'ac3' ? 'ac-3' : 'mp3', sampleRate: frames.sampleRate, numberOfChannels: frames.channels } } : undefined
    )
  }
  source.close()
  await output.finalize()
  if (!target.buffer) return null
  const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(target.buffer) })
  const track = await input.getPrimaryAudioTrack()
  if (!track || !(await track.canDecode())) return null
  return new AudioSampleSink(track)
}

/** Drops the first `seconds` of a sample (sound that starts before the first picture). */
function trimStart(sample: AudioSample, seconds: number): AudioSample | null {
  const drop = Math.round(seconds * sample.sampleRate)
  const keep = sample.numberOfFrames - drop
  if (keep <= 0) return null
  const channels = sample.numberOfChannels
  const data = new Float32Array(keep * channels)
  for (let c = 0; c < channels; c++) {
    sample.copyTo(data.subarray(c * keep, (c + 1) * keep), { planeIndex: c, format: 'f32-planar', frameOffset: drop, frameCount: keep })
  }
  return new AudioSample({ data, format: 'f32-planar', numberOfChannels: channels, sampleRate: sample.sampleRate, timestamp: 0 })
}

/** H.264 on the graphics card first (plays everywhere), then any encoder. */
async function pickEncoder(width: number, height: number, bitrate: number): Promise<{ codec: 'avc' | 'hevc'; hardwareAcceleration: 'prefer-hardware' | 'no-preference' }> {
  const tries = [
    ['avc', 'prefer-hardware'],
    ['avc', 'no-preference'],
    ['hevc', 'prefer-hardware'],
    ['hevc', 'no-preference']
  ] as const
  for (const [codec, hardwareAcceleration] of tries) {
    if (await canEncodeVideo(codec, { width, height, bitrate, hardwareAcceleration }).catch(() => false)) return { codec, hardwareAcceleration }
  }
  throw new Error('no video encoder available')
}

const asFrame = (p: DecodedPicture): InterlacedFrame => ({
  y: { data: p.y, offset: 0, stride: p.stride },
  u: { data: p.u, offset: 0, stride: p.stride >> 1 },
  v: { data: p.v, offset: 0, stride: p.stride >> 1 },
  width: p.width,
  height: p.height,
  topFieldFirst: p.topFieldFirst,
  progressive: p.progressive
})

interface Picture {
  frame: InterlacedFrame
  /** Seconds from the first picture. */
  time: number
  duration: number
  /** GPU slot holding it. */
  slot: number
}

async function convert(file: File | null, url: string): Promise<string> {
  let shown = 0
  const progress = (value: number): void => {
    if (value - shown < 0.005 && value < 1) return
    shown = value
    scope.postMessage({ type: 'progress', value })
  }
  // First pass: the sound (a few megabytes); second pass: the picture, encoded as it is decoded.
  const found = await gatherSound(file, url, (share) => progress(share * 0.05))
  const sound = typeof found === 'string' ? null : found

  const writable = new WritableStream<StreamTargetChunk>({
    write: (chunk) =>
      new Promise<void>((resolve) => {
        const id = nextWrite++
        writes.set(id, resolve)
        const data = chunk.data.slice()
        scope.postMessage({ type: 'write', id, position: chunk.position, data }, [data.buffer])
      })
  })
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new StreamTarget(writable, { chunked: true }) })

  const reader = new ProgramStreamReader()
  const decoder = new Mpeg2VideoDecoder()
  let videoSource = null as VideoSampleSource | null
  let audioSource = null as AudioSampleSource | null
  let soundDone: Promise<void> = Promise.resolve()
  let seq = null as SequenceInfo | null
  let outWidth = 0
  let gpu = null as GpuFields | null
  let taps: Taps | null = null
  let chromaTaps: Taps | null = null
  let origin: number | null = null
  let nextTime = 0
  let frames = 0
  let written = 0
  const window: Picture[] = []
  let failure: unknown = null

  const start = async (first: DecodedPicture): Promise<void> => {
    seq = decoder.sequence as SequenceInfo
    outWidth = squareWidth(first.height, seq.aspect)
    const fps = seq.progressive ? seq.frameRate : seq.frameRate * 2
    // Visually lossless for standard definition: about 0.4 bits per pixel.
    const bitrate = Math.round(Math.min(25e6, Math.max(4e6, outWidth * first.height * fps * 0.4)))
    const encoder = await pickEncoder(outWidth, first.height, bitrate)
    gpu = GpuFields.create(first.width, first.height, outWidth, first.height)
    if (!gpu) {
      taps = bicubicTaps(first.width, outWidth)
      chromaTaps = bicubicTaps(first.width >> 1, outWidth >> 1)
    }
    videoSource = new VideoSampleSource({ ...encoder, bitrate, keyFrameInterval: 0.5, latencyMode: 'quality' })
    output.addVideoTrack(videoSource, { frameRate: fps })
    if (sound) {
      // Stereo at 48 kHz (the most AAC encoders take: Windows' tops out at 192 kb/s), Opus where there is no AAC.
      const aac = await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 48000, bitrate: 192000 }).catch(() => false)
      const transform = { numberOfChannels: 2, sampleRate: 48000 }
      audioSource = new AudioSampleSource({ codec: aac ? 'aac' : 'opus', bitrate: 192000, transform })
      output.addAudioTrack(audioSource)
    }
    await output.start()
    if (sound && audioSource) {
      const source = audioSource
      // Sound from before the first picture is cut off; the rest keeps its distance to the picture.
      const offset = ticksBetween(origin as number, sound.pts) / 90000
      soundDone = (async () => {
        for await (const sample of sound.samples()) {
          const time = sample.timestamp + offset
          if (time >= 0) {
            sample.setTimestamp(time)
            await source.add(sample)
          } else {
            const trimmed = trimStart(sample, -time)
            if (trimmed) {
              await source.add(trimmed)
              trimmed.close()
            }
          }
          sample.close()
        }
        source.close()
      })().catch((err: unknown) => {
        failure ??= err
      })
    }
  }

  /** Encodes the field frames of window[i] (with its neighbours for the motion). */
  const emit = async (i: number): Promise<void> => {
    const cur = window[i]
    const prev = window[i - 1] ?? cur
    const next = window[i + 1] ?? cur
    const sequence = seq as SequenceInfo
    const firstParity = cur.frame.topFieldFirst ? 0 : 1
    const fields = sequence.progressive ? 1 : 2
    for (let field = 0; field < fields; field++) {
      const kept = field === 0 ? firstParity : 1 - firstParity
      const missing = sequence.progressive || cur.frame.progressive ? -1 : 1 - kept
      const before = field === 0 ? prev : cur
      const after = field === 0 ? cur : next
      const time = cur.time + (field * cur.duration) / fields
      const duration = cur.duration / fields
      let sample: VideoSample
      if (gpu) {
        gpu.draw(cur.slot, before.slot, after.slot, prev.slot, next.slot, missing)
        const frame = new VideoFrame(gpu.canvas, { timestamp: Math.round(time * 1e6), duration: Math.round(duration * 1e6), alpha: 'discard' })
        sample = new VideoSample(frame)
      } else {
        sample = cpuField(cur.frame, before.frame, after.frame, prev.frame, next.frame, missing, time, duration)
      }
      await (videoSource as VideoSampleSource).add(sample)
      sample.close()
      written++
    }
  }

  const cpuField = (
    cur: InterlacedFrame,
    before: InterlacedFrame,
    after: InterlacedFrame,
    prev: InterlacedFrame,
    next: InterlacedFrame,
    missing: number,
    time: number,
    duration: number
  ): VideoSample => {
    const { width, height } = cur
    const cw = width >> 1
    const ch = height >> 1
    const whole = new Uint8Array(width * height + 2 * cw * ch)
    const planes = [
      ['y', 0, width, height],
      ['u', width * height, cw, ch],
      ['v', width * height + cw * ch, cw, ch]
    ] as const
    for (const [plane, offset, w, h] of planes) {
      if (missing < 0) {
        const src = cur[plane]
        for (let y = 0; y < h; y++) whole.set(src.data.subarray(src.offset + y * src.stride, src.offset + y * src.stride + w), offset + y * w)
      } else deinterlacePlane(whole, offset, w, h, missing, cur[plane], before[plane], after[plane], prev[plane], next[plane])
    }
    const out = new Uint8Array(outWidth * height + 2 * (outWidth >> 1) * ch)
    resampleLines(whole, 0, width, height, taps as Taps, out, 0)
    resampleLines(whole, width * height, cw, ch, chromaTaps as Taps, out, outWidth * height)
    resampleLines(whole, width * height + cw * ch, cw, ch, chromaTaps as Taps, out, outWidth * height + (outWidth >> 1) * ch)
    const pal = height === 576
    return new VideoSample(out, {
      format: 'I420',
      codedWidth: outWidth,
      codedHeight: height,
      timestamp: time,
      duration,
      colorSpace: { primaries: pal ? 'bt470bg' : 'smpte170m', transfer: 'smpte170m', matrix: 'smpte170m', fullRange: false }
    })
  }

  const take = async (pictures: DecodedPicture[]): Promise<void> => {
    for (const p of pictures) {
      if (failure) throw failure
      if (!videoSource) {
        origin = p.pts ?? 0
        await start(p)
      }
      const sequence = seq as SequenceInfo
      const frameDuration = (1 / sequence.frameRate) * (p.repeatFirstField && !sequence.progressive ? 1.5 : 1)
      // Regular steps, unless the stream's own time stamp says the picture is elsewhere (a gap).
      let time = nextTime
      if (p.pts !== null) {
        const stamped = ticksBetween(origin as number, p.pts) / 90000
        if (Math.abs(stamped - time) > frameDuration / 2 && stamped > nextTime - frameDuration) time = stamped
      }
      nextTime = time + frameDuration
      const slot = frames++ % 3
      const picture: Picture = { frame: asFrame(p), time, duration: frameDuration, slot }
      gpu?.upload(slot, picture.frame)
      window.push(picture)
      if (window.length > 3) window.shift()
      // A frame is made once the one after it is there.
      if (window.length >= 2) await emit(window.length - 2)
    }
  }

  for await (const chunk of readAll(file, url, (share) => progress(0.05 + share * 0.95))) {
    for (const packet of reader.push(chunk)) if (isVideo(packet)) decoder.push(packet.data, packet.pts)
    await take(decoder.take())
  }
  for (const packet of reader.finish()) if (isVideo(packet)) decoder.push(packet.data, packet.pts)
  decoder.flush()
  await take(decoder.take())
  if (!videoSource) throw new Error('no MPEG video found in this file')
  if (window.length) await emit(window.length - 1)
  ;(videoSource as VideoSampleSource).close()
  await soundDone
  if (failure) throw failure
  await output.finalize()
  gpu?.dispose()
  progress(1)
  const sequence = seq as SequenceInfo
  return [
    `${sequence.mpeg2 ? 'MPEG-2' : 'MPEG-1'} ${sequence.width}x${sequence.height}`,
    sequence.progressive ? `${sequence.frameRate} fps` : `${sequence.frameRate * 2} fields/s deinterlaced`,
    `to ${outWidth}x${sequence.height}`,
    `${written} frames`,
    sound ? `sound ${sound.codec}` : (found as string),
    gpu ? 'GPU' : 'CPU'
  ].join(', ')
}

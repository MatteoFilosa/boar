// Render check: a small project made of media this module creates itself is
// rendered through the real export path (decode, compose, mix, encode) and its
// frames and sound are compared with what the project must look and sound
// like. Run by the smoke test (npm run smoke, every CI system, packaged apps),
// so a change that breaks the output fails the build. Loaded only when asked.

import {
  ALL_FORMATS,
  AudioBufferSink,
  BufferSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Input,
  type InputAudioTrack,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  canEncodeVideo
} from 'mediabunny'
import { addMediaItem } from './core/actions'
import { createFx } from './core/fx'
import { emptyProject, useEditor } from './core/store'
import { normalizeText } from './core/text'
import { secondsToFlicks } from './core/time'
import type { MediaItem, Project, TimelineEvent, Track } from './core/types'
import { uid } from './core/ids'
import { DEFAULT_FADE_CURVE } from './core/fades'
import { dropMediaCache } from './media/cache'
import { track as analyze } from './media/importer'
import { encodeWav } from './media/wav'
import { type ExportResult, exportProject } from './engine/export'
import { SOUND_FORMATS, exportSound, soundSupport } from './engine/exportSound'
import { exportGif } from './engine/exportGif'

export interface RenderCheckResult {
  ok: boolean
  /** Video codec used for the source clip and the render. */
  codec: string
  failures: string[]
  /** Checks left out on this machine (no WebGL2: Video FX). */
  skipped: string[]
  /** Measured delay of the sound after the picture, in ms (null when it could not be measured). */
  audioOffsetMs: number | null
  /** Audio codec of the render and the encoder delay the export took out, in samples. */
  audioCodec: string
  encoderDelay: number
  /** Other renders checked: sound only formats and GIF. */
  formats: string[]
  ms: number
}

const W = 640
const H = 360
const RATE = { num: 30, den: 1 }

type RGB = [number, number, number]
const RED: RGB = [255, 0, 0]
const BLUE: RGB = [0, 0, 255]
const GREEN: RGB = [0, 255, 0]
const BLACK: RGB = [0, 0, 0]
/** Per channel: lossy encoding of flat colors, twice (source clip and render). */
const COLOR_TOLERANCE = 40
const LEVEL_TOLERANCE_DB = 1.5

const s = secondsToFlicks

/** 3 s clip: red | blue for 1.5 s, then green | black; a keyframe every half second. */
async function makeClip(codec: 'avc' | 'vp9'): Promise<File> {
  const canvas = new OffscreenCanvas(W, H)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const target = new BufferTarget()
  const output = new Output({ format: new Mp4OutputFormat(), target })
  const source = new CanvasSource(canvas, { codec, bitrate: QUALITY_HIGH, keyFrameInterval: 0.5 })
  output.addVideoTrack(source, { frameRate: 30 })
  await output.start()
  for (let i = 0; i < 90; i++) {
    const late = i >= 45
    ctx.fillStyle = late ? '#00ff00' : '#ff0000'
    ctx.fillRect(0, 0, W / 2, H)
    ctx.fillStyle = late ? '#000000' : '#0000ff'
    ctx.fillRect(W / 2, 0, W / 2, H)
    await source.add(i / 30, 1 / 30)
  }
  await output.finalize()
  return new File([target.buffer as ArrayBuffer], 'check-clip.mp4', { type: 'video/mp4' })
}

/** White square picture. */
async function makePicture(): Promise<File> {
  const canvas = new OffscreenCanvas(64, 64)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 64, 64)
  return new File([await canvas.convertToBlob({ type: 'image/png' })], 'check-picture.png', { type: 'image/png' })
}

/** 4 s of a 440 Hz tone at half scale (-9 dBFS RMS), stereo. */
function makeTone(): File {
  const rate = 48000
  const buffer = new AudioBuffer({ length: rate * 4, numberOfChannels: 2, sampleRate: rate })
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c)
    for (let n = 0; n < data.length; n++) data[n] = 0.5 * Math.sin((2 * Math.PI * 440 * n) / rate)
  }
  return new File([encodeWav(buffer)], 'check-tone.wav', { type: 'audio/wav' })
}

async function addMedia(file: File): Promise<MediaItem> {
  const kind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('audio/') ? 'audio' : 'video'
  const item: MediaItem = {
    id: uid(),
    name: file.name,
    kind,
    file,
    url: URL.createObjectURL(file),
    path: '',
    size: file.size,
    status: 'analyzing',
    error: '',
    duration: 0,
    hasVideo: kind !== 'audio',
    hasAudio: false,
    width: 0,
    height: 0,
    fps: 0,
    videoCodec: '',
    audioCodec: '',
    sampleRate: 0,
    channels: 0,
    poster: ''
  }
  addMediaItem(item)
  const ready = await analyze(item)
  if (!ready) throw new Error(`${file.name} could not be read: ${useEditor.getState().media.find((m) => m.id === item.id)?.error}`)
  return ready
}

function trackOf(id: string, kind: 'video' | 'audio'): Track {
  return { id, kind, name: id, color: 0, muted: false, solo: false, level: 1, volumeDb: 0, pan: 0, height: 60 }
}

function event(id: string, trackId: string, mediaId: string, kind: 'video' | 'audio', start: number, length: number, patch: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id,
    trackId,
    mediaId,
    kind,
    start: s(start),
    length: s(length),
    offset: 0,
    fadeIn: 0,
    fadeOut: 0,
    fadeInCurve: DEFAULT_FADE_CURVE,
    fadeOutCurve: DEFAULT_FADE_CURVE,
    rate: 1,
    groupId: null,
    gain: 1,
    panCrop: [],
    text: null,
    shape: null,
    mask: null,
    fx: [],
    envelope: [],
    transition: null,
    transitionOut: null,
    ...patch
  }
}

const near = (a: RGB, b: RGB): boolean => a.every((v, i) => Math.abs(v - b[i]) <= COLOR_TOLERANCE)
const db = (v: number): number => 20 * Math.log10(v + 1e-9)
const TONE_RMS = 0.5 / Math.SQRT2
/** The second tone: -12 dB of event gain and -6 dB of Audio FX. */
const QUIET_RMS = TONE_RMS * 0.25 * Math.pow(10, -6 / 20)

/** RMS of the left channel between two times, from the whole track placed by packet time. */
async function levels(audio: InputAudioTrack, seconds: number): Promise<(from: number, to: number) => number> {
  const rate = audio.sampleRate
  const pcm = new Float32Array(Math.ceil(seconds * rate))
  for await (const { buffer, timestamp } of new AudioBufferSink(audio).buffers()) {
    const at = Math.round(timestamp * rate)
    const data = buffer.getChannelData(0)
    pcm.set(data.subarray(Math.max(0, -at), Math.max(0, Math.min(data.length, pcm.length - at))), Math.max(0, at))
  }
  return (from, to) => {
    const a = Math.max(0, Math.round(from * rate))
    const b = Math.min(pcm.length, Math.round(to * rate))
    let sum = 0
    for (let i = a; i < b; i++) sum += pcm[i] * pcm[i]
    return Math.sqrt(sum / Math.max(1, b - a))
  }
}

/** Sound only renders of the tone track in every format this system writes: length and levels. */
async function checkSoundFormats(project: Project, failures: string[]): Promise<string[]> {
  const support = await soundSupport()
  const checked: string[] = []
  for (const format of SOUND_FORMATS.filter((f) => support[f])) {
    const target = new BufferTarget()
    try {
      // Only the audio track, even though the timeline goes on to 5 s with pictures.
      const settings = { format, quality: 'high' as const, masterDb: 0, autoCrossfade: true, loudness: null, tracks: ['A1'] }
      await exportSound(project, target, settings, () => undefined, () => false)
      if (!target.buffer) throw new Error('no file')
      const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(target.buffer) })
      try {
        const duration = await input.computeDuration()
        if (Math.abs(duration - 5) > 0.1) failures.push(`${format}: length ${duration.toFixed(2)} s instead of 5 s`)
        const audio = await input.getPrimaryAudioTrack()
        if (!audio) throw new Error('no sound in the file')
        const rms = await levels(audio, 5.5)
        const expect = (what: string, from: number, to: number, want: number | null): void => {
          const got = db(rms(from, to))
          if (want === null ? got > -45 : Math.abs(got - want) > LEVEL_TOLERANCE_DB)
            failures.push(`${format}: ${what} at ${from}-${to} s: ${got.toFixed(1)} dBFS, want ${want === null ? 'silence' : want.toFixed(1)}`)
        }
        expect('tone', 0.5, 1.5, db(TONE_RMS))
        expect('gap', 2.1, 2.4, null)
        expect('tone at -12 dB and Audio FX -6 dB', 3, 3.5, db(QUIET_RMS))
        expect('end', 4.2, 4.9, null)
      } finally {
        input.dispose()
      }
      checked.push(format)
    } catch (err) {
      failures.push(`${format}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return checked
}

/** A GIF of the project: length from the frame delays, and colors of the clip at 0.75 s. */
async function checkGif(project: Project, failures: string[]): Promise<boolean> {
  if (typeof ImageDecoder === 'undefined') return false
  try {
    const file = await exportGif(project, { width: 160, fps: 10, quality: 'high', autoCrossfade: true }, () => undefined, () => false)
    const decoder = new ImageDecoder({ data: file, type: 'image/gif' })
    try {
      await decoder.tracks.ready
      const count = decoder.tracks.selectedTrack?.frameCount ?? 0
      if (count < 5 || count > 50) failures.push(`gif: ${count} frames, want 5-50 (10 fps over 5 s, still frames folded)`)
      let at = 0
      let checked = false
      for (let i = 0; i < count; i++) {
        const { image } = await decoder.decode({ frameIndex: i })
        const length = (image.duration ?? 0) / 1e6
        if (!checked && at + length > 0.75) {
          checked = true
          const canvas = new OffscreenCanvas(image.displayWidth, image.displayHeight)
          const ctx = canvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D
          ctx.drawImage(image, 0, 0)
          const color = (fx: number): RGB => {
            const d = ctx.getImageData(Math.round((canvas.width - 1) * fx), canvas.height >> 1, 1, 1).data
            return [d[0], d[1], d[2]]
          }
          if (!near(color(0.1), RED)) failures.push(`gif: clip at 0.75 s (0.1, 0.5): rgb(${color(0.1).join(', ')}), want red`)
          if (!near(color(0.9), BLUE)) failures.push(`gif: clip at 0.75 s (0.9, 0.5): rgb(${color(0.9).join(', ')}), want blue`)
        }
        at += length
        image.close()
      }
      if (Math.abs(at - 5) > 0.05) failures.push(`gif: plays ${at.toFixed(2)} s instead of 5 s`)
    } finally {
      decoder.close()
    }
    return true
  } catch (err) {
    failures.push(`gif: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}
const mix = (a: RGB, b: RGB, t: number): RGB => a.map((v, i) => Math.round(v + (b[i] - v) * t)) as RGB

/** `codec` and `audioCodec` force the paths of other systems (VP9 and Opus where H.264 or AAC cannot be encoded). */
export async function runRenderCheck(codec?: 'avc' | 'vp9', audioCodec?: 'aac' | 'opus'): Promise<RenderCheckResult> {
  const started = performance.now()
  const failures: string[] = []
  const skipped: string[] = []
  // The check's media have no path: no proxies, nothing written to the app's folders.
  const added: MediaItem[] = []
  let offsetMs: number | null = null
  let rendered: ExportResult['audio'] = null
  const formats: string[] = []
  try {
    codec ??= (await canEncodeVideo('avc', { width: W, height: H }).catch(() => false)) ? 'avc' : 'vp9'
    const clip = await addMedia(await makeClip(codec))
    const picture = await addMedia(await makePicture())
    const tone = await addMedia(makeTone())
    added.push(clip, picture, tone)

    const webgl = !!document.createElement('canvas').getContext('webgl2')
    const negative = createFx('negative')
    const gainFx = createFx('gain')
    if (gainFx) gainFx.params.gain = -6

    // Timeline (seconds), top track in front:
    //   T1  picture 0-1 at 50 %          text 2-3
    //   T2  clip 0-1 (fade in 0.5) | clip from 1.5 s, 1-2 | Pan/Crop 2x on the left half, 2-3 | 2x speed, 3-4 | negative, 4-5
    //   A1  tone 0-2                     tone 2.5-4 at -12 dB, then -6 dB more from Audio FX
    const project: Project = {
      ...emptyProject(),
      settings: { width: W, height: H, frameRate: RATE, sampleRate: 48000 },
      tracks: [trackOf('T1', 'video'), trackOf('T2', 'video'), trackOf('A1', 'audio')],
      events: [
        event('picture', 'T1', picture.id, 'video', 0, 1, { gain: 0.5 }),
        event('title', 'T1', '', 'video', 2, 1, { text: normalizeText({ text: 'BOAR', size: 140, color: '#ffffff', shadow: false, y: 0.5 }) }),
        event('c1', 'T2', clip.id, 'video', 0, 1, { fadeIn: s(0.5) }),
        event('c2', 'T2', clip.id, 'video', 1, 1, { offset: s(1.5) }),
        event('c3', 'T2', clip.id, 'video', 2, 1, { panCrop: [{ time: 0, cx: 0.25, cy: 0.5, zoom: 2, rotation: 0, stretch: 1, ease: 'smooth' }] }),
        event('c4', 'T2', clip.id, 'video', 3, 1, { rate: 2 }),
        event('c5', 'T2', clip.id, 'video', 4, 1, { fx: webgl && negative ? [negative] : [] }),
        // Short fades: a tone cut off abruptly smears into the silence after it once encoded.
        event('a1', 'A1', tone.id, 'audio', 0, 2, { fadeOut: s(0.1) }),
        event('a2', 'A1', tone.id, 'audio', 2.5, 1.5, { gain: 0.25, fadeIn: s(0.1), fadeOut: s(0.1), fx: gainFx ? [gainFx] : [] })
      ],
      markers: []
    }

    const target = new BufferTarget()
    const result = await exportProject(
      project,
      target,
      { codec, quality: 'high', encoder: 'auto', includeAudio: true, audioCodec, masterDb: 0, autoCrossfade: true, loudness: null },
      () => undefined,
      () => false
    )
    rendered = result.audio
    if (!target.buffer) throw new Error('the render produced no file')
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(target.buffer) })
    try {
      const duration = await input.computeDuration()
      if (Math.abs(duration - 5) > 0.1) failures.push(`length ${duration.toFixed(2)} s instead of 5 s`)
      const video = await input.getPrimaryVideoTrack()
      const audio = await input.getPrimaryAudioTrack()
      if (!video || video.displayWidth !== W || video.displayHeight !== H) failures.push(`video ${video?.displayWidth}x${video?.displayHeight} instead of ${W}x${H}`)
      if (!audio) failures.push('no sound in the render')

      if (video) {
        const sink = new CanvasSink(video)
        const frames = new Map<number, OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D>()
        const frameAt = async (t: number): Promise<OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D> => {
          let ctx = frames.get(t)
          if (!ctx) {
            const frame = await sink.getCanvas(t)
            if (!frame) throw new Error(`no frame at ${t} s`)
            ctx = frame.canvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D
            frames.set(t, ctx)
          }
          return ctx
        }
        const pixel = async (t: number, fx: number, fy: number): Promise<RGB> => {
          const ctx = await frameAt(t)
          const d = ctx.getImageData(Math.round((W - 1) * fx), Math.round((H - 1) * fy), 1, 1).data
          return [d[0], d[1], d[2]]
        }
        const expectColor = async (what: string, t: number, fx: number, fy: number, want: RGB): Promise<void> => {
          const got = await pixel(t, fx, fy)
          if (!near(got, want)) failures.push(`${what} at ${t} s (${fx}, ${fy}): got rgb(${got.join(', ')}), want rgb(${want.join(', ')})`)
        }
        const white = mix(RED, [255, 255, 255], 0.5)
        await expectColor('fade in (half way)', 0.25, 0.1, 0.5, mix(BLACK, RED, 0.5))
        await expectColor('clip', 0.75, 0.1, 0.5, RED)
        await expectColor('clip', 0.75, 0.9, 0.5, BLUE)
        await expectColor('picture at 50 % over red', 0.75, 0.4, 0.5, white)
        await expectColor('picture at 50 % over blue', 0.75, 0.6, 0.5, mix(BLUE, [255, 255, 255], 0.5))
        await expectColor('clip from 1.5 s in', 1.5, 0.1, 0.5, GREEN)
        await expectColor('clip from 1.5 s in', 1.5, 0.9, 0.5, BLACK)
        await expectColor('Pan/Crop 2x on the left half', 2.5, 0.1, 0.15, RED)
        await expectColor('Pan/Crop 2x on the left half', 2.5, 0.9, 0.15, RED)
        await expectColor('2x speed', 3.25, 0.9, 0.5, BLUE)
        await expectColor('2x speed (1.8 s into the clip)', 3.9, 0.1, 0.5, GREEN)
        if (webgl) {
          await expectColor('Negative', 4.5, 0.1, 0.5, [0, 255, 255])
          await expectColor('Negative', 4.5, 0.9, 0.5, [255, 255, 0])
        } else {
          skipped.push('Video FX (no WebGL2)')
        }
        // The title: white letters on the red Pan/Crop frame.
        const ctx = await frameAt(2.5)
        const data = ctx.getImageData(0, 0, W, H).data
        let letters = 0
        for (let i = 0; i < data.length; i += 16) if (data[i + 1] > 200 && data[i + 2] > 200) letters++
        if (letters < 100) failures.push(`title: ${letters} white samples, the text was not drawn`)
      }

      if (audio) {
        // The left channel of the whole render, placed by packet time.
        const rms = await levels(audio, 5.5)
        const toneRms = TONE_RMS
        const quietRms = QUIET_RMS
        // Where a fade passes half its level (10 ms windows): the out of the first tone at 1.95 s, the in of the second at 2.55 s.
        const crossing = (from: number, to: number, level: number, falling: boolean): number | null => {
          for (let t = from; t <= to; t += 0.001) if (falling ? rms(t - 0.005, t + 0.005) < level : rms(t - 0.005, t + 0.005) > level) return t
          return null
        }
        const out = crossing(1.8, 2.3, toneRms / 2, true)
        const into = crossing(2.3, 2.8, quietRms / 2, false)
        if (out === null || into === null) failures.push('sound: the fades between the tones were not found')
        else {
          // Sound later than the picture (positive) is noticed far later than sound ahead of it.
          offsetMs = Math.round(((out - 1.95 + (into - 2.55)) / 2) * 1000)
          if (offsetMs < -25 || offsetMs > 60) failures.push(`sound ${offsetMs} ms ${offsetMs > 0 ? 'behind' : 'ahead of'} the picture`)
        }
        // Levels away from the fades, through the measured offset.
        const o = (offsetMs ?? 0) / 1000
        const expectLevel = (what: string, from: number, to: number, want: number): void => {
          const got = db(rms(from + o, to + o))
          if (Math.abs(got - want) > LEVEL_TOLERANCE_DB) failures.push(`${what} at ${from}-${to} s: ${got.toFixed(1)} dBFS, want ${want.toFixed(1)}`)
        }
        const expectSilence = (what: string, from: number, to: number): void => {
          const got = db(rms(from + o, to + o))
          if (got > -45) failures.push(`${what} at ${from}-${to} s: ${got.toFixed(1)} dBFS, want silence`)
        }
        expectLevel('tone', 0.5, 1.5, db(toneRms))
        expectSilence('gap', 2.05, 2.45)
        expectLevel('tone at -12 dB and Audio FX -6 dB', 3, 3.5, db(quietRms))
        expectSilence('end', 4.1, 4.9)
      }
    } finally {
      input.dispose()
    }
    formats.push(...(await checkSoundFormats(project, failures)))
    if (await checkGif(project, failures)) formats.push('gif')
  } catch (err) {
    failures.push(err instanceof Error ? err.message : String(err))
  } finally {
    for (const m of added) {
      URL.revokeObjectURL(m.url)
      dropMediaCache(m.id)
    }
    const ids = new Set(added.map((m) => m.id))
    useEditor.setState((st) => ({ media: st.media.filter((m) => !ids.has(m.id)) }))
  }
  return {
    ok: failures.length === 0,
    codec: codec ?? '',
    failures,
    skipped,
    audioOffsetMs: offsetMs,
    audioCodec: rendered?.codec ?? '',
    encoderDelay: rendered?.encoderDelay ?? 0,
    formats,
    ms: Math.round(performance.now() - started)
  }
}

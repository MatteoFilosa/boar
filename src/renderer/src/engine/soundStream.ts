import { type Flicks, flicksToSeconds } from '../core/time'
import { sourceTime } from '../core/timeline'
import type { MediaItem, TimelineEvent } from '../core/types'
import { isElectron, mediaPathUrl } from '../platform'
import { StretchStream } from './stretch'
import SoundDecoder from './soundDecoder.worker?worker&inline'

/**
 * Preview sound of one audio event, decoded like the export does and scheduled
 * on the AudioContext clock. Media elements had to seek on every jump (up to a
 * second or two on long files, more on slow frames), started late and drifted;
 * decoded pieces start as soon as the first one is ready, exactly where the
 * timeline is. Decoding runs in a worker (soundDecoder.worker.ts).
 */

/** Where the preview clock is: the timeline time now, and when a timeline time is played. */
export interface SoundClock {
  now(): Flicks
  /** AudioContext time (seconds) at which timeline time `t` is played. */
  contextTimeAt(t: Flicks): number
}

export interface SoundInfo {
  channels: number
}

export type DecoderRequest =
  | { type: 'open'; key: string; file: File | null; url: string }
  | { type: 'close'; key: string }
  /** Decodes source time [from, to) (seconds from the file's start), sent at `rate` frames per second. */
  | { type: 'start'; run: number; key: string; from: number; to: number; rate: number }
  /** At least `frames` more frames, answered with one 'data' (or 'failed'). */
  | { type: 'read'; run: number; frames: number }
  | { type: 'cancel'; run: number }

export type DecoderReply =
  | { type: 'opened'; key: string; info: SoundInfo | null; error?: string }
  | { type: 'data'; run: number; channels: Float32Array[]; done: boolean }
  | { type: 'failed'; run: number; error: string }

/** Seconds of the first piece after a start: short, so the sound comes back at once. */
const FIRST_PIECE = 0.12
const PIECE = 0.5
/** Seconds scheduled ahead of the clock. */
const AHEAD = 1
/** Each piece overlaps the next by this much (seconds), crossfaded: any rounding at the joins stays smooth. */
const OVERLAP = 0.01
/** Fade at a start or stop in the middle of the sound (seconds). */
const FADE = 0.005
/** A piece is never scheduled sooner than this (seconds): the audio thread may already be past it. */
const SAFETY = 0.01

// Decoder worker

type ReadReply = Extract<DecoderReply, { run: number }>

let worker: Worker | null = null
const reads = new Map<number, (reply: ReadReply) => void>()

interface OpenSound {
  info: Promise<SoundInfo | null>
  settle: (info: SoundInfo | null, error?: string) => void
  lastUsed: number
}

/** Files are opened once and shared by the events that play them. */
const sounds = new Map<string, OpenSound>()
const SOUND_IDLE_MS = 60_000

function decoder(): Worker {
  if (!worker) {
    worker = new SoundDecoder()
    worker.onmessage = (event: MessageEvent<DecoderReply>) => {
      const reply = event.data
      if (reply.type === 'opened') {
        sounds.get(reply.key)?.settle(reply.info, reply.error)
        return
      }
      const settle = reads.get(reply.run)
      reads.delete(reply.run)
      settle?.(reply)
    }
  }
  return worker
}

const soundKey = (media: MediaItem): string => `${media.id}|${media.url}`

/** Opens a file's sound in the decoder (null when it has none or it cannot be read). */
export function openSound(media: MediaItem, onError: (err: unknown) => void): Promise<SoundInfo | null> {
  const key = soundKey(media)
  let open = sounds.get(key)
  if (!open) {
    const file = media.file ?? null
    const url = !file && media.path && isElectron ? mediaPathUrl(media.path) : ''
    if (!file && !url) return Promise.resolve(null)
    let settle: OpenSound['settle'] = () => undefined
    const info = new Promise<SoundInfo | null>((resolve) => {
      settle = (result, error) => {
        if (error) onError(new Error(error))
        resolve(result)
      }
    })
    open = { info, settle, lastUsed: 0 }
    sounds.set(key, open)
    decoder().postMessage({ type: 'open', key, file, url } satisfies DecoderRequest)
  }
  open.lastUsed = performance.now()
  return open.info
}

/** Closes the files no event played for a while. */
export function closeIdleSounds(now: number): void {
  for (const [key, open] of sounds) {
    if (now - open.lastUsed < SOUND_IDLE_MS) continue
    sounds.delete(key)
    decoder().postMessage({ type: 'close', key } satisfies DecoderRequest)
  }
}

let lastRun = 0

/** One pass of the decoder over a stretch of a file. */
class DecodeRun {
  private readonly id = ++lastRun

  constructor(
    private readonly key: string,
    from: number,
    to: number,
    rate: number
  ) {
    decoder().postMessage({ type: 'start', run: this.id, key, from, to, rate } satisfies DecoderRequest)
  }

  read(frames: number): Promise<{ channels: Float32Array[]; done: boolean }> {
    const open = sounds.get(this.key)
    if (open) open.lastUsed = performance.now()
    return new Promise((resolve, reject) => {
      reads.set(this.id, (reply) => (reply.type === 'failed' ? reject(new Error(reply.error)) : resolve(reply)))
      decoder().postMessage({ type: 'read', run: this.id, frames } satisfies DecoderRequest)
    })
  }

  cancel(): void {
    const settle = reads.get(this.id)
    reads.delete(this.id)
    settle?.({ type: 'data', run: this.id, channels: [], done: true })
    decoder().postMessage({ type: 'cancel', run: this.id } satisfies DecoderRequest)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Decoded sound not played yet, per channel. */
class Pending {
  data: Float32Array<ArrayBuffer>[]
  length = 0

  constructor(channels: number) {
    this.data = Array.from({ length: channels }, () => new Float32Array(0))
  }

  append(channels: Float32Array[]): void {
    const n = channels[0]?.length ?? 0
    if (n === 0) return
    const size = this.length + n
    if (size > this.data[0].length) {
      const capacity = Math.max(size, this.data[0].length * 2)
      this.data = this.data.map((old) => {
        const grown = new Float32Array(capacity)
        grown.set(old.subarray(0, this.length))
        return grown
      })
    }
    for (let c = 0; c < this.data.length; c++) this.data[c].set(channels[Math.min(c, channels.length - 1)], this.length)
    this.length = size
  }

  /** Drops the first `count` frames. */
  shift(count: number): void {
    const n = Math.min(count, this.length)
    for (const channel of this.data) channel.copyWithin(0, n, this.length)
    this.length -= n
  }
}

export class SoundStream {
  /** Bumped by every start and stop: decoding for an older start ends. */
  private run = 0
  /** What the running start plays (event timing and clock epoch); '' = stopped. */
  key = ''
  /** Sources of the running start, faded out together on a stop. */
  private out: GainNode | null = null
  private readonly sources = new Set<AudioBufferSourceNode>()

  constructor(
    private readonly ctx: AudioContext,
    private readonly destination: AudioNode,
    private readonly onError: (err: unknown) => void
  ) {}

  get playing(): boolean {
    return this.key !== ''
  }

  /** Plays `ev` from timeline time `from` (its start or later; it may be ahead of the clock). */
  start(ev: TimelineEvent, media: MediaItem, from: Flicks, key: string, clock: SoundClock): void {
    this.stop()
    this.key = key
    const run = this.run
    const out = this.ctx.createGain()
    // Silent until the first piece starts (see schedule).
    out.gain.value = 0
    out.connect(this.destination)
    this.out = out
    void this.decode(run, out, { ...ev }, media, from, clock).catch((err: unknown) => {
      if (run === this.run) this.onError(err)
    })
  }

  stop(): void {
    this.run++
    this.key = ''
    const out = this.out
    this.out = null
    if (!out) return
    const now = this.ctx.currentTime
    out.gain.cancelScheduledValues(now)
    out.gain.setValueAtTime(out.gain.value, now)
    out.gain.linearRampToValueAtTime(0, now + FADE)
    for (const source of this.sources) source.stop(now + FADE + 0.005)
    this.sources.clear()
    setTimeout(() => out.disconnect(), 100)
  }

  private async decode(
    run: number,
    out: GainNode,
    ev: TimelineEvent,
    media: MediaItem,
    from: Flicks,
    clock: SoundClock
  ): Promise<void> {
    const end = ev.start + ev.length
    // Start and end on the context's sample grid: where a cut clip's piece ends, the
    // next one starts on the same frame (rounded apart, they left a frame of silence).
    const ctxRate = this.ctx.sampleRate
    const startFrame = Math.round(clock.contextTimeAt(from) * ctxRate)
    const endFrame = Math.round(clock.contextTimeAt(end) * ctxRate)
    const info = await openSound(media, this.onError)
    if (!info || run !== this.run) return
    const rate = ev.rate
    // The decoder sends the sound at the context's rate.
    const sr = ctxRate
    /** Output frames from `from` to the event end. */
    const total = Math.max(0, endFrame - startFrame)
    const overlap = Math.round(OVERLAP * sr)
    /** Sound ready to play (time-stretched already at other speeds). */
    const pending = new Pending(info.channels)
    const stretch = Math.abs(rate - 1) < 1e-4 ? null : new StretchStream(rate, sr, info.channels)
    const decoding = new DecodeRun(soundKey(media), flicksToSeconds(sourceTime(ev, from)), flicksToSeconds(sourceTime(ev, end)), sr)
    let done = false
    // One read ahead: on a busy main thread each answer of the worker waits for a frame,
    // so the next piece is asked for while this one plays.
    let reading: ReturnType<DecodeRun['read']> | null = null
    const read = (frames: number): ReturnType<DecodeRun['read']> => (reading ??= decoding.read(frames))
    const pieceInput = Math.round(PIECE * rate * sr)
    const stretchAhead = Math.round(0.06 * sr)
    /** Output frames scheduled. */
    let played = 0
    // A start inside the sound fades in; at the event start the sound begins as the export does.
    let fadeIn = from > ev.start
    try {
      while (run === this.run && played < total) {
        while (run === this.run && flicksToSeconds(from - clock.now()) + played / sr > AHEAD) await sleep(40)
        if (run !== this.run) return
        let size = Math.min(Math.round((played === 0 ? FIRST_PIECE : PIECE) * sr), total - played)
        // A rest shorter than the crossfade joins this piece: its overlap would sound past the event end.
        if (total - played - size < 2 * overlap) size = total - played
        const last = played + size >= total
        const length = size + (last ? 0 : overlap)
        while (pending.length < length) {
          const stretched = stretch?.pull()
          if (stretched && stretched[0].length > 0) {
            pending.append(stretched)
            continue
          }
          if (done) break
          // The first read brings the second piece too; stretching reads a frame ahead.
          const data = await read(Math.ceil((length - pending.length) * rate) + (played === 0 ? pieceInput : 0) + (stretch ? stretchAhead : 0))
          reading = null
          if (run !== this.run) return
          done = data.done
          if (!stretch) {
            pending.append(data.channels)
            continue
          }
          stretch.push(data.channels)
          if (done) stretch.end()
        }
        const piece = this.piece(pending, length, sr)
        // Crossfade with the previous piece's overlap, and into the next one.
        if (played > 0) ramp(piece, 0, overlap, true)
        if (!last) ramp(piece, size, overlap, false)
        // The pieces follow the start sample by sample.
        this.schedule(out, piece, startFrame + played, played === 0, fadeIn)
        fadeIn = false
        played += size
        pending.shift(size)
        if (!done && played < total && pending.length < pieceInput) void read(pieceInput)
      }
    } finally {
      decoding.cancel()
    }
  }

  /** The first `length` pending frames (silence where the sound ended). */
  private piece(pending: Pending, length: number, sr: number): AudioBuffer {
    const channels = pending.data.length
    const buffer = new AudioBuffer({ length: Math.max(1, length), numberOfChannels: channels, sampleRate: sr })
    const available = Math.min(length, pending.length)
    for (let c = 0; c < channels; c++) buffer.copyToChannel(pending.data[c].subarray(0, available), c)
    return buffer
  }

  /** Plays `buffer` from context frame `frame`. */
  private schedule(out: GainNode, buffer: AudioBuffer, frame: number, first: boolean, fadeIn: boolean): void {
    // Late (the first piece after a jump is): skip what should already be heard,
    // starting on a frame like the gain changes (between frames, one sample came out before the fade).
    const rate = this.ctx.sampleRate
    const start = Math.max(frame, Math.ceil((this.ctx.currentTime + SAFETY) * rate))
    const offset = (start - frame) / rate
    if (offset >= buffer.duration) return
    const at = frameTime(start, rate)
    if (fadeIn || offset > 0) {
      out.gain.setValueAtTime(0, at)
      out.gain.linearRampToValueAtTime(1, at + FADE)
    } else if (first) {
      out.gain.setValueAtTime(1, at)
    }
    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    source.connect(out)
    source.onended = () => {
      this.sources.delete(source)
      source.disconnect()
    }
    this.sources.add(source)
    source.start(at, offset)
  }
}

/**
 * Context time of a frame, a hair before it. frame / rate often rounds a hair
 * after the frame, and Chromium then plays a source a fraction of a frame
 * late and, after its end, puts out a few ms of the mix one render quantum
 * old: the sound doubled at some cuts.
 */
const frameTime = (frame: number, rate: number): number => frame / rate - 1e-9

/** Linear fade over `length` frames from `at`, in (rising) or out. */
function ramp(buffer: AudioBuffer, at: number, length: number, rising: boolean): void {
  const n = Math.min(length, buffer.length - at)
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c)
    for (let i = 0; i < n; i++) {
      const w = (i + 0.5) / length
      data[at + i] *= rising ? w : 1 - w
    }
  }
}

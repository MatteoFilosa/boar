import { ALL_FORMATS, AudioSampleSink, BlobSource, Input, UrlSource, type AudioSample } from 'mediabunny'
import type { DecoderReply, DecoderRequest } from './soundStream'

// Decodes the preview's sound off the main thread (see soundStream.ts). On a
// busy main thread (slow preview frames) every step of the decoder waited for
// a frame and the sound fell behind.

interface OpenFile {
  input: Input
  sink: AudioSampleSink
  /** Timestamp of the file's start (seconds): source times count from it. */
  first: number
  sampleRate: number
  channels: number
}

interface Run {
  file: OpenFile
  samples: AsyncGenerator<AudioSample, void, unknown>
  /** Source time of the first frame (seconds, from the file's start). */
  from: number
  /** Decoded frames placed so far, at the file's rate. */
  written: number
  /** Decoded frames not resampled yet: from frame `inBase` on, `inLength` of them. */
  input: Float32Array[]
  inBase: number
  inLength: number
  /** The rate the sound is sent at (the preview's AudioContext), and the frames sent. */
  rate: number
  sent: number
  ended: boolean
  cancelled: boolean
}

type RunRequest = Extract<DecoderRequest, { run: number }>

/**
 * Seconds decoded before a start and dropped: the first frames out of a new
 * decoder are not whole (AAC overlaps each frame with the one before it), and
 * the join with the previous piece of a cut clip clicked.
 */
const PRE_ROLL = 0.2

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<DecoderRequest>) => void) | null
  postMessage(message: DecoderReply, transfer?: Transferable[]): void
}

const files = new Map<string, Promise<OpenFile | null>>()
const runs = new Map<number, Run>()
/** The requests of each run, handled in order (a read waits for its start). */
const queues = new Map<number, Promise<void>>()

async function openFile(file: File | null, url: string): Promise<OpenFile | null> {
  const input = new Input({ formats: ALL_FORMATS, source: file ? new BlobSource(file) : new UrlSource(url) })
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track) {
      input.dispose()
      return null
    }
    if (!(await track.canDecode())) throw new Error(`cannot decode ${track.codec ?? 'this'} sound`)
    return {
      input,
      sink: new AudioSampleSink(track),
      first: Math.max(0, await input.getFirstTimestamp()),
      sampleRate: track.sampleRate,
      channels: Math.min(2, Math.max(1, track.numberOfChannels))
    }
  } catch (err) {
    input.dispose()
    throw err
  }
}

async function open(key: string, file: File | null, url: string): Promise<void> {
  let opening = files.get(key)
  if (!opening) {
    opening = openFile(file, url)
    files.set(key, opening)
  }
  try {
    const opened = await opening
    scope.postMessage({ type: 'opened', key, info: opened && { channels: opened.channels } })
  } catch (err) {
    if (files.get(key) === opening) files.delete(key)
    scope.postMessage({ type: 'opened', key, info: null, error: String(err) })
  }
}

async function close(key: string): Promise<void> {
  const opening = files.get(key)
  if (!opening) return
  files.delete(key)
  const file = await opening.catch(() => null)
  if (!file) return
  for (const [id, run] of runs) if (run.file === file) end(id)
  file.input.dispose()
}

/** Adds decoded frames to the run's input. */
function append(run: Run, data: Float32Array[]): void {
  const n = data[0].length
  const size = run.inLength + n
  if (size > run.input[0].length) {
    const capacity = Math.max(size, run.input[0].length * 2)
    run.input = run.input.map((old) => {
      const grown = new Float32Array(capacity)
      grown.set(old.subarray(0, run.inLength))
      return grown
    })
  }
  for (let c = 0; c < run.input.length; c++) run.input[c].set(data[c], run.inLength)
  run.inLength = size
}

/** Places a decoded sample by its timestamp: gaps are silent, overlaps keep what is there. */
function place(run: Run, sample: AudioSample): void {
  const n = sample.numberOfFrames
  let at = Math.round((sample.timestamp - run.file.first - run.from) * run.file.sampleRate)
  // Timestamps round to a frame either way: a sample that follows the last one joins it.
  if (Math.abs(at - run.written) <= 2) at = run.written
  const skip = Math.max(0, run.written - at)
  if (skip >= n) return
  if (at > run.written) append(run, Array.from({ length: run.input.length }, () => new Float32Array(at - run.written)))
  append(
    run,
    Array.from({ length: run.input.length }, (_, c) => {
      const plane = new Float32Array(n)
      sample.copyTo(plane, { planeIndex: Math.min(c, sample.numberOfChannels - 1), format: 'f32-planar' })
      return skip ? plane.subarray(skip) : plane
    })
  )
  run.written = at + n
}

/**
 * Up to `count` frames at the run's rate from the input there is (null: none
 * yet, or none left), linearly interpolated as Web Audio plays a buffer of
 * another rate. Resampled here, every piece starts on a frame of the context
 * and the pieces of a cut clip join sample by sample (44.1 kHz pieces played
 * at 48 kHz left a frame of silence or of overlap at the cuts).
 */
function resample(run: Run, count: number): Float32Array[] | null {
  const step = run.file.sampleRate / run.rate
  const inEnd = run.inBase + run.inLength
  // Output frame j reads input frames floor(j * step) and the one after (silence past the end).
  const last = run.ended ? Math.ceil(inEnd / step) - 1 : Math.ceil((inEnd - 1) / step) - 1
  const n = Math.min(count, last - run.sent + 1)
  if (n <= 0) return null
  const out = run.input.map((input) => {
    const data = new Float32Array(n)
    for (let k = 0; k < n; k++) {
      const x = (run.sent + k) * step
      const i = Math.floor(x)
      const a = i - run.inBase
      const v0 = a < run.inLength ? input[a] : 0
      const v1 = a + 1 < run.inLength ? input[a + 1] : 0
      data[k] = v0 + (v1 - v0) * (x - i)
    }
    return data
  })
  run.sent += n
  // Drops the input no later frame reads.
  const drop = Math.min(run.inLength, Math.floor(run.sent * step) - run.inBase)
  if (drop > 0) {
    for (const input of run.input) input.copyWithin(0, drop, run.inLength)
    run.inBase += drop
    run.inLength -= drop
  }
  return out
}

/** Decodes at least `frames` more frames of a run (fewer at its end) and sends them at the run's rate. */
async function read(id: number, run: Run, frames: number): Promise<void> {
  const parts: Float32Array[][] = run.input.map(() => [])
  let count = 0
  let done = false
  while (count < frames && !run.cancelled) {
    const data = resample(run, frames - count)
    if (data) {
      for (let c = 0; c < data.length; c++) parts[c].push(data[c])
      count += data[0].length
      continue
    }
    if (run.ended) {
      done = true
      break
    }
    const next = await run.samples.next()
    if (next.done) {
      run.ended = true
      continue
    }
    try {
      place(run, next.value)
    } finally {
      next.value.close()
    }
  }
  if (run.cancelled) return
  const data = parts.map((list) => {
    const out = new Float32Array(count)
    let offset = 0
    for (const part of list) {
      out.set(part, offset)
      offset += part.length
    }
    return out
  })
  scope.postMessage({ type: 'data', run: id, channels: data, done }, data.map((d) => d.buffer))
  if (done) end(id)
}

function end(id: number): void {
  const run = runs.get(id)
  if (!run) return
  runs.delete(id)
  run.cancelled = true
  void run.samples.return(undefined)
}

async function handleRun(msg: RunRequest): Promise<void> {
  switch (msg.type) {
    case 'start': {
      const file = await files.get(msg.key)?.catch(() => null)
      if (!file) {
        scope.postMessage({ type: 'data', run: msg.run, channels: [], done: true })
        return
      }
      const samples = file.sink.samples(file.first + Math.max(0, msg.from - PRE_ROLL), file.first + msg.to)
      runs.set(msg.run, {
        file,
        samples,
        from: msg.from,
        written: 0,
        input: Array.from({ length: file.channels }, () => new Float32Array(0)),
        inBase: 0,
        inLength: 0,
        rate: msg.rate,
        sent: 0,
        ended: false,
        cancelled: false
      })
      return
    }
    case 'read': {
      const run = runs.get(msg.run)
      if (!run) {
        scope.postMessage({ type: 'data', run: msg.run, channels: [], done: true })
        return
      }
      try {
        await read(msg.run, run, msg.frames)
      } catch (err) {
        end(msg.run)
        scope.postMessage({ type: 'failed', run: msg.run, error: String(err) })
      }
      return
    }
    case 'cancel':
      end(msg.run)
      queues.delete(msg.run)
  }
}

scope.onmessage = (event) => {
  const msg = event.data
  if (msg.type === 'open') {
    void open(msg.key, msg.file, msg.url)
    return
  }
  if (msg.type === 'close') {
    void close(msg.key)
    return
  }
  // A cancel acts at once, even while a read of the same run is decoding.
  if (msg.type === 'cancel') {
    const run = runs.get(msg.run)
    if (run) run.cancelled = true
  }
  const queued = (queues.get(msg.run) ?? Promise.resolve())
    .then(() => handleRun(msg))
    .catch((err: unknown) => console.error('[sound decoder]', err))
  if (msg.type !== 'cancel') queues.set(msg.run, queued)
}

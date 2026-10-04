import { ALL_FORMATS, AudioBufferSink, Input } from 'mediabunny'
import type { Transcript } from '../core/captions'
import type { MediaItem } from '../core/types'
import { inputSource } from '../media/source'
import { type CaptionProgress, bridge } from '../platform'

// Transcription with the speech engine bundled with the app (whisper.cpp):
// the sound of a media range is decoded here (WebCodecs), mixed to mono,
// resampled to 16 kHz and streamed to the main process, which runs the
// engine on it. No other program is needed.

const RATE = 16000
/** Seconds of sound resampled and sent at a time. */
const BLOCK = 30

// Resampling: windowed-sinc low-pass at 0.95 x 8 kHz (no aliasing from the
// higher rates), with a table of fractional phases.

const PHASES = 256

interface Kernel {
  ratio: number
  half: number
  width: number
  table: Float32Array
}

function makeKernel(sourceRate: number): Kernel {
  const ratio = sourceRate / RATE
  const scale = Math.max(1, ratio)
  const half = Math.ceil(8 * scale)
  const width = 2 * half + 1
  const cutoff = (0.5 / scale) * 0.95
  const table = new Float32Array(PHASES * width)
  for (let p = 0; p < PHASES; p++) {
    const frac = p / PHASES
    let sum = 0
    for (let t = 0; t < width; t++) {
      const x = t - half - frac
      const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x)
      const hann = 0.5 * (1 + Math.cos((Math.PI * x) / (half + 1)))
      table[p * width + t] = sinc * hann
      sum += sinc * hann
    }
    for (let t = 0; t < width; t++) table[p * width + t] /= sum
  }
  return { ratio, half, width, table }
}

function resample(input: Float32Array, k: Kernel, length: number): Float32Array {
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    const pos = i * k.ratio
    let base = Math.floor(pos)
    let phase = Math.round((pos - base) * PHASES)
    if (phase === PHASES) {
      base++
      phase = 0
    }
    const row = phase * k.width
    const start = base - k.half
    let acc = 0
    if (start >= 0 && start + k.width <= input.length) {
      for (let t = 0; t < k.width; t++) acc += input[start + t] * k.table[row + t]
    } else {
      for (let t = 0; t < k.width; t++) {
        const j = start + t
        if (j >= 0 && j < input.length) acc += input[j] * k.table[row + t]
      }
    }
    out[i] = acc
  }
  return out
}

/**
 * Transcribes [from, from + duration) seconds of a media file. Times in the
 * result are seconds from `from`.
 */
export async function transcribeMedia(
  media: MediaItem,
  from: number,
  duration: number,
  model: string,
  language: string,
  onProgress?: (progress: CaptionProgress) => void
): Promise<Transcript> {
  if (!bridge) throw new Error('Transcription runs in the desktop app')
  const total = Math.max(1, Math.round(duration * RATE))
  const id = await bridge.startTranscription({ model, language, samples: total })
  let sent = 0
  try {
    const input = new Input({ formats: ALL_FORMATS, source: inputSource(media) })
    try {
      const track = await input.getPrimaryAudioTrack()
      if (!track) throw new Error('This media has no sound')
      const first = Math.max(0, await input.getFirstTimestamp())
      const sourceRate = track.sampleRate
      const kernel = makeKernel(sourceRate)
      const blockSource = BLOCK * sourceRate
      const blocks = Math.ceil(total / (RATE * BLOCK))
      // Mono sound at the source rate, one array per block until it is sent.
      const pending = new Map<number, Float32Array>()
      let next = 0
      /** Resamples and sends, in order, the blocks before `upTo` (silent ones too), as 16-bit samples. */
      const flush = async (upTo: number): Promise<void> => {
        for (; next < upTo; next++) {
          const mono = pending.get(next) ?? new Float32Array(blockSource)
          pending.delete(next)
          const length = Math.min(RATE * BLOCK, total - next * RATE * BLOCK)
          const out = resample(mono, kernel, length)
          const pcm = new Int16Array(length)
          for (let i = 0; i < length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(out[i] * 32767)))
          await bridge!.sendTranscriptionAudio(id, new Uint8Array(pcm.buffer))
          sent += length
          onProgress?.({ phase: 'prepare', progress: sent / total })
        }
      }
      for await (const { buffer, timestamp } of new AudioBufferSink(track).buffers(first + from, first + from + duration)) {
        const p0 = Math.round((timestamp - first - from) * sourceRate)
        await flush(Math.min(blocks, Math.max(0, Math.floor(p0 / blockSource))))
        const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c))
        const gain = 1 / channels.length
        for (let i = Math.max(0, -p0); i < buffer.length; ) {
          const at = p0 + i
          const b = Math.floor(at / blockSource)
          const local = at - b * blockSource
          const count = Math.min(buffer.length - i, blockSource - local)
          if (b >= blocks) break
          if (b >= next) {
            let mono = pending.get(b)
            if (!mono) pending.set(b, (mono = new Float32Array(blockSource)))
            for (let j = 0; j < count; j++) {
              let v = 0
              for (const data of channels) v += data[i + j]
              mono[local + j] = v * gain
            }
          }
          i += count
        }
      }
      await flush(blocks)
    } finally {
      input.dispose()
    }
    if (sent < total) await bridge.sendTranscriptionAudio(id, new Uint8Array((total - sent) * 2))
    onProgress?.({ phase: 'transcribe', progress: 0 })
    return await bridge.finishTranscription(id)
  } catch (err) {
    void bridge.cancelTranscription(id)
    throw err
  }
}

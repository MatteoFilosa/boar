import { ALL_FORMATS, AudioBufferSink, Input } from 'mediabunny'
import type { MediaItem } from '../core/types'
import { inputSource } from '../media/source'

// Loudness analysis for the automatic tools (silence removal, ducking): the
// sound of a media file as an RMS level every 10 ms, decoded once per file.

/** Seconds per level value. */
export const HOP = 0.01
const SILENT_DB = -120

export interface Interval {
  start: number
  end: number
}

const cache = new Map<string, Promise<Float32Array>>()

/** RMS level (dBFS, channels mixed) every 10 ms over the whole file. */
export function mediaLevels(media: MediaItem): Promise<Float32Array> {
  let pending = cache.get(media.id)
  if (!pending) {
    pending = decodeLevels(media)
    pending.catch(() => cache.delete(media.id))
    cache.set(media.id, pending)
  }
  return pending
}

async function decodeLevels(media: MediaItem): Promise<Float32Array> {
  const input = new Input({ formats: ALL_FORMATS, source: inputSource(media) })
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track) return new Float32Array(0)
    const first = Math.max(0, await input.getFirstTimestamp())
    const duration = Math.max(0, (await input.computeDuration()) - first)
    const n = Math.max(1, Math.ceil(duration / HOP))
    const sums = new Float64Array(n)
    const counts = new Uint32Array(n)
    for await (const { buffer, timestamp } of new AudioBufferSink(track).buffers()) {
      const rate = buffer.sampleRate
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c))
      const t0 = timestamp - first
      for (let i = 0; i < buffer.length; i++) {
        const index = Math.floor((t0 + i / rate) / HOP)
        if (index < 0 || index >= n) continue
        let v = 0
        for (const data of channels) v += data[i]
        v /= channels.length
        sums[index] += v * v
        counts[index]++
      }
    }
    const db = new Float32Array(n)
    for (let i = 0; i < n; i++) db[i] = counts[i] ? Math.max(SILENT_DB, 10 * Math.log10(sums[i] / counts[i] + 1e-12)) : SILENT_DB
    return db
  } finally {
    input.dispose()
  }
}

/** Levels of [from, from + duration) seconds of the file. */
export function sliceLevels(levels: Float32Array, from: number, duration: number): Float32Array {
  const a = Math.max(0, Math.round(from / HOP))
  const b = Math.min(levels.length, a + Math.round(duration / HOP))
  return levels.subarray(a, Math.max(a, b))
}

/**
 * Levels of an event in timeline time (one value per HOP of the timeline):
 * the source range it plays, resampled by its playback rate.
 */
export function eventLevels(levels: Float32Array, offset: number, length: number, rate: number): Float32Array {
  if (Math.abs(rate - 1) < 1e-4) return sliceLevels(levels, offset, length)
  const n = Math.max(0, Math.round(length / HOP))
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const a = Math.floor((offset + i * HOP * rate) / HOP)
    const b = Math.max(a + 1, Math.floor((offset + (i + 1) * HOP * rate) / HOP))
    // Loudest source value inside the stretched step, so short sounds survive a speed-up.
    let v = -Infinity
    for (let k = a; k < b && k < levels.length; k++) if (levels[k] > v) v = levels[k]
    out[i] = v === -Infinity ? SILENT_DB : v
  }
  return out
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return SILENT_DB
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))]
}

/** A threshold between the room noise and the voice: 30 % of the way from the quiet to the loud level. */
export function autoThreshold(levels: Float32Array): number {
  const sorted = Array.from(levels)
    .filter((v) => v > -100)
    .sort((a, b) => a - b)
  if (sorted.length === 0) return -45
  const floor = percentile(sorted, 0.1)
  const loud = percentile(sorted, 0.95)
  return Math.round(Math.max(-70, Math.min(-12, floor + (loud - floor) * 0.3)))
}

/**
 * Quiet stretches of at least `minSilence` seconds, shrunk by `padding` on the
 * sides that touch sound (so breaths and word endings are kept). Seconds from
 * the start of `levels`.
 */
export function findSilences(levels: Float32Array, threshold: number, minSilence: number, padding: number): Interval[] {
  const out: Interval[] = []
  const total = levels.length * HOP
  let runStart = -1
  const close = (endIndex: number): void => {
    if (runStart < 0) return
    const start = runStart * HOP
    const end = endIndex * HOP
    runStart = -1
    if (end - start < minSilence) return
    const a = start <= 0 ? 0 : start + padding
    const b = end >= total ? total : end - padding
    if (b - a > 0.02) out.push({ start: a, end: b })
  }
  for (let i = 0; i < levels.length; i++) {
    if (levels[i] < threshold) {
      if (runStart < 0) runStart = i
    } else {
      close(i)
    }
  }
  close(levels.length)
  return out
}

/** The sound between the silences: where someone is talking. */
export function soundIntervals(levels: Float32Array, threshold: number, minSilence: number): Interval[] {
  const total = levels.length * HOP
  const out: Interval[] = []
  let at = 0
  for (const s of findSilences(levels, threshold, minSilence, 0)) {
    if (s.start > at) out.push({ start: at, end: s.start })
    at = s.end
  }
  if (total > at) out.push({ start: at, end: total })
  return out
}

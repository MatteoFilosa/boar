// Pitch-preserving time stretch (WSOLA). 40 ms Hann frames overlap by half; each
// is read near its nominal position at the offset that best continues the
// previous one, searched on a decimated mono mix and refined at full rate.

const FRAME_SECONDS = 0.04
const TOLERANCE_SECONDS = 0.012
const DECIMATION = 4

function monoMix(buffer: AudioBuffer): Float32Array {
  const out = new Float32Array(buffer.length)
  const channels = buffer.numberOfChannels
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c)
    for (let i = 0; i < out.length; i++) out[i] += data[i] / channels
  }
  return out
}

function decimate(data: Float32Array, factor: number): Float32Array {
  const out = new Float32Array(Math.ceil(data.length / factor))
  for (let i = 0; i < out.length; i++) {
    let sum = 0
    const end = Math.min(data.length, (i + 1) * factor)
    for (let k = i * factor; k < end; k++) sum += data[k]
    out[i] = sum / factor
  }
  return out
}

/** Normalized cross-correlation of data[a..a+n) and data[b..b+n) (zero outside the array). */
function similarity(data: Float32Array, a: number, b: number, n: number): number {
  let dot = 0
  let energy = 0
  for (let i = 0; i < n; i++) {
    const ia = a + i
    const ib = b + i
    const va = ia >= 0 && ia < data.length ? data[ia] : 0
    const vb = ib >= 0 && ib < data.length ? data[ib] : 0
    dot += va * vb
    energy += vb * vb
  }
  return energy > 1e-12 ? dot / Math.sqrt(energy) : 0
}

/**
 * Plays `input` `rate` times as fast without changing the pitch, filling
 * `outLength` samples. rate = 1 only pads or trims.
 */
export function timeStretch(input: AudioBuffer, rate: number, outLength: number): AudioBuffer {
  const sampleRate = input.sampleRate
  const channels = input.numberOfChannels
  const out = new AudioBuffer({ length: Math.max(1, outLength), numberOfChannels: channels, sampleRate })
  if (Math.abs(rate - 1) < 1e-4) {
    for (let c = 0; c < channels; c++) out.getChannelData(c).set(input.getChannelData(c).subarray(0, out.length))
    return out
  }
  const frame = 2 * Math.round((sampleRate * FRAME_SECONDS) / 2)
  const hop = frame / 2
  const tolerance = Math.round(sampleRate * TOLERANCE_SECONDS)
  const window = new Float32Array(frame)
  for (let n = 0; n < frame; n++) window[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / frame)

  const mono = monoMix(input)
  const coarse = decimate(mono, DECIMATION)
  const sources = Array.from({ length: channels }, (_, c) => input.getChannelData(c))
  const targets = Array.from({ length: channels }, (_, c) => out.getChannelData(c))
  const norm = new Float32Array(out.length)

  let previous = 0
  for (let k = 0; k * hop < out.length; k++) {
    const nominal = Math.round(k * hop * rate)
    let position = nominal
    if (k > 0) {
      // The input that naturally follows the previous frame; find the read
      // position near `nominal` that looks most like it.
      const natural = previous + hop
      const n = Math.max(1, Math.floor(hop / DECIMATION))
      const lo = Math.max(0, nominal - tolerance)
      const hi = nominal + tolerance
      let best = -Infinity
      for (let p = Math.floor(lo / DECIMATION); p <= Math.ceil(hi / DECIMATION); p++) {
        const score = similarity(coarse, Math.floor(natural / DECIMATION), p, n)
        if (score > best) {
          best = score
          position = p * DECIMATION
        }
      }
      let fine = position
      best = -Infinity
      for (let p = Math.max(0, position - DECIMATION); p <= position + DECIMATION; p++) {
        const score = similarity(mono, natural, p, hop)
        if (score > best) {
          best = score
          fine = p
        }
      }
      position = fine
    }
    const at = k * hop
    for (let n = 0; n < frame && at + n < out.length; n++) {
      const w = window[n]
      norm[at + n] += w
      const i = position + n
      if (i >= input.length) continue
      for (let c = 0; c < channels; c++) targets[c][at + n] += w * sources[c][i]
    }
    previous = position
  }
  // The first half frame only has a rising window: normalize by the window sum.
  for (let i = 0; i < out.length; i++) {
    const w = norm[i]
    if (w > 1e-3 && Math.abs(w - 1) > 1e-6) for (let c = 0; c < channels; c++) targets[c][i] /= w
  }
  return out
}

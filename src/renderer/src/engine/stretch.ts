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

/**
 * timeStretch fed and read piece by piece (the preview's sound): the same
 * frames as one call over the whole input, so the pieces join seamlessly
 * (stretched one by one, each started anew and the joins clicked).
 */
export class StretchStream {
  private readonly frame: number
  private readonly hop: number
  private readonly tolerance: number
  private readonly window: Float32Array
  private readonly channels: number
  /** Input from absolute frame `base` on (a multiple of DECIMATION): the channels, their mono mix and its decimation. */
  private base = 0
  private held = 0
  private data: Float32Array[]
  private mono: Float32Array
  private coarse: Float32Array
  private coarseHeld = 0
  private ended = false
  /** The next frame to place, and where the last one was read. */
  private k = 0
  private previous = 0
  /** Overlap-add of the output from absolute frame `outBase` on. */
  private outBase = 0
  private readonly acc: Float32Array[]
  private readonly norm: Float32Array
  private flushed = false

  constructor(
    private readonly rate: number,
    sampleRate: number,
    channels: number
  ) {
    this.frame = 2 * Math.round((sampleRate * FRAME_SECONDS) / 2)
    this.hop = this.frame / 2
    this.tolerance = Math.round(sampleRate * TOLERANCE_SECONDS)
    this.window = new Float32Array(this.frame)
    for (let n = 0; n < this.frame; n++) this.window[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / this.frame)
    this.channels = channels
    this.data = Array.from({ length: channels }, () => new Float32Array(0))
    this.mono = new Float32Array(0)
    this.coarse = new Float32Array(0)
    this.acc = Array.from({ length: channels }, () => new Float32Array(2 * this.frame))
    this.norm = new Float32Array(2 * this.frame)
  }

  push(input: Float32Array[]): void {
    const n = input[0]?.length ?? 0
    if (n === 0) return
    this.reserve(this.held + n)
    const at = this.held
    for (let c = 0; c < this.channels; c++) this.data[c].set(input[Math.min(c, input.length - 1)], at)
    // As monoMix: channel by channel, kept in 32 bits.
    for (let c = 0; c < this.channels; c++) {
      const data = this.data[c]
      for (let i = at; i < at + n; i++) this.mono[i] += data[i] / this.channels
    }
    this.held += n
    this.decimate(false)
  }

  end(): void {
    this.ended = true
    this.decimate(true)
  }

  /** The output finished so far. */
  pull(): Float32Array[] {
    const parts: Float32Array[][] = Array.from({ length: this.channels }, () => [])
    while (this.place()) this.emit(this.k * this.hop, parts)
    if (this.ended && !this.flushed) {
      // No more frames: the tail of the last one is finished too.
      this.flushed = true
      this.emit(this.k * this.hop + this.hop, parts)
    }
    return parts.map((list) => {
      const out = new Float32Array(list.reduce((sum, part) => sum + part.length, 0))
      let offset = 0
      for (const part of list) {
        out.set(part, offset)
        offset += part.length
      }
      return out
    })
  }

  /** Places the next frame when its input is there; false when it is not (or the input ran out). */
  private place(): boolean {
    const { hop, frame, tolerance, k } = this
    const inputEnd = this.base + this.held
    const nominal = Math.round(k * hop * this.rate)
    const natural = this.previous + hop
    if (this.ended) {
      if (this.flushed || nominal - tolerance >= inputEnd) return false
    } else if (Math.max(natural, nominal + tolerance) + frame + 2 * DECIMATION > inputEnd) {
      return false
    }
    let position = nominal
    if (k > 0) {
      const n = Math.max(1, Math.floor(hop / DECIMATION))
      const lo = Math.max(0, nominal - tolerance)
      const hi = nominal + tolerance
      let best = -Infinity
      for (let p = Math.floor(lo / DECIMATION); p <= Math.ceil(hi / DECIMATION); p++) {
        const score = this.similarity(this.coarse, this.base / DECIMATION, this.coarseHeld, Math.floor(natural / DECIMATION), p, n)
        if (score > best) {
          best = score
          position = p * DECIMATION
        }
      }
      let fine = position
      best = -Infinity
      for (let p = Math.max(0, position - DECIMATION); p <= position + DECIMATION; p++) {
        const score = this.similarity(this.mono, this.base, this.held, natural, p, hop)
        if (score > best) {
          best = score
          fine = p
        }
      }
      position = fine
    }
    const at = k * hop - this.outBase
    for (let n = 0; n < frame; n++) {
      const w = this.window[n]
      this.norm[at + n] += w
      const i = position + n - this.base
      if (i >= this.held) continue
      for (let c = 0; c < this.channels; c++) this.acc[c][at + n] += w * this.data[c][i]
    }
    this.previous = position
    this.k++
    this.trim()
    return true
  }

  /** Moves the output before absolute frame `until` to `parts`, normalized as timeStretch does. */
  private emit(until: number, parts: Float32Array[][]): void {
    const n = until - this.outBase
    if (n <= 0) return
    for (let c = 0; c < this.channels; c++) {
      const acc = this.acc[c]
      const out = acc.slice(0, n)
      for (let i = 0; i < n; i++) {
        const w = this.norm[i]
        if (w > 1e-3 && Math.abs(w - 1) > 1e-6) out[i] /= w
      }
      parts[c].push(out)
      acc.copyWithin(0, n)
      acc.fill(0, acc.length - n)
    }
    this.norm.copyWithin(0, n)
    this.norm.fill(0, this.norm.length - n)
    this.outBase = until
  }

  /** Normalized cross-correlation as in timeStretch, on absolute indices (zero outside the input). */
  private similarity(data: Float32Array, base: number, held: number, a: number, b: number, n: number): number {
    let dot = 0
    let energy = 0
    for (let i = 0; i < n; i++) {
      const ia = a + i - base
      const ib = b + i - base
      const va = ia >= 0 && ia < held ? data[ia] : 0
      const vb = ib >= 0 && ib < held ? data[ib] : 0
      dot += va * vb
      energy += vb * vb
    }
    return energy > 1e-12 ? dot / Math.sqrt(energy) : 0
  }

  /** Decimates the mono mix by whole blocks (the last partial one at the end), as decimate() does. */
  private decimate(final: boolean): void {
    const blocks = final ? Math.ceil(this.held / DECIMATION) : Math.floor(this.held / DECIMATION)
    for (let j = this.coarseHeld; j < blocks; j++) {
      let sum = 0
      const end = Math.min(this.held, (j + 1) * DECIMATION)
      for (let i = j * DECIMATION; i < end; i++) sum += this.mono[i]
      this.coarse[j] = sum / DECIMATION
    }
    this.coarseHeld = Math.max(this.coarseHeld, blocks)
  }

  private reserve(size: number): void {
    if (size <= this.mono.length) return
    const capacity = Math.max(size, this.mono.length * 2)
    const grow = (old: Float32Array, length: number): Float32Array => {
      const grown = new Float32Array(length)
      grown.set(old)
      return grown
    }
    this.data = this.data.map((old) => grow(old, capacity))
    this.mono = grow(this.mono, capacity)
    this.coarse = grow(this.coarse, Math.ceil(capacity / DECIMATION))
  }

  /** Drops the input no later frame reads (half a second or more at a time). */
  private trim(): void {
    const nominal = Math.round(this.k * this.hop * this.rate)
    const needed = Math.min(this.previous, nominal - this.tolerance) - 4 * DECIMATION
    const drop = Math.floor((needed - this.base) / DECIMATION) * DECIMATION
    if (drop < this.frame * 12) return
    for (const channel of this.data) channel.copyWithin(0, drop, this.held)
    this.mono.copyWithin(0, drop, this.held)
    this.mono.fill(0, this.held - drop)
    this.coarse.copyWithin(0, drop / DECIMATION, this.coarseHeld)
    this.base += drop
    this.held -= drop
    this.coarseHeld -= drop / DECIMATION
  }
}

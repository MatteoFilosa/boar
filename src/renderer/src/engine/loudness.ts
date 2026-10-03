// Loudness per ITU-R BS.1770-4: K-weighted gated integrated loudness, 4x
// oversampled true peak, normalization to a target and a look-ahead limiter.

export interface LoudnessResult {
  /** Integrated loudness before and after, in LUFS (-Infinity for silence). */
  before: number
  after: number
  /** True peak after processing, in dBTP. */
  peak: number
  /** Gain applied before the limiter, in dB. */
  gainDb: number
}

export const LOUDNESS_TARGETS: { lufs: number; label: string }[] = [
  { lufs: -14, label: '−14 LUFS · YouTube, Instagram, TikTok' },
  { lufs: -16, label: '−16 LUFS · podcasts, Apple' },
  { lufs: -23, label: '−23 LUFS · broadcast (EBU R128)' }
]

/** Quiet recordings are not boosted by more than this (it would only raise the noise). */
const MAX_GAIN_DB = 20

const dbToLinear = (db: number): number => Math.pow(10, db / 20)
const linearToDb = (v: number): number => (v > 0 ? 20 * Math.log10(v) : -Infinity)

/** Sum over channels of the K-weighted squared signal, per 100 ms segment. */
function segmentEnergies(channels: Float32Array[], sampleRate: number): { sums: Float64Array; hop: number } {
  // Stage 1: high shelf (head acoustics); stage 2: high pass (RLB). Coefficients
  // derived for any sample rate, as in libebur128.
  let f0 = 1681.974450955533
  const G = 3.999843853973347
  let Q = 0.7071752369554196
  let K = Math.tan((Math.PI * f0) / sampleRate)
  const Vh = Math.pow(10, G / 20)
  const Vb = Math.pow(Vh, 0.4996667741545416)
  const a0 = 1 + K / Q + K * K
  const pb0 = (Vh + (Vb * K) / Q + K * K) / a0
  const pb1 = (2 * (K * K - Vh)) / a0
  const pb2 = (Vh - (Vb * K) / Q + K * K) / a0
  const pa1 = (2 * (K * K - 1)) / a0
  const pa2 = (1 - K / Q + K * K) / a0
  f0 = 38.13547087602444
  Q = 0.5003270373238773
  K = Math.tan((Math.PI * f0) / sampleRate)
  const ra1 = (2 * (K * K - 1)) / (1 + K / Q + K * K)
  const ra2 = (1 - K / Q + K * K) / (1 + K / Q + K * K)

  const hop = Math.max(1, Math.round(sampleRate * 0.1))
  const length = channels[0]?.length ?? 0
  const segments = Math.floor(length / hop)
  const sums = new Float64Array(segments)
  for (const data of channels) {
    let x1 = 0
    let x2 = 0
    let y1 = 0
    let y2 = 0
    let v1 = 0
    let v2 = 0
    let w1 = 0
    let w2 = 0
    for (let s = 0; s < segments; s++) {
      let sum = 0
      const end = (s + 1) * hop
      for (let n = s * hop; n < end; n++) {
        const x = data[n]
        const y = pb0 * x + pb1 * x1 + pb2 * x2 - pa1 * y1 - pa2 * y2
        x2 = x1
        x1 = x
        y2 = y1
        y1 = y
        const z = y - 2 * v1 + v2 - ra1 * w1 - ra2 * w2
        v2 = v1
        v1 = y
        w2 = w1
        w1 = z
        sum += z * z
      }
      sums[s] += sum
    }
  }
  return { sums, hop }
}

const blockLoudness = (meanSquare: number): number => -0.691 + 10 * Math.log10(meanSquare)

/** Gated integrated loudness in LUFS (400 ms blocks, 75 % overlap, -70 LUFS and -10 LU gates). */
export function integratedLoudness(channels: Float32Array[], sampleRate: number): number {
  const { sums, hop } = segmentEnergies(channels, sampleRate)
  const blocks: number[] = []
  for (let j = 0; j + 3 < sums.length; j++) blocks.push((sums[j] + sums[j + 1] + sums[j + 2] + sums[j + 3]) / (4 * hop))
  if (blocks.length === 0) {
    // Shorter than one block: the plain K-weighted mean square.
    let total = 0
    for (const s of sums) total += s
    return sums.length > 0 && total > 0 ? blockLoudness(total / (sums.length * hop)) : -Infinity
  }
  const loud = blocks.filter((ms) => ms > 0 && blockLoudness(ms) > -70)
  if (loud.length === 0) return -Infinity
  const mean = (list: number[]): number => list.reduce((a, b) => a + b, 0) / list.length
  const relativeGate = blockLoudness(mean(loud)) - 10
  const gated = loud.filter((ms) => blockLoudness(ms) > relativeGate)
  return blockLoudness(mean(gated.length > 0 ? gated : loud))
}

// 4x oversampling for the true peak: windowed-sinc interpolation at 1/4, 1/2
// and 3/4 of each sample interval, 12 taps per phase (x[n-5] .. x[n+6]).
const TAPS = 12
const KERNELS = [0.25, 0.5, 0.75].map((frac) => {
  const h = new Float64Array(TAPS)
  let sum = 0
  for (let i = 0; i < TAPS; i++) {
    const t = 5 + frac - i
    const sinc = Math.sin(Math.PI * t) / (Math.PI * t)
    const window = 0.5 + 0.5 * Math.cos((Math.PI * t) / 6)
    h[i] = sinc * window
    sum += h[i]
  }
  for (let i = 0; i < TAPS; i++) h[i] /= sum
  return h
})

/** Largest absolute value between sample n and n + 1, inter-sample peaks included. */
function intervalPeak(data: Float32Array, n: number): number {
  let peak = Math.abs(data[n])
  if (n + 6 >= data.length || n < 5) return Math.max(peak, n + 1 < data.length ? Math.abs(data[n + 1]) : 0)
  for (const h of KERNELS) {
    let v = 0
    for (let i = 0; i < TAPS; i++) v += data[n - 5 + i] * h[i]
    const a = Math.abs(v)
    if (a > peak) peak = a
  }
  return peak
}

/** True peak (linear) of the channels. Interpolates only near loud samples, where overs can happen. */
export function truePeak(channels: Float32Array[]): number {
  let samplePeak = 0
  for (const data of channels) for (let n = 0; n < data.length; n++) samplePeak = Math.max(samplePeak, Math.abs(data[n]))
  if (samplePeak === 0) return 0
  const near = samplePeak / 2
  let peak = samplePeak
  for (const data of channels) {
    for (let n = 0; n + 1 < data.length; n++) {
      if (Math.abs(data[n]) < near && Math.abs(data[n + 1]) < near) continue
      peak = Math.max(peak, intervalPeak(data, n))
    }
  }
  return peak
}

/**
 * Look-ahead peak limiter (linked channels): the gain is computed per block of
 * 32 samples, reaches the needed reduction 5 ms before each peak and recovers
 * with an 80 ms release, so loud transients are tamed without clicks.
 */
function limit(channels: Float32Array[], sampleRate: number, ceiling: number): void {
  const length = channels[0]?.length ?? 0
  const BLOCK = 32
  const blocks = Math.ceil(length / BLOCK)
  const need = new Float32Array(blocks).fill(1)
  let any = false
  const near = ceiling / 2
  for (const data of channels) {
    for (let n = 0; n < length; n++) {
      if (Math.abs(data[n]) < near && (n + 1 >= length || Math.abs(data[n + 1]) < near)) continue
      const p = intervalPeak(data, n)
      if (p > ceiling) {
        const b = (n / BLOCK) | 0
        need[b] = Math.min(need[b], ceiling / p)
        any = true
      }
    }
  }
  if (!any) return
  const look = Math.max(1, Math.round((sampleRate * 0.005) / BLOCK))
  // Minimum over [b - 1, b + look]: the ramp starts early enough and the block
  // after a peak never interpolates above the needed gain.
  const minimum = new Float32Array(blocks)
  for (let b = 0; b < blocks; b++) {
    let m = 1
    for (let k = Math.max(0, b - 1); k <= Math.min(blocks - 1, b + look); k++) m = Math.min(m, need[k])
    minimum[b] = m
  }
  const gain = new Float32Array(blocks + 1)
  const release = 1 - Math.exp(-BLOCK / (sampleRate * 0.08))
  let previous = 1
  for (let b = 0; b < blocks; b++) {
    let sum = 0
    let count = 0
    for (let k = Math.max(0, b - look); k <= b; k++) {
      sum += minimum[k]
      count++
    }
    const target = sum / count
    previous = target < previous ? target : previous + (target - previous) * release
    gain[b] = previous
  }
  gain[blocks] = gain[blocks - 1]
  for (const data of channels) {
    for (let n = 0; n < length; n++) {
      const b = (n / BLOCK) | 0
      const g0 = gain[b]
      if (g0 === 1 && gain[b + 1] === 1) continue
      const f = (n - b * BLOCK) / BLOCK
      data[n] *= g0 + (gain[b + 1] - g0) * f
    }
  }
}

function scale(channels: Float32Array[], factor: number): void {
  if (factor === 1) return
  for (const data of channels) for (let n = 0; n < data.length; n++) data[n] *= factor
}

/**
 * Brings the buffer (in place) to `targetLufs` integrated loudness with true
 * peaks at or below `ceilingDb` dBTP.
 */
export function normalizeLoudness(buffer: AudioBuffer, targetLufs: number, ceilingDb = -1): LoudnessResult {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c))
  const before = integratedLoudness(channels, buffer.sampleRate)
  if (!Number.isFinite(before)) return { before, after: before, peak: linearToDb(truePeak(channels)), gainDb: 0 }
  let gainDb = Math.min(MAX_GAIN_DB, targetLufs - before)
  scale(channels, dbToLinear(gainDb))
  const ceiling = dbToLinear(ceilingDb)
  limit(channels, buffer.sampleRate, ceiling)
  // Heavy limiting takes some loudness away with the peaks: make it up (twice at most).
  for (let pass = 0; pass < 2; pass++) {
    const deficit = targetLufs - integratedLoudness(channels, buffer.sampleRate)
    if (deficit < 0.3 || gainDb + deficit > MAX_GAIN_DB) break
    scale(channels, dbToLinear(deficit))
    gainDb += deficit
    limit(channels, buffer.sampleRate, ceiling)
  }
  // Interpolation can leave a tiny over: trim it.
  let peak = truePeak(channels)
  if (peak > ceiling) {
    scale(channels, ceiling / peak)
    peak = ceiling
  }
  return { before, after: integratedLoudness(channels, buffer.sampleRate), peak: linearToDb(peak), gainDb }
}

export const formatLufs = (v: number): string => (Number.isFinite(v) ? `${v.toFixed(1)} LUFS` : 'silence')

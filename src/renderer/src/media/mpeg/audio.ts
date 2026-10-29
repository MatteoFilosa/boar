// Sound of program streams: AC-3 (camcorders, DVDs), MPEG audio (older
// cameras, video CDs) and DVD LPCM, cut into frames for the decoders.

export interface AudioFrames {
  /** mp2: MPEG audio layer I or II, which Chromium cannot decode. */
  codec: 'ac3' | 'mp3' | 'mp2'
  sampleRate: number
  channels: number
  /** Samples per frame (per channel). */
  samplesPerFrame: number
  frames: Uint8Array[]
}

const AC3_BITRATES = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512, 576, 640]
const AC3_RATES = [48000, 44100, 32000]
/** Full-bandwidth channels by audio coding mode. */
const AC3_CHANNELS = [2, 1, 2, 3, 3, 4, 4, 5]

/** Size in bytes of the AC-3 sync frame starting at `i` (0 when it is not one). */
export function ac3FrameSize(d: Uint8Array, i: number): number {
  if (d[i] !== 0x0b || d[i + 1] !== 0x77) return 0
  const rate = d[i + 4] >> 6
  const code = d[i + 4] & 0x3f
  if (rate > 2 || code > 37) return 0
  const kbps = AC3_BITRATES[code >> 1]
  const words = rate === 0 ? 2 * kbps : rate === 1 ? Math.floor((320 * kbps) / 147) + (code & 1) : 3 * kbps
  return words * 2
}

/** Splits an AC-3 elementary stream into sync frames (skipping damaged bytes). */
export function splitAc3(stream: Uint8Array): AudioFrames | null {
  const frames: Uint8Array[] = []
  let sampleRate = 0
  let channels = 0
  let i = 0
  while (i + 7 <= stream.length) {
    const size = ac3FrameSize(stream, i)
    // A frame counts when the next one starts right after it (or the stream ends).
    const next = i + size
    if (!size || next > stream.length || (next + 5 <= stream.length && !ac3FrameSize(stream, next))) {
      i++
      continue
    }
    if (!sampleRate) {
      sampleRate = AC3_RATES[stream[i + 4] >> 6]
      // bsid (5 bits) and bsmod (3), then acmod (3), optional mix levels, lfeon.
      const mode = stream[i + 6] >> 5
      let bit = 3
      if (mode & 1 && mode !== 1) bit += 2
      if (mode & 4) bit += 2
      if (mode === 2) bit += 2
      const lfe = ((((stream[i + 6] << 8) | stream[i + 7]) << bit) >> 15) & 1
      channels = AC3_CHANNELS[mode] + lfe
    }
    frames.push(stream.subarray(i, i + size))
    i += size
  }
  if (!frames.length) return null
  return { codec: 'ac3', sampleRate, channels, samplesPerFrame: 1536, frames }
}

const MPEG_BITRATES = [
  // MPEG-1 layer I, II, III; MPEG-2 (low sample rates) layer I, II/III.
  [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
]
const MPEG_RATES = [44100, 48000, 32000]

interface MpegHeader {
  layer: number
  size: number
  sampleRate: number
  channels: number
  samples: number
}

export function mpegAudioHeader(d: Uint8Array, i: number): MpegHeader | null {
  if (d[i] !== 0xff || (d[i + 1] & 0xe0) !== 0xe0) return null
  const version = (d[i + 1] >> 3) & 3 // 3 MPEG-1, 2 MPEG-2, 0 MPEG-2.5
  const layer = 4 - ((d[i + 1] >> 1) & 3) // 1, 2, 3
  const rateIndex = (d[i + 2] >> 2) & 3
  const bitrateIndex = d[i + 2] >> 4
  if (version === 1 || layer === 4 || rateIndex === 3 || bitrateIndex === 0 || bitrateIndex === 15) return null
  const mpeg1 = version === 3
  const table = mpeg1 ? layer - 1 : layer === 1 ? 3 : 4
  const bitrate = MPEG_BITRATES[table][bitrateIndex] * 1000
  const sampleRate = MPEG_RATES[rateIndex] / (mpeg1 ? 1 : version === 2 ? 2 : 4)
  const padding = (d[i + 2] >> 1) & 1
  const channels = d[i + 3] >> 6 === 3 ? 1 : 2
  if (layer === 1) return { layer, size: (Math.floor((12 * bitrate) / sampleRate) + padding) * 4, sampleRate, channels, samples: 384 }
  const samples = layer === 3 && !mpeg1 ? 576 : 1152
  return { layer, size: Math.floor(((samples / 8) * bitrate) / sampleRate) + padding, sampleRate, channels, samples }
}

/** Splits an MPEG audio elementary stream into frames. */
export function splitMpegAudio(stream: Uint8Array): AudioFrames | null {
  const frames: Uint8Array[] = []
  let first: MpegHeader | null = null
  let i = 0
  while (i + 4 <= stream.length) {
    const header = mpegAudioHeader(stream, i)
    const next = i + (header?.size ?? 0)
    if (!header || next > stream.length || (next + 4 <= stream.length && !mpegAudioHeader(stream, next))) {
      i++
      continue
    }
    first ??= header
    frames.push(stream.subarray(i, i + header.size))
    i += header.size
  }
  if (!first) return null
  return { codec: first.layer === 3 ? 'mp3' : 'mp2', sampleRate: first.sampleRate, channels: first.channels, samplesPerFrame: first.samples, frames }
}

/** DVD LPCM (big-endian 16-bit) as interleaved little-endian samples. */
export function lpcmToS16(data: Uint8Array): Int16Array {
  const out = new Int16Array(data.length >> 1)
  for (let i = 0; i < out.length; i++) out[i] = (data[2 * i] << 8) | data[2 * i + 1]
  return out
}

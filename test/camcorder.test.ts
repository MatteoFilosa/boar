import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ProgramStreamReader, isProgramStream, ticksBetween, type PesPacket } from '@/media/mpeg/programStream'
import { Mpeg2VideoDecoder, type DecodedPicture } from '@/media/mpeg/video'
import { Deinterlacer, type InterlacedFrame } from '@/media/mpeg/deinterlace'
import { bicubicTaps, resampleLines, squareWidth } from '@/media/mpeg/resample'
import { ac3FrameSize, splitAc3, splitMpegAudio } from '@/media/mpeg/audio'

// Camcorder files (MPEG program streams) Boar converts on import. The fixtures
// were made with a reference encoder from a test pattern: an interlaced MPEG-2
// one with AC-3 sound like a camcorder's (field DCT and motion, alternate scan,
// intra VLC table, non-linear quantiser scale, B frames) and an MPEG-1 one
// with MPEG audio like an older camera's.

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(resolve(__dirname, 'fixtures', name)))

/** Packets of a whole file, fed in chunks of `chunk` bytes. */
function packets(data: Uint8Array, chunk: number): PesPacket[] {
  const reader = new ProgramStreamReader()
  const out: PesPacket[] = []
  for (let i = 0; i < data.length; i += chunk) out.push(...reader.push(data.subarray(i, i + chunk)))
  out.push(...reader.finish())
  return out
}

function decode(data: Uint8Array): { pictures: DecodedPicture[]; decoder: Mpeg2VideoDecoder } {
  const decoder = new Mpeg2VideoDecoder()
  const pictures: DecodedPicture[] = []
  for (const p of packets(data, 4096)) {
    if (p.stream < 0xe0) continue
    decoder.push(p.data, p.pts)
    pictures.push(...decoder.take())
  }
  decoder.flush()
  pictures.push(...decoder.take())
  return { pictures, decoder }
}

// The reference decoder's frames: mean luma, then 12 luma samples on a 4×3 grid (x = width·i/5, y = height·j/4).
const MPEG2_REFERENCE = [
  [114.03, 47, 51, 41, 106, 145, 210, 41, 95, 145, 210, 44, 107], [113.82, 50, 50, 41, 106, 145, 210, 41, 91, 145, 210, 41, 106],
  [113.81, 49, 49, 40, 106, 145, 210, 41, 92, 126, 210, 40, 107], [113.65, 59, 64, 40, 106, 145, 210, 41, 97, 126, 210, 41, 107],
  [113.58, 59, 63, 40, 106, 145, 210, 40, 97, 126, 210, 40, 106], [113.74, 59, 64, 40, 106, 145, 210, 41, 99, 126, 210, 40, 106],
  [113.72, 59, 64, 40, 106, 145, 210, 83, 100, 126, 210, 41, 106], [113.97, 60, 64, 40, 106, 145, 210, 80, 106, 126, 210, 41, 106],
  [114.12, 57, 64, 40, 106, 145, 210, 79, 106, 126, 210, 42, 107], [114.21, 47, 64, 40, 105, 145, 210, 76, 106, 126, 126, 42, 105],
  [114.64, 49, 64, 40, 105, 145, 211, 74, 106, 126, 126, 40, 104], [114.57, 49, 64, 40, 105, 145, 156, 72, 106, 126, 126, 41, 106]
]
const MPEG1_REFERENCE = [
  [111.35, 47, 52, 28, 106, 145, 210, 41, 94, 144, 210, 41, 106], [111.2, 51, 50, 146, 107, 145, 210, 41, 96, 145, 210, 42, 107],
  [111.29, 58, 49, 24, 107, 145, 210, 41, 95, 126, 210, 41, 107], [111.04, 59, 55, 24, 107, 145, 210, 41, 97, 126, 210, 40, 107],
  [110.97, 59, 64, 145, 106, 145, 210, 40, 98, 126, 210, 39, 106], [110.93, 58, 64, 20, 106, 145, 210, 78, 98, 126, 210, 38, 106],
  [110.82, 58, 64, 20, 106, 145, 210, 78, 100, 126, 210, 46, 106], [110.78, 59, 64, 26, 106, 145, 211, 76, 106, 126, 210, 43, 106],
  [110.94, 55, 64, 23, 106, 145, 208, 72, 106, 126, 210, 39, 106], [110.97, 48, 64, 147, 106, 145, 210, 70, 106, 126, 210, 39, 106],
  [111.44, 48, 64, 21, 106, 145, 160, 67, 106, 126, 126, 42, 107], [111.45, 48, 64, 147, 106, 145, 161, 60, 106, 126, 126, 44, 107]
]

function expectLike(pictures: DecodedPicture[], reference: number[][]): void {
  expect(pictures).toHaveLength(reference.length)
  pictures.forEach((p, i) => {
    let sum = 0
    for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) sum += p.y[y * p.stride + x]
    const [mean, ...samples] = reference[i]
    expect(Math.abs(sum / (p.width * p.height) - mean)).toBeLessThan(0.3)
    let k = 0
    // Transforms may round differently by one step: a sample is within 3 of the reference.
    for (let gy = 1; gy <= 3; gy++) {
      for (let gx = 1; gx <= 4; gx++) {
        const value = p.y[Math.floor((gy * p.height) / 4) * p.stride + Math.floor((gx * p.width) / 5)]
        expect(Math.abs(value - samples[k++])).toBeLessThanOrEqual(3)
      }
    }
  })
}

describe('camcorder files', () => {
  test('recognized by their first bytes', () => {
    expect(isProgramStream(fixture('camcorder-mpeg2.mpg'))).toBe(true)
    expect(isProgramStream(fixture('camera-mpeg1.mpg'))).toBe(true)
    expect(isProgramStream(new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0]))).toBe(false)
  })

  test('packets come out the same whatever the chunk size', () => {
    const data = fixture('camcorder-mpeg2.mpg')
    const whole = packets(data, data.length)
    const small = packets(data, 777)
    expect(small.map((p) => [p.stream, p.substream, p.pts, p.data.length])).toEqual(whole.map((p) => [p.stream, p.substream, p.pts, p.data.length]))
    expect(whole.some((p) => p.stream === 0xe0)).toBe(true)
    expect(whole.some((p) => p.stream === 0xbd && p.substream === 0x80)).toBe(true)
  })

  test('interlaced MPEG-2 decodes like the reference decoder', () => {
    const { pictures, decoder } = decode(fixture('camcorder-mpeg2.mpg'))
    expect(decoder.sequence).toMatchObject({ width: 176, height: 144, frameRate: 25, progressive: false, mpeg2: true })
    expect(decoder.sequence?.aspect).toBeCloseTo(16 / 9)
    expect(pictures[0].topFieldFirst).toBe(true)
    expectLike(pictures, MPEG2_REFERENCE)
    // Display order: time stamps go up a frame at a time.
    const times = pictures.map((p) => p.pts as number)
    for (let i = 1; i < times.length; i++) expect(ticksBetween(times[i - 1], times[i])).toBe(3600)
  })

  test('MPEG-1 decodes like the reference decoder', () => {
    const { pictures, decoder } = decode(fixture('camera-mpeg1.mpg'))
    expect(decoder.sequence).toMatchObject({ width: 160, height: 120, progressive: true, mpeg2: false })
    expectLike(pictures, MPEG1_REFERENCE)
  })

  test('sound is cut into whole frames', () => {
    const ac3 = packets(fixture('camcorder-mpeg2.mpg'), 4096).filter((p) => p.stream === 0xbd && p.substream === 0x80)
    const stream = new Uint8Array(ac3.reduce((n, p) => n + p.data.length, 0))
    ac3.reduce((at, p) => (stream.set(p.data, at), at + p.data.length), 0)
    const frames = splitAc3(stream)
    expect(frames).toMatchObject({ codec: 'ac3', sampleRate: 48000, channels: 1, samplesPerFrame: 1536 })
    expect(frames?.frames.every((f) => f.length === ac3FrameSize(f, 0))).toBe(true)
    expect(frames?.frames.length).toBeGreaterThanOrEqual(15)

    const mp2 = packets(fixture('camera-mpeg1.mpg'), 4096).filter((p) => p.stream === 0xc0)
    const audio = new Uint8Array(mp2.reduce((n, p) => n + p.data.length, 0))
    mp2.reduce((at, p) => (audio.set(p.data, at), at + p.data.length), 0)
    expect(splitMpegAudio(audio)).toMatchObject({ codec: 'mp2', sampleRate: 44100, channels: 1, samplesPerFrame: 1152 })
  })

  test('a still picture comes out of deinterlacing unchanged, one frame per field', () => {
    const width = 16
    const height = 8
    // A smooth picture (no detail finer than a line, which interpolation would rightly change).
    const plane = (w: number, h: number): Uint8Array => Uint8Array.from({ length: w * h }, (_, i) => (i % w) * 7 + Math.floor(i / w) * 9)
    const still: InterlacedFrame = {
      y: { data: plane(width, height), offset: 0, stride: width },
      u: { data: plane(width / 2, height / 2), offset: 0, stride: width / 2 },
      v: { data: plane(width / 2, height / 2), offset: 0, stride: width / 2 },
      width,
      height,
      topFieldFirst: true,
      progressive: false
    }
    const d = new Deinterlacer()
    const out = [...d.push(still), ...d.push(still), ...d.push(still), ...d.flush()]
    expect(out).toHaveLength(6)
    for (const f of out) expect(Array.from(f.data.subarray(0, width * height))).toEqual(Array.from(still.y.data))
  })

  test('lines stretch to square pixels', () => {
    // 720 samples of a 16:9 PAL picture are 1024 square pixels wide; 4:3 NTSC ones 640.
    expect(squareWidth(576, 16 / 9)).toBe(1024)
    expect(squareWidth(480, 4 / 3)).toBe(640)
    const from = 720
    const src = new Uint8Array(from * 2).fill(90)
    const dst = new Uint8Array(1024 * 2)
    resampleLines(src, 0, from, 2, bicubicTaps(from, 1024), dst, 0)
    expect(dst.every((v) => v === 90)).toBe(true)
  })
})

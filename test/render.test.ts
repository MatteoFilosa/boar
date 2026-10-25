import { describe, expect, test } from 'vitest'
import { mixedTracks } from '@/core/timeline'
import { GifWriter, gifDelays, gifFormat } from '@/engine/gif'
import { withExtension } from '@/engine/targets'
import { ExportCancelled, type RenderStage, RenderStalled, guarded, stallFallback } from '@/engine/stall'
import type { ExportCodec, ExportSettings } from '@/engine/export'
import { type Acceleration, type EncoderSupport, codecSupport, describeSupport, encoderProblem, tellRate, toldRate, usableChoice } from '@/engine/encoders'
import { FPS30, project, track } from './helpers'

describe('tracks a render mixes', () => {
  const tracks = [track('v1'), { ...track('voice', 'audio') }, { ...track('music', 'audio'), muted: true }, track('sfx', 'audio')]

  test('every audio track that is heard, without muted ones', () => {
    expect(mixedTracks(project(tracks, [])).map((t) => t.id)).toEqual(['voice', 'sfx'])
  })

  test('solo wins over the others', () => {
    const soloed = tracks.map((t) => (t.id === 'sfx' ? { ...t, solo: true } : t))
    expect(mixedTracks(project(soloed, [])).map((t) => t.id)).toEqual(['sfx'])
  })

  test('a chosen track is rendered alone, even when muted', () => {
    expect(mixedTracks(project(tracks, []), ['music']).map((t) => t.id)).toEqual(['music'])
  })

  test('video tracks are never mixed', () => {
    expect(mixedTracks(project(tracks, []), ['v1'])).toEqual([])
  })
})

describe('render file names', () => {
  test('the extension follows the format', () => {
    expect(withExtension('Boar render.mp4', 'mp3')).toBe('Boar render.mp3')
    expect(withExtension('Trailer.MP4', 'gif')).toBe('Trailer.gif')
    expect(withExtension('Trailer', 'wav')).toBe('Trailer.wav')
  })

  test('other dots stay part of the name', () => {
    expect(withExtension('v1.2 final', 'flac')).toBe('v1.2 final.flac')
  })

  test('an empty name gets the default one', () => {
    expect(withExtension('  ', 'ogg')).toBe('Boar render.ogg')
    expect(withExtension('.mp4', 'mp4')).toBe('Boar render.mp4')
  })
})

describe('GIF timing and size', () => {
  test('delays add up to the length, without drift', () => {
    for (const rate of [10, 12, 15, 24, 30]) {
      const delays = gifDelays(rate * 7, rate)
      expect(delays.reduce((a, b) => a + b, 0)).toBe(700)
      expect(Math.max(...delays) - Math.min(...delays)).toBeLessThanOrEqual(1)
    }
  })

  test('size keeps the project shape and never grows past it', () => {
    const vertical = { ...project([], []), settings: { width: 1080, height: 1920, frameRate: FPS30, sampleRate: 48000 } }
    expect(gifFormat(vertical, { width: 480, fps: 15 })).toEqual({ width: 480, height: 853, fps: 15 })
    expect(gifFormat(vertical, { width: 4000, fps: 60 })).toEqual({ width: 1080, height: 1920, fps: 30 })
  })
})

/** The frames of a GIF file: [delay in hundredths, local palette size] per image. */
function readGif(bytes: Uint8Array): { width: number; height: number; loops: boolean; frames: { delay: number }[] } {
  expect(String.fromCharCode(...bytes.subarray(0, 6))).toBe('GIF89a')
  const width = bytes[6] | (bytes[7] << 8)
  const height = bytes[8] | (bytes[9] << 8)
  let at = 13
  if (bytes[10] & 0x80) at += 3 << ((bytes[10] & 7) + 1)
  const frames: { delay: number }[] = []
  let loops = false
  let delay = 0
  const skipBlocks = (): void => {
    while (bytes[at] !== 0) at += bytes[at] + 1
    at++
  }
  while (bytes[at] !== 0x3b) {
    if (bytes[at] === 0x21) {
      const label = bytes[at + 1]
      if (label === 0xf9) delay = bytes[at + 4] | (bytes[at + 5] << 8)
      if (label === 0xff && String.fromCharCode(...bytes.subarray(at + 3, at + 14)) === 'NETSCAPE2.0') loops = true
      at += 2
      skipBlocks()
    } else if (bytes[at] === 0x2c) {
      const packed = bytes[at + 9]
      at += 10
      if (packed & 0x80) at += 3 << ((packed & 7) + 1)
      at++ // LZW minimum code size
      skipBlocks()
      frames.push({ delay })
    } else {
      throw new Error(`unexpected byte ${bytes[at]} at ${at}`)
    }
  }
  return { width, height, loops, frames }
}

function solid(width: number, height: number, rgb: [number, number, number]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < out.length; i += 4) out.set([...rgb, 255], i)
  return out
}

describe('GIF writing', () => {
  test('identical frames fold into the delay of the one before', () => {
    const gif = new GifWriter(8, 6, { colors: 256, dither: false, loop: true })
    gif.add(solid(8, 6, [255, 0, 0]), 7)
    gif.add(solid(8, 6, [255, 0, 0]), 7)
    gif.add(solid(8, 6, [0, 0, 255]), 6)
    gif.add(solid(8, 6, [0, 0, 255]), 7)
    gif.add(solid(8, 6, [0, 255, 0]), 7)
    const file = readGif(gif.finish())
    expect(file).toMatchObject({ width: 8, height: 6, loops: true })
    expect(file.frames.map((f) => f.delay)).toEqual([14, 13, 7])
    expect(gif.frames).toBe(3)
  })

  test('play once has no loop block', () => {
    const gif = new GifWriter(4, 4, { colors: 64, dither: true, loop: false })
    gif.add(solid(4, 4, [10, 200, 30]), 10)
    expect(readGif(gif.finish()).loops).toBe(false)
  })
})

describe('renders that stop moving', () => {
  const never = new Promise<never>(() => undefined)

  test('a step that never ends counts as stalled, and Cancel ends the wait at once', async () => {
    const stalled = (): RenderStalled => new RenderStalled('videoEncoder', 3, true, '')
    await expect(guarded(never, 0.3, () => false, stalled)).rejects.toBeInstanceOf(RenderStalled)
    await expect(guarded(never, 30, () => true, stalled)).rejects.toBeInstanceOf(ExportCancelled)
    await expect(guarded(Promise.resolve(5), 1, () => false, stalled)).resolves.toBe(5)
  })

  test('the next try: bitrate rate control, then the processor, then nothing', async () => {
    const base: ExportSettings = { codec: 'avc', quality: 'high', encoder: 'auto', includeAudio: true, masterDb: 0, autoCrossfade: true }
    const stall = (stage: RenderStage, quantizer = false): RenderStalled => new RenderStalled(stage, 5, quantizer, '')
    type Can = (hardwareAcceleration: 'prefer-hardware' | 'prefer-software') => Promise<boolean>
    const both: Can = async () => true
    const retry = async (s: RenderStalled, settings: ExportSettings, can: Can = both): Promise<unknown> =>
      (await stallFallback(s, settings, can))?.retry ?? null
    expect(await retry(stall('videoEncoder', true), base)).toEqual({ preferBitrate: true })
    expect(await retry(stall('videoEncoder', true), { ...base, preferBitrate: true })).toEqual({ encoder: 'cpu', preferBitrate: false })
    expect(await retry(stall('videoEncoder'), { ...base, encoder: 'cpu' })).toBeNull()
    // Automatic on a system without a hardware encoder was the processor's already.
    expect(await retry(stall('videoEncoder'), base, async (h) => h === 'prefer-software')).toBeNull()
    expect(await retry(stall('videoEncoder'), { ...base, encoder: 'gpu' }, async (h) => h === 'prefer-software')).toEqual({ encoder: 'cpu', preferBitrate: false })
    expect(await retry(stall('decoder'), base)).toEqual({ softwareDecode: true })
    expect(await retry(stall('decoder'), { ...base, softwareDecode: true })).toBeNull()
    expect(await retry(stall('audioEncoder'), { ...base, audioCodec: 'aac' })).toEqual({ audioCodec: 'opus' })
    expect(await retry(stall('audioEncoder'), { ...base, audioCodec: 'opus' })).toBeNull()
  })
})

describe('video encoders at the project frame rate', () => {
  type Can = (acceleration: Acceleration, frameRate: number) => Promise<boolean>
  // A graphics card offered 1440p only up to 30 fps, and no software encoder.
  const upTo30: Can = async (a, r) => a === 'prefer-hardware' && r <= 30
  const none: Can = async () => false

  test('a card that refuses the rate but takes the size at 30 fps is told 30 fps', async () => {
    const support = await codecSupport(59.94, upTo30)
    expect(support).toEqual({ gpu: true, cpu: false, gpuRate: 30 })
    expect(toldRate(support, 'auto')).toBe(30)
    expect(toldRate(support, 'gpu')).toBe(30)
    expect(toldRate(support, 'cpu')).toBeUndefined()
    expect(describeSupport(support)).toBe('graphics card only told 30 fps, processor no')
  })

  test('a rate the card takes, or 30 fps and below, is told as it is', async () => {
    expect(await codecSupport(59.94, async () => true)).toEqual({ gpu: true, cpu: true })
    expect(await codecSupport(25, upTo30)).toEqual({ gpu: true, cpu: false })
    expect(toldRate(await codecSupport(25, upTo30), 'auto')).toBeUndefined()
    // Refused at 30 too: the processor's encoder, at the real rate.
    const software: Can = async (a) => a === 'prefer-software'
    const support = await codecSupport(59.94, software)
    expect(support).toEqual({ gpu: false, cpu: true })
    expect(toldRate(support, 'auto')).toBeUndefined()
  })

  test('bitrate rate control goes down with the told rate, constant quality stays', () => {
    const vbr = { framerate: 59.94, bitrate: 10_000_000, bitrateMode: 'variable' }
    tellRate(vbr, 59.94, 30)
    expect(vbr).toEqual({ framerate: 30, bitrate: 5_005_005, bitrateMode: 'variable' })
    const quantizer: { framerate?: number; bitrate?: number; bitrateMode: string } = { framerate: 59.94, bitrateMode: 'quantizer' }
    tellRate(quantizer, 59.94, 30)
    expect(quantizer).toEqual({ framerate: 30, bitrateMode: 'quantizer' })
  })

  test('a codec nothing here can encode gets a clear reason', async () => {
    const format = '2560x1440, 59.940 fps'
    const nothing = await codecSupport(59.94, none)
    expect(encoderProblem('hevc', 'H.265 / HEVC', 'auto', nothing, format)).toMatch(/cannot encode H.265 \/ HEVC at 2560x1440, 59.940 fps:.*Render H\.264/)
    expect(encoderProblem('avc', 'H.264 / AVC', 'auto', nothing, format)).toMatch(/Render another format/)
    expect(encoderProblem('avc', 'H.264 / AVC', 'gpu', { gpu: false, cpu: true }, format)).toMatch(/graphics card cannot encode/)
    expect(encoderProblem('avc', 'H.264 / AVC', 'cpu', { gpu: true, cpu: false }, format)).toMatch(/no software encoder/)
    expect(encoderProblem('avc', 'H.264 / AVC', 'gpu', { gpu: true, cpu: false, gpuRate: 30 }, format)).toBeNull()
  })

  test('a remembered choice that cannot work here falls back to one that can', () => {
    const support: Record<ExportCodec, EncoderSupport> = {
      avc: { gpu: false, cpu: true },
      hevc: { gpu: false, cpu: false },
      av1: { gpu: true, cpu: true },
      vp9: { gpu: false, cpu: true }
    }
    expect(usableChoice(support, 'hevc', 'gpu')).toEqual({ codec: 'avc', encoder: 'auto' })
    expect(usableChoice(support, 'hevc', 'cpu')).toEqual({ codec: 'avc', encoder: 'cpu' })
    expect(usableChoice(support, 'av1', 'gpu')).toEqual({ codec: 'av1', encoder: 'gpu' })
    const nothing = { gpu: false, cpu: false }
    expect(usableChoice({ avc: nothing, hevc: nothing, av1: nothing, vp9: nothing }, 'avc', 'auto')).toBeNull()
  })
})

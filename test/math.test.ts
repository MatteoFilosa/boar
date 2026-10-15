import { describe, expect, test } from 'vitest'
import { integratedLoudness, truePeak } from '@/engine/loudness'
import { DEFAULT_PANCROP, type PanCropKey, fillZoom, fitFrame, normalizeAngle, panCropAt, sourcePlacement, turnState } from '@/core/pancrop'
import { s } from './helpers'

const sine = (freq: number, amplitude: number, seconds: number, rate = 48000, phase = 0): Float32Array =>
  Float32Array.from({ length: Math.round(seconds * rate) }, (_, n) => amplitude * Math.sin((2 * Math.PI * freq * n) / rate + phase))

describe('loudness (BS.1770)', () => {
  test('a full-scale 997 Hz sine in one channel reads -3.01 LUFS', () => {
    expect(integratedLoudness([sine(997, 1, 4)], 48000)).toBeCloseTo(-3.01, 1)
  })

  test('the same sine in both channels reads 0 LUFS, at 44.1 kHz too', () => {
    const tone = sine(997, 1, 4, 44100)
    expect(integratedLoudness([tone, tone], 44100)).toBeCloseTo(0, 1)
  })

  test('-20 dB is 20 LU quieter', () => {
    expect(integratedLoudness([sine(997, 0.1, 4)], 48000)).toBeCloseTo(-23.01, 1)
  })

  test('silence has no loudness', () => {
    expect(integratedLoudness([new Float32Array(48000 * 2)], 48000)).toBe(-Infinity)
  })

  test('silent stretches are gated out', () => {
    const half = sine(997, 1, 4)
    const gappy = new Float32Array(half.length * 2)
    gappy.set(half)
    // Averaged with the silence it would read -6 LUFS; only the blocks across the edge pull it down a little.
    const lufs = integratedLoudness([gappy], 48000)
    expect(lufs).toBeGreaterThan(-3.3)
    expect(lufs).toBeLessThan(-2.9)
  })

  test('the true peak sees the top of a wave between two samples', () => {
    // A quarter of the sample rate at 45°: every sample is at ±0.707, the wave reaches 1.
    const wave = sine(12000, 1, 0.1, 48000, Math.PI / 4)
    expect(Math.max(...wave.map(Math.abs))).toBeCloseTo(Math.SQRT1_2, 3)
    expect(truePeak([wave])).toBeGreaterThan(0.95)
  })
})

describe('Pan/Crop', () => {
  const key = (t: number, zoom: number, ease: PanCropKey['ease'], cx = 0.5): PanCropKey => ({
    time: s(t),
    cx,
    cy: 0.5,
    zoom,
    rotation: 0,
    ease
  })

  test('no keys is the whole picture', () => {
    expect(panCropAt([], 0)).toEqual(DEFAULT_PANCROP)
  })

  test('zoom moves at an even pace (geometric), position linearly', () => {
    const at = panCropAt([key(0, 1, 'linear', 0.2), key(2, 4, 'linear', 0.8)], s(1))
    expect(at.zoom).toBeCloseTo(2)
    expect(at.cx).toBeCloseTo(0.5)
  })

  test('hold keeps the key until the next one', () => {
    expect(panCropAt([key(0, 1, 'hold'), key(2, 4, 'linear')], s(1.9)).zoom).toBe(1)
  })

  test('before the first key and after the last the framing holds', () => {
    const keys = [key(1, 2, 'smooth'), key(2, 3, 'smooth')]
    expect(panCropAt(keys, 0).zoom).toBe(2)
    expect(panCropAt(keys, s(5)).zoom).toBe(3)
  })

  test('16:9 footage in a 9:16 frame: fit leaves bars, fill covers', () => {
    expect(fitFrame(1920, 1080, 1080, 1920)).toEqual({ w: 1920, h: (1920 * 1920) / 1080 })
    expect(fillZoom(1920, 1080, 1080, 1920)).toBeCloseTo((16 / 9) ** 2)
  })

  test('four quarter turns come back to the same framing, keeping a fill', () => {
    // 4:3 in 16:9: fit and fill differ both upright and sideways.
    const fill = fillZoom(1440, 1080, 1920, 1080)
    let state = { ...DEFAULT_PANCROP, zoom: fill }
    for (let i = 0; i < 4; i++) {
      state = turnState(state, 90, 1440, 1080, 1920, 1080)
      // Sideways, filling a 16:9 frame takes 16/9 of the 4:3 picture's fitted height.
      if (i % 2 === 0) expect(state.zoom).toBeCloseTo(16 / 9)
    }
    expect(state.zoom).toBeCloseTo(fill)
    expect(normalizeAngle(state.rotation)).toBeCloseTo(0)
    expect(state.cx).toBeCloseTo(0.5)
  })

  test('a quarter turn keeps the picture centered where it was', () => {
    const state = { cx: 0.3, cy: 0.6, zoom: 1.5, rotation: 0 }
    const before = sourcePlacement(state, 1920, 1080, 1920, 1080)
    const after = sourcePlacement(turnState(state, 90, 1920, 1080, 1920, 1080), 1920, 1080, 1920, 1080)
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
  })

  test('angles normalize into (-180, 180]', () => {
    expect([normalizeAngle(270), normalizeAngle(-180), normalizeAngle(540), normalizeAngle(-90)]).toEqual([-90, 180, 180, -90])
  })
})

import { describe, expect, test } from 'vitest'
import { integratedLoudness, truePeak } from '@/engine/loudness'
import {
  DEFAULT_PANCROP,
  type PanCropKey,
  fillZoom,
  fitFrame,
  framingZoom,
  normalizeAngle,
  panCropAt,
  placeBox,
  sourcePlacement,
  sourceToOutput,
  stretchBox,
  turnState,
  withStretch
} from '@/core/pancrop'
import { DEFAULT_MASK, type MaskBox, convertMaskSpace, dragBox } from '@/core/mask'
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
  const key = (t: number, zoom: number, ease: PanCropKey['ease'], cx = 0.5, stretch = 1): PanCropKey => ({
    time: s(t),
    cx,
    cy: 0.5,
    zoom,
    rotation: 0,
    stretch,
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
    const state = { cx: 0.3, cy: 0.6, zoom: 1.5, rotation: 0, stretch: 1 }
    const before = sourcePlacement(state, 1920, 1080, 1920, 1080)
    const after = sourcePlacement(turnState(state, 90, 1920, 1080, 1920, 1080), 1920, 1080, 1920, 1080)
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
  })

  test('stretch moves at an even pace, like zoom', () => {
    expect(panCropAt([key(0, 1, 'linear', 0.5, 1), key(2, 1, 'linear', 0.5, 4)], s(1)).stretch).toBeCloseTo(2)
  })

  test('a picture placed as a box of any shape reads back as that box', () => {
    // A 400x300 picture shown 800 wide and 200 high: three times as wide as its own proportions.
    const state = placeBox(700, 400, 800, 200, 0, 400, 300, 1920, 1080)
    expect(state.stretch).toBeCloseTo(3)
    const at = sourcePlacement(state, 400, 300, 1920, 1080)
    expect([at.x, at.y, at.w, at.h].map((v) => Math.round(v * 1000) / 1000)).toEqual([700, 400, 800, 200])
  })

  test('a turned stretched picture stays a rectangle along its own sides', () => {
    const state = placeBox(900, 500, 600, 150, -30, 400, 300, 1920, 1080)
    const { map, inverse } = sourceToOutput(state, 400, 300, 1920, 1080)
    const [a, b, c] = [map(0, 0), map(400, 0), map(0, 300)]
    expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeCloseTo(600)
    expect(Math.hypot(c[0] - a[0], c[1] - a[1])).toBeCloseTo(150)
    // The sides stay square to each other, turned 30° clockwise on screen.
    expect((b[0] - a[0]) * (c[0] - a[0]) + (b[1] - a[1]) * (c[1] - a[1])).toBeCloseTo(0)
    expect((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI).toBeCloseTo(30)
    const back = inverse(...map(123, 45))
    expect(back[0]).toBeCloseTo(123)
    expect(back[1]).toBeCloseTo(45)
  })

  test('a mask over the whole stretched picture covers its box on screen', () => {
    const state = placeBox(700, 400, 800, 200, 0, 400, 300, 1920, 1080)
    const mask = { ...DEFAULT_MASK, shape: 'rectangle' as const, space: 'picture' as const, cx: 0.5, cy: 0.5, w: 1, h: 1 }
    const framed = convertMaskSpace(mask, 'frame', state, 400, 300, 1920, 1080)
    expect([framed.cx * 1920, framed.cy * 1080, framed.w * 1920, framed.h * 1080].map((v) => Math.round(v * 1000) / 1000)).toEqual([700, 400, 800, 200])
    const back = convertMaskSpace(framed, 'picture', state, 400, 300, 1920, 1080)
    expect(back.w).toBeCloseTo(1)
    expect(back.h).toBeCloseTo(1)
  })

  test('a new stretch keeps the center and height on screen', () => {
    const state = withStretch(placeBox(700, 400, 400, 300, 0, 400, 300, 1920, 1080), 2, 400, 300, 1920, 1080)
    const at = sourcePlacement(state, 400, 300, 1920, 1080)
    expect([at.x, at.y, at.w, at.h].map((v) => Math.round(v * 1000) / 1000)).toEqual([700, 400, 800, 300])
  })

  test('fit and fill count on the stretched picture', () => {
    // A square stretched to 16:9 fills a 16:9 frame exactly.
    expect(framingZoom('fill', 0, 1080, 1080, 1920, 1080, 16 / 9)).toBeCloseTo(1)
    expect(framingZoom('fit', 0, 1080, 1080, 1920, 1080, 16 / 9)).toBeCloseTo(1)
    expect(framingZoom('fill', 0, 1080, 1080, 1920, 1080, 1)).toBeCloseTo(16 / 9)
  })

  test('a quarter turn keeps the stretch, the center and the size', () => {
    const state = placeBox(600, 300, 500, 100, 0, 400, 300, 1920, 1080)
    const turned = turnState(state, 90, 400, 300, 1920, 1080)
    expect(turned.stretch).toBeCloseTo(state.stretch)
    const at = sourcePlacement(turned, 400, 300, 1920, 1080)
    expect([at.x, at.y, at.w, at.h].map((v) => Math.round(v * 1000) / 1000)).toEqual([600, 300, 500, 100])
  })

  test('angles normalize into (-180, 180]', () => {
    expect([normalizeAngle(270), normalizeAngle(-180), normalizeAngle(540), normalizeAngle(-90)]).toEqual([-90, 180, 180, -90])
  })
})

describe('stretch handles', () => {
  const box = { cx: 500, cy: 300, w: 200, h: 100, angle: 0 }
  const src = { w: 1000, h: 1000 }
  const round = (b: { cx: number; cy: number; w: number; h: number }): number[] => [b.cx, b.cy, b.w, b.h].map((v) => Math.round(v * 1000) / 1000)

  test('a side handle moves that side only', () => {
    // Right side 100 px to the right: the left side stays at 400.
    expect(round(stretchBox(box, 'e', 100, 37, src, 'snap'))).toEqual([550, 300, 300, 100])
    // Top side 50 px up: the bottom stays at 350.
    expect(round(stretchBox(box, 'n', 12, -50, src, 'snap'))).toEqual([500, 275, 200, 150])
  })

  test('a corner moves its two sides, the opposite corner stays', () => {
    expect(round(stretchBox(box, 'nw', -50, -20, src, 'snap'))).toEqual([475, 290, 250, 120])
  })

  test('a corner can keep the box\'s proportions', () => {
    // Twice as wide as tall: the pointer 100 px right and 20 down gives a box 1.44 times as big.
    expect(round(stretchBox(box, 'se', 100, 20, src, 'keep'))).toEqual([544, 322, 288, 144])
  })

  test('on a turned box the sides move along its own axes', () => {
    // Turned a quarter clockwise: its right side faces down on screen.
    expect(round(stretchBox({ ...box, angle: Math.PI / 2 }, 'e', 0, 100, src, 'snap'))).toEqual([500, 350, 300, 100])
  })

  test('near its own proportions the picture snaps to them, unless free', () => {
    const own = { w: 400, h: 300 }
    const b = { ...box, w: 200, h: 150 }
    const snapped = stretchBox(b, 'e', 4, 0, own, 'snap')
    expect(snapped.snapped).toBe(true)
    expect(snapped.w).toBeCloseTo(200)
    expect(stretchBox(b, 'e', 4, 0, own, 'free').w).toBeCloseTo(204)
  })

  test('a side never shrinks past a few pixels or flips', () => {
    expect(stretchBox(box, 'e', -500, 0, src, 'free').w).toBe(4)
  })
})

describe('mask ellipse and rectangle drags', () => {
  const box: MaskBox = { cx: 0.5, cy: 0.5, w: 0.4, h: 0.2 }
  const round = (b: MaskBox): number[] => [b.cx, b.cy, b.w, b.h].map((v) => Math.round(v * 1e6) / 1e6)

  test('moving shifts the center only', () => {
    expect(round(dragBox(box, 'move', 0, 0, [0.5, 0.5], [0.6, 0.45]))).toEqual([0.6, 0.45, 0.4, 0.2])
  })

  test('a side handle moves that side and keeps the opposite one', () => {
    // Right side from 0.7 to 0.8: left stays at 0.3.
    expect(round(dragBox(box, 'resize', 1, 0, [0.7, 0.5], [0.8, 0.9]))).toEqual([0.55, 0.5, 0.5, 0.2])
    // Past the opposite side it flips instead of going negative.
    expect(round(dragBox(box, 'resize', 1, 0, [0.7, 0.5], [0.2, 0.5]))).toEqual([0.25, 0.5, 0.1, 0.2])
  })

  test('Alt resizes around the center, Shift keeps the proportions', () => {
    expect(round(dragBox(box, 'resize', 1, 0, [0.7, 0.5], [0.8, 0.5], false, true))).toEqual([0.5, 0.5, 0.6, 0.2])
    // Bottom-right corner dragged mostly across: both sides grow by the same factor, top-left stays.
    expect(round(dragBox(box, 'resize', 1, 1, [0.7, 0.6], [0.9, 0.6], true))).toEqual([0.6, 0.55, 0.6, 0.3])
    // Top-left corner: the bottom-right corner stays.
    expect(round(dragBox(box, 'resize', -1, -1, [0.3, 0.4], [0.1, 0.4], true))).toEqual([0.4, 0.45, 0.6, 0.3])
  })

  test('drawing spans the drag, Shift makes it square in pixels', () => {
    expect(round(dragBox(box, 'draw', 0, 0, [0.6, 0.5], [0.2, 0.7]))).toEqual([0.4, 0.6, 0.4, 0.2])
    // 16:9 space: 0.1 across is 0.1777… down in pixels.
    const square = dragBox(box, 'draw', 0, 0, [0.2, 0.2], [0.3, 0.25], true, false, 16 / 9)
    expect(square.w * 1920).toBeCloseTo(square.h * 1080)
    expect(square.cx - square.w / 2).toBeCloseTo(0.2)
    expect(square.cy - square.h / 2).toBeCloseTo(0.2)
    expect(round(dragBox(box, 'draw', 0, 0, [0.5, 0.5], [0.6, 0.6], false, true))).toEqual([0.5, 0.5, 0.2, 0.2])
  })
})

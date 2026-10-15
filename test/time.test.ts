import { describe, expect, test } from 'vitest'
import {
  FLICKS_PER_SECOND,
  STANDARD_RATES,
  formatDuration,
  formatTimecode,
  frameFlicks,
  frameIndex,
  nearestStandardRate,
  quantizeToFrame,
  secondsToFlicks
} from '@/core/time'

describe('flicks', () => {
  test('every standard frame rate has a whole number of flicks per frame', () => {
    for (const { rate } of STANDARD_RATES) {
      expect((FLICKS_PER_SECOND * rate.den) % rate.num).toBe(0)
      expect(Number.isInteger(frameFlicks(rate))).toBe(true)
    }
  })

  test('common audio sample rates divide a second exactly', () => {
    for (const rate of [44100, 48000, 96000, 16000]) expect(FLICKS_PER_SECOND % rate).toBe(0)
  })

  test('frame positions stay exact after an hour of NTSC frames', () => {
    const rate = { num: 30000, den: 1001 }
    const hour = 107_892 // frames of 29.97 fps in one hour, rounded down
    const t = hour * frameFlicks(rate)
    expect(frameIndex(t, rate)).toBe(hour)
    expect(quantizeToFrame(t + 1000, rate)).toBe(t)
  })

  test('quantizeToFrame rounds to the nearest frame', () => {
    const rate = { num: 30, den: 1 }
    const frame = frameFlicks(rate)
    expect(quantizeToFrame(frame * 10 + frame / 2 - 1, rate)).toBe(frame * 10)
    expect(quantizeToFrame(frame * 10 + frame / 2 + 1, rate)).toBe(frame * 11)
  })
})

describe('timecode', () => {
  test('non-drop frame at 25 fps', () => {
    expect(formatTimecode(90 * frameFlicks({ num: 25, den: 1 }), { num: 25, den: 1 })).toBe('00:00:03:15')
  })

  test('29.97 drop frame skips frame numbers 0 and 1 each minute but every tenth', () => {
    const rate = { num: 30000, den: 1001 }
    const at = (frames: number): string => formatTimecode(frames * frameFlicks(rate), rate)
    expect(at(1799)).toBe('00:00:59;29')
    expect(at(1800)).toBe('00:01:00;02')
    expect(at(17982)).toBe('00:10:00;00')
  })

  test('59.94 drop frame skips four frame numbers', () => {
    const rate = { num: 60000, den: 1001 }
    expect(formatTimecode(3600 * frameFlicks(rate), rate)).toBe('00:01:00;04')
  })

  test('durations', () => {
    expect(formatDuration(secondsToFlicks(83.456))).toBe('1:23.46')
    expect(formatDuration(secondsToFlicks(3723.4))).toBe('1:02:03.40')
  })
})

test('measured frame rates snap to the closest standard one', () => {
  expect(nearestStandardRate(29.98)).toEqual({ num: 30000, den: 1001 })
  expect(nearestStandardRate(30.02)).toEqual({ num: 30, den: 1 })
  expect(nearestStandardRate(59.9)).toEqual({ num: 60000, den: 1001 })
  expect(nearestStandardRate(24.6)).toEqual({ num: 25, den: 1 })
})

import { describe, expect, test } from 'vitest'
import {
  audioGain,
  crossfadeIn,
  crossfadeOut,
  editPoints,
  envelopeAt,
  findSnap,
  sourceLength,
  sourceTime,
  timelineTime,
  videoAlpha
} from '@/core/timeline'
import { fadeShape, FADE_CURVES } from '@/core/fades'
import { clip, project, s, sec, track } from './helpers'

describe('time mapping with a playback rate', () => {
  const e = clip('a', 'v', 10, 3, { offsetSeconds: 4, rate: 2 })

  test('source time runs rate times as fast as the timeline', () => {
    expect(sec(sourceTime(e, s(10)))).toBe(4)
    expect(sec(sourceTime(e, s(11)))).toBe(6)
    expect(sec(sourceLength(e))).toBe(6)
  })

  test('timelineTime is the inverse of sourceTime', () => {
    for (const t of [10, 10.5, 11.25, 13]) expect(sec(timelineTime(e, sourceTime(e, s(t))))).toBe(t)
  })
})

describe('crossfades', () => {
  const a = clip('a', 'v', 0, 5)
  const b = clip('b', 'v', 4, 5)
  const list = [a, b]

  test('an overlap is a crossfade out of the first and into the second', () => {
    expect(sec(crossfadeOut(a, list))).toBe(1)
    expect(sec(crossfadeIn(b, list))).toBe(1)
    expect(crossfadeIn(a, list)).toBe(0)
    expect(crossfadeOut(b, list)).toBe(0)
  })

  test('video: the later event dissolves in over the earlier one', () => {
    expect(videoAlpha(b, s(4.5), list, true)).toBeCloseTo(0.5)
    expect(videoAlpha(a, s(4.5), list, true)).toBe(1)
    expect(videoAlpha(b, s(4.5), list, false)).toBe(1)
  })

  test('audio: equal-power curves keep the loudness through the middle', () => {
    const ga = audioGain({ ...a, kind: 'audio' }, s(4.5), list, true)
    const gb = audioGain({ ...b, kind: 'audio' }, s(4.5), list, true)
    expect(ga).toBeCloseTo(Math.SQRT1_2)
    expect(ga * ga + gb * gb).toBeCloseTo(1)
  })
})

describe('fades', () => {
  test('every curve goes from 0 to 1 and never backwards', () => {
    for (const { id } of FADE_CURVES) {
      expect(fadeShape(id, 0)).toBeCloseTo(0)
      expect(fadeShape(id, 1)).toBeCloseTo(1)
      let last = -1
      for (let p = 0; p <= 1; p += 0.05) {
        const v = fadeShape(id, p)
        expect(v).toBeGreaterThanOrEqual(last - 1e-9)
        last = v
      }
    }
  })

  test('a fade in and out shape the video level', () => {
    const e = clip('a', 'v', 0, 4, { fadeIn: s(1), fadeOut: s(1) })
    expect(videoAlpha(e, s(0.5), [e], true)).toBeCloseTo(0.5)
    expect(videoAlpha(e, s(2), [e], true)).toBe(1)
    expect(videoAlpha(e, s(3.5), [e], true)).toBeCloseTo(0.5)
  })
})

test('volume envelopes interpolate between points and stay flat outside', () => {
  const points = [
    { time: s(1), gain: 1 },
    { time: s(2), gain: 0.5 },
    { time: s(4), gain: 0.5 }
  ]
  expect(envelopeAt([], s(3))).toBe(1)
  expect(envelopeAt(points, 0)).toBe(1)
  expect(envelopeAt(points, s(1.5))).toBeCloseTo(0.75)
  expect(envelopeAt(points, s(3))).toBeCloseTo(0.5)
  expect(envelopeAt(points, s(10))).toBe(0.5)
})

test('edit points are unique and sorted', () => {
  const p = project([track('v')], [clip('b', 'v', 5, 2), clip('a', 'v', 0, 5)], [{ id: 'm1', time: s(3), label: '' }])
  expect(editPoints(p).map(sec)).toEqual([0, 3, 5, 7])
})

test('snapping picks the closest point within the threshold', () => {
  expect(findSnap([s(1), s(5)], [s(1.2), s(5.05)], s(0.1))).toEqual({ delta: s(0.05), at: s(5.05) })
  expect(findSnap([s(1)], [s(2)], s(0.1))).toBeNull()
})

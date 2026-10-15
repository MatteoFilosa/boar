import { describe, expect, test } from 'vitest'
import { dropSide, transitionAt, transitionSlot, transitionSpans } from '@/core/transitions'
import { clip, s, sec } from './helpers'

const adjacency = s(1 / 60)
const flash = (seconds: number): { type: string; duration: number } => ({ type: 'flash', duration: s(seconds) })

const span = (list: Parameters<typeof transitionSpans>[0]): [string, number, number][] =>
  transitionSpans(list, adjacency).map((x) => [x.mode, sec(x.start), sec(x.end)])

describe('where transitions play', () => {
  test('an overlap: the whole overlap is the transition, whatever its length says', () => {
    const list = [clip('a', 'v', 0, 5), clip('b', 'v', 4, 5, { transition: flash(0.2) })]
    expect(span(list)).toEqual([['overlap', 4, 5]])
  })

  test('a cut: centered on the cut', () => {
    const list = [clip('a', 'v', 0, 5), clip('b', 'v', 5, 5, { transition: flash(1) })]
    expect(span(list)).toEqual([['cut', 4.5, 5.5]])
  })

  test('a cut next to a short clip: never longer than the clips', () => {
    const list = [clip('a', 'v', 0, 0.2), clip('b', 'v', 0.2, 5, { transition: flash(1) })]
    expect(span(list)).toEqual([['cut', 0, 0.4]])
  })

  test('the start with nothing before it', () => {
    expect(span([clip('a', 'v', 2, 5, { transition: flash(1) })])).toEqual([['in', 2, 3]])
  })

  test('the end with nothing after it', () => {
    expect(span([clip('a', 'v', 2, 5, { transitionOut: flash(1) })])).toEqual([['out', 6, 7]])
  })

  test('an end transition that now meets a clip plays between the two', () => {
    const list = [clip('a', 'v', 0, 5, { transitionOut: flash(1) }), clip('b', 'v', 5, 5)]
    expect(span(list)).toEqual([['cut', 4.5, 5.5]])
  })

  test('a gap is not a cut', () => {
    const list = [clip('a', 'v', 0, 5), clip('b', 'v', 6, 5, { transition: flash(1) })]
    expect(span(list)).toEqual([['in', 6, 7]])
  })
})

describe('progress', () => {
  test('through an overlap from 0 to 1', () => {
    const list = [clip('a', 'v', 0, 5), clip('b', 'v', 4, 5, { transition: flash(1) })]
    expect(transitionAt(list, s(4), adjacency)?.p).toBeCloseTo(0)
    expect(transitionAt(list, s(4.5), adjacency)?.p).toBeCloseTo(0.5)
    expect(transitionAt(list, s(3.9), adjacency)).toBeNull()
  })

  test('from nothing: the second half of the effect, on the clip itself', () => {
    const list = [clip('a', 'v', 0, 5, { transition: flash(1) })]
    const t = transitionAt(list, s(0), adjacency)
    expect(t?.from.id).toBe('a')
    expect(t?.p).toBeCloseTo(0.5)
  })
})

describe('slots', () => {
  const list = [clip('a', 'v', 0, 5), clip('b', 'v', 5, 5)]

  test('the end of a clip that leads into another is kept on the start of that one', () => {
    const slot = transitionSlot(list, 0, 'out', adjacency)
    expect(slot.event.id).toBe('b')
    expect(slot.side).toBe('in')
  })

  test('drops go to the half of the clip under the pointer', () => {
    expect(dropSide(list, 1, s(6), adjacency)).toBe('in')
    expect(dropSide(list, 1, s(9), adjacency)).toBe('out')
  })
})

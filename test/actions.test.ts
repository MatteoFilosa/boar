import { beforeEach, describe, expect, test } from 'vitest'
import * as A from '@/core/actions'
import { clip, ev, load, media, project, s, sec, spans, state, track } from './helpers'

const flash = { type: 'flash', duration: s(0.5) }

describe('split', () => {
  beforeEach(() => {
    load(
      project(
        [track('v'), track('a', 'audio')],
        [
          clip('v1', 'v', 0, 10, { groupId: 'g', offsetSeconds: 2, transition: flash, transitionOut: flash, fadeIn: s(1), fadeOut: s(1) }),
          clip('a1', 'a', 0, 10, { groupId: 'g', kind: 'audio', offsetSeconds: 2 })
        ]
      ),
      { cursor: s(4) }
    )
  })

  test('splits every event under the cursor when nothing is selected', () => {
    A.splitAtCursor()
    expect(spans('v')).toEqual([
      [0, 4],
      [4, 10]
    ])
    expect(spans('a')).toEqual([
      [0, 4],
      [4, 10]
    ])
  })

  test('the right halves continue the media and share a new group', () => {
    A.splitAtCursor()
    const right = state().project.events.filter((e) => e.start === s(4))
    expect(right.map((e) => sec(e.offset))).toEqual([6, 6])
    expect(right[0].groupId).not.toBe('g')
    expect(right[0].groupId).toBe(right[1].groupId)
  })

  test('the start keeps its transition and fade in, the end its transition and fade out', () => {
    A.splitAtCursor()
    const left = ev('v1')
    const right = state().project.events.find((e) => e.trackId === 'v' && e.id !== 'v1')!
    expect(left.transition).toEqual(flash)
    expect(left.transitionOut).toBeNull()
    expect(left.fadeIn).toBe(s(1))
    expect(left.fadeOut).toBe(0)
    expect(right.transition).toBeNull()
    expect(right.transitionOut).toEqual(flash)
    expect(right.fadeIn).toBe(0)
    expect(right.fadeOut).toBe(s(1))
  })

  test('a split through a playback rate keeps the source position', () => {
    load(project([track('v')], [clip('v1', 'v', 0, 10, { rate: 2 })]), { cursor: s(3) })
    A.splitAtCursor()
    const right = state().project.events.find((e) => e.id !== 'v1')!
    expect(sec(right.offset)).toBe(6)
  })

  test('only the selected events split when there is a selection', () => {
    load(project([track('v'), track('a', 'audio')], [clip('v1', 'v', 0, 10), clip('a1', 'a', 0, 10, { kind: 'audio' })]), {
      cursor: s(4),
      selection: ['a1']
    })
    A.splitAtCursor()
    expect(spans('v')).toEqual([[0, 10]])
    expect(spans('a')).toHaveLength(2)
  })
})

describe('undo history', () => {
  beforeEach(() => load(project([track('v')], [clip('v1', 'v', 0, 10)]), { cursor: s(5) }))

  test('each edit is one undo step, and redo brings it back', () => {
    const before = state().project
    A.splitAtCursor()
    const after = state().project
    A.undo()
    expect(state().project).toBe(before)
    A.redo()
    expect(state().project).toBe(after)
  })

  test('a drag is one undo step however many updates it had', () => {
    const before = state().project
    A.beginGesture()
    for (let i = 1; i <= 5; i++) A.updateGesture((d) => void (d.events[0].start = s(i)))
    A.endGesture()
    expect(sec(ev('v1').start)).toBe(5)
    expect(state().past).toHaveLength(1)
    A.undo()
    expect(state().project).toBe(before)
  })

  test('a cancelled drag leaves no trace', () => {
    const before = state().project
    A.beginGesture()
    A.updateGesture((d) => void (d.events[0].start = s(3)))
    A.cancelGesture()
    expect(state().project).toBe(before)
    expect(state().past).toHaveLength(0)
  })

  test('typing merges into one undo step', () => {
    A.commitCoalesced('gain', (d) => void (d.events[0].gain = 0.9))
    A.commitCoalesced('gain', (d) => void (d.events[0].gain = 0.8))
    A.commitCoalesced('gain', (d) => void (d.events[0].gain = 0.7))
    expect(state().past).toHaveLength(1)
    A.undo()
    expect(ev('v1').gain).toBe(1)
  })

  test('a change that changes nothing adds no step', () => {
    expect(A.commit(() => undefined)).toBe(false)
    expect(state().past).toHaveLength(0)
  })
})

describe('ripple delete', () => {
  const setup = (): void =>
    load(
      project(
        [track('v'), track('w')],
        [clip('a', 'v', 0, 2), clip('b', 'v', 2, 3), clip('c', 'v', 5, 2), clip('x', 'w', 6, 2)],
        [{ id: 'm1', time: s(6), label: '' }]
      ),
      { selection: ['b'] }
    )

  test('affected tracks: later events on the track close the gap, other tracks and markers stay', () => {
    setup()
    A.rippleDeleteSelection('tracks')
    expect(spans('v')).toEqual([
      [0, 2],
      [2, 4]
    ])
    expect(spans('w')).toEqual([[6, 8]])
    expect(sec(state().project.markers[0].time)).toBe(6)
  })

  test('all tracks and markers move together', () => {
    setup()
    A.rippleDeleteSelection('all')
    expect(spans('w')).toEqual([[3, 5]])
    expect(sec(state().project.markers[0].time)).toBe(3)
  })

  test('Delete without Auto Ripple leaves the gap', () => {
    setup()
    A.deleteCommand(false)
    expect(spans('v')).toEqual([
      [0, 2],
      [5, 7]
    ])
  })
})

describe('time selection', () => {
  beforeEach(() =>
    load(
      project([track('v'), track('w')], [clip('a', 'v', 0, 10), clip('x', 'w', 6, 4)], [
        { id: 'in', time: s(3), label: '' },
        { id: 'after', time: s(8), label: '' }
      ])
    )
  )

  test('ripple delete removes the range from every track when nothing is selected', () => {
    A.setTimeSelection({ start: s(2), end: s(4) })
    A.deleteTimeSelection(true)
    expect(spans('v')).toEqual([
      [0, 2],
      [2, 8]
    ])
    expect(spans('w')).toEqual([[4, 8]])
    expect(state().project.markers.map((m) => sec(m.time))).toEqual([6])
    expect(sec(state().cursor)).toBe(2)
  })

  test('the piece after the range continues the media where it was', () => {
    A.setTimeSelection({ start: s(2), end: s(4) })
    A.deleteTimeSelection(true)
    const after = state().project.events.find((e) => e.trackId === 'v' && e.start === s(2))!
    expect(sec(after.offset)).toBe(4)
  })

  test('trim keeps only the range', () => {
    A.setTimeSelection({ start: s(7), end: s(9) })
    A.trimToTimeSelection()
    expect(spans('v')).toEqual([[7, 9]])
    expect(sec(ev('a').offset)).toBe(7)
    expect(spans('w')).toEqual([[7, 9]])
  })

  test('split cuts at both edges', () => {
    A.setTimeSelection({ start: s(2), end: s(4) })
    A.splitAtTimeSelection()
    expect(spans('v')).toEqual([
      [0, 2],
      [2, 4],
      [4, 10]
    ])
  })
})

describe('jump cuts and ranges', () => {
  test('cutRanges removes the ranges, closes the gaps and adds one-frame audio fades', () => {
    load(
      project(
        [track('v'), track('a', 'audio')],
        [clip('v1', 'v', 0, 10, { groupId: 'g' }), clip('a1', 'a', 0, 10, { groupId: 'g', kind: 'audio' })]
      )
    )
    expect(A.cutRanges(['v1'], [{ start: s(2), end: s(3) }, { start: s(6), end: s(8) }], 'remove')).toBe(2)
    expect(spans('v')).toEqual([
      [0, 2],
      [2, 5],
      [5, 7]
    ])
    expect(spans('a')).toEqual(spans('v'))
    const audio = state().project.events.filter((e) => e.kind === 'audio')
    expect(audio.every((e) => e.fadeIn === s(1 / 30) && e.fadeOut === s(1 / 30))).toBe(true)
    // The pieces play the media that was kept.
    expect(
      state()
        .project.events.filter((e) => e.kind === 'video')
        .sort((a, b) => a.start - b.start)
        .map((e) => sec(e.offset))
    ).toEqual([0, 3, 8])
  })

  test('keepRanges keeps the ranges in order and removes the rest', () => {
    load(project([track('v')], [clip('v1', 'v', 0, 20)]))
    expect(A.keepRanges([{ start: s(10), end: s(12) }, { start: s(2), end: s(5) }])).toBe(3)
    expect(spans('v')).toEqual([
      [0, 3],
      [3, 5]
    ])
    expect(
      state()
        .project.events.toSorted((a, b) => a.start - b.start)
        .map((e) => sec(e.offset))
    ).toEqual([2, 10])
  })

  test('moveRange moves a stretch of every track and markers later', () => {
    load(project([track('v')], [clip('v1', 'v', 0, 9)], [{ id: 'm', time: s(1), label: '' }]))
    expect(A.moveRange({ start: s(0), end: s(3) }, s(9))).toBe(true)
    const pieces = state()
      .project.events.toSorted((a, b) => a.start - b.start)
      .map((e) => [sec(e.start), sec(e.offset), sec(e.length)])
    expect(pieces).toEqual([
      [0, 3, 6],
      [6, 0, 3]
    ])
    expect(sec(state().project.markers[0].time)).toBe(7)
  })

  test('moveRange refuses a destination inside the range', () => {
    load(project([track('v')], [clip('v1', 'v', 0, 9)]))
    expect(A.moveRange({ start: s(2), end: s(5) }, s(3))).toBe(false)
  })
})

describe('clipboard', () => {
  test('paste with Auto Ripple makes room on the target track', () => {
    load(project([track('v')], [clip('a', 'v', 0, 2), clip('b', 'v', 2, 3)]), {
      selection: ['a'],
      cursor: s(2),
      options: { autoRipple: true }
    })
    A.copySelection()
    A.pasteAtCursor()
    expect(spans('v')).toEqual([
      [0, 2],
      [2, 4],
      [4, 7]
    ])
  })

  test('Paste Event Attributes moves keyframes to the same moment of each clip', () => {
    const keys = [
      { time: s(10), cx: 0.5, cy: 0.5, zoom: 1, rotation: 0, stretch: 1, ease: 'smooth' as const },
      { time: s(12), cx: 0.3, cy: 0.5, zoom: 2, rotation: 0, stretch: 1.5, ease: 'smooth' as const }
    ]
    load(
      project(
        [track('v')],
        [
          clip('src', 'v', 0, 4, { offsetSeconds: 10, panCrop: keys, gain: 0.5 }),
          clip('dst', 'v', 10, 4, { offsetSeconds: 30, rate: 2 })
        ]
      ),
      { selection: ['src'] }
    )
    A.copySelection()
    expect(A.pasteEventAttributes(['panCrop', 'gain'], ['dst'])).toBe(1)
    const dst = ev('dst')
    // 2 s after the source in-point = 2 timeline seconds = 4 source seconds at 2x.
    expect(dst.panCrop.map((k) => sec(k.time))).toEqual([30, 34])
    expect(dst.gain).toBe(0.5)
    expect(ev('src').panCrop).toBe(keys)
  })
})

describe('speed', () => {
  test('2x halves the length and Auto Ripple pulls the next clip in', () => {
    load(project([track('v')], [clip('a', 'v', 0, 4), clip('b', 'v', 4, 2)]), {
      media: [media('m', { duration: s(30) })],
      options: { autoRipple: true }
    })
    expect(A.setPlaybackRate(['a'], 2)).toBe(1)
    expect(spans('v')).toEqual([
      [0, 2],
      [2, 4]
    ])
    expect(ev('a').rate).toBe(2)
  })

  test('a slower rate never reads past the end of the media', () => {
    load(project([track('v')], [clip('a', 'v', 0, 4, { offsetSeconds: 8 })]), { media: [media('m', { duration: s(10) })] })
    A.setPlaybackRate(['a'], 0.5)
    // 2 s of media left at 0.5x = 4 s on the timeline.
    expect(sec(ev('a').length)).toBe(4)
  })

  test('stills and text cannot change speed', () => {
    load(project([track('v')], [clip('a', 'v', 0, 4)]), { media: [media('m', { kind: 'image', duration: 0 })] })
    expect(A.setPlaybackRate(['a'], 2)).toBe(0)
  })
})

describe('stretched pictures', () => {
  const stretched = { time: 0, cx: 0.5, cy: 0.5, zoom: 0.5, rotation: 0, stretch: 2, ease: 'smooth' as const }

  test('Fit Frame and quarter turns keep the stretch', () => {
    load(project([track('v')], [clip('a', 'v', 0, 4, { panCrop: [stretched] }), clip('b', 'v', 4, 4, { panCrop: [stretched] })]), {
      media: [media('m', { kind: 'image', duration: 0, width: 400, height: 300 })],
      selection: ['a']
    })
    A.reframeVideoEvents('fit')
    expect(ev('a').panCrop).toHaveLength(1)
    expect(ev('a').panCrop[0]).toMatchObject({ stretch: 2, zoom: 1, cx: 0.5, cy: 0.5 })
    expect(A.rotateEvents(['b'], 90)).toBe(1)
    expect(ev('b').panCrop[0].stretch).toBe(2)
    expect(ev('b').panCrop[0].rotation).toBe(-90)
  })

  test('Fit Frame on a picture with its own proportions removes the framing', () => {
    load(project([track('v')], [clip('a', 'v', 0, 4, { panCrop: [{ ...stretched, stretch: 1 }] })]), { selection: ['a'], media: [media('m')] })
    A.reframeVideoEvents('fit')
    expect(ev('a').panCrop).toEqual([])
  })
})

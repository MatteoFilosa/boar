import { describe, expect, test } from 'vitest'
import { alignWords, chunkWords } from '@/core/captions'
import { formatSrt, parseSrt } from '@/core/srt'
import { type MediaTranscript, longPauses, rangesForWords, wordFlag, wordsOnTimeline } from '@/core/transcript'
import * as A from '@/core/actions'
import { clip, ev, load, project, s, sec, spans, state, track } from './helpers'

const transcript = (...words: [string, number, number][]): MediaTranscript => ({
  language: 'en',
  model: 'test',
  words: words.map(([text, start, end]) => ({ text, start, end }))
})

describe('recognizer output', () => {
  test('word times come from the tokens that spell each word', () => {
    const words = alignWords({
      segments: [{ start: 0, end: 3, text: ' Benvenuti a tutti' }],
      tokens: [
        { start: 0.1, end: 0.3, text: ' Ben' },
        { start: 0.3, end: 0.5, text: 'ven' },
        { start: 0.5, end: 0.9, text: 'uti' },
        { start: 1.0, end: 1.1, text: ' a' },
        { start: 1.2, end: 1.8, text: ' tutti' }
      ]
    })
    expect(words).toEqual([
      { text: 'Benvenuti', start: 0.1, end: 0.9 },
      { text: 'a', start: 1.0, end: 1.1 },
      { text: 'tutti', start: 1.2, end: 1.8 }
    ])
  })

  test('when the tokens disagree with the phrase, times are shared out by length', () => {
    const words = alignWords({ segments: [{ start: 0, end: 4, text: 'one three' }], tokens: [{ start: 0, end: 1, text: 'two' }] })
    expect(words.map((w) => w.text)).toEqual(['one', 'three'])
    expect(words[0].start).toBe(0)
    expect(words[1].end).toBeCloseTo(4)
    expect(words[0].end).toBeCloseTo(words[1].start)
  })

  test('captions break at sentence ends, long pauses and the word limit', () => {
    const w = (text: string, start: number): { text: string; start: number; end: number } => ({ text, start, end: start + 0.3 })
    const chunks = chunkWords([w('Hi.', 0), w('this', 0.4), w('is', 0.8), w('long', 3), w('a', 3.4), w('b', 3.8), w('c', 4.2)], {
      maxChars: 40,
      maxWords: 2,
      maxGap: 1
    })
    expect(chunks.map((c) => c.text)).toEqual(['Hi.', 'this is', 'long a', 'b c'])
  })
})

test('SRT files survive a round trip', () => {
  const captions = [
    { start: 1.5, end: 3.25, text: 'Hello' },
    { start: 3661.001, end: 3662, text: 'Two\nlines' }
  ]
  const text = formatSrt(captions)
  expect(text).toContain('01:01:01,001 --> 01:01:02,000')
  expect(parseSrt(text.replace(/\n/g, '\r\n'))).toEqual(captions)
})

describe('transcript on the timeline', () => {
  const t = { m: transcript(['one', 1, 1.5], ['two', 2, 2.5], ['three', 3, 3.5], ['four', 4, 4.5]) }

  test('a word belongs to the clip that plays its middle', () => {
    // The file from 0 to 2.3 s, then from 3.2 s at 10 s on the timeline.
    const events = [clip('a', 'v', 0, 2.3), clip('b', 'v', 10, 2, { offsetSeconds: 3.2 })]
    const words = wordsOnTimeline(events, t)
    expect(words.map((w) => [w.text, w.eventId, sec(w.start), sec(w.end)])).toEqual([
      ['one', 'a', 1, 1.5],
      ['two', 'a', 2, 2.3],
      ['three', 'b', 10, 10.3],
      ['four', 'b', 10.8, 11.3]
    ])
  })

  test('words follow the playback rate', () => {
    const words = wordsOnTimeline([clip('a', 'v', 0, 3, { rate: 2 })], t)
    expect(words.map((w) => [w.text, sec(w.start)])).toEqual([
      ['one', 0.5],
      ['two', 1],
      ['three', 1.5],
      ['four', 2]
    ])
  })

  test('deleting words cuts each run with the pause after it', () => {
    const words = wordsOnTimeline([clip('a', 'v', 0, 6)], t)
    const ranges = rangesForWords(words, new Set([1, 2]))
    expect(ranges.map((r) => [sec(r.start), sec(r.end)])).toEqual([[1.97, 3.95]])
  })

  test('fillers, repeats and maybe-words are flagged', () => {
    const words = wordsOnTimeline([clip('a', 'v', 0, 9)], {
      m: transcript(['Ehm,', 0, 0.3], ['che', 1, 1.2], ['che', 1.3, 1.5], ['tipo', 2, 2.3], ['casa', 3, 3.4])
    })
    expect(words.map((_, i) => wordFlag(words, i))).toEqual(['filler', 'repeat', null, 'maybe', null])
  })

  test('long pauses are shortened to the kept length', () => {
    const words = wordsOnTimeline([clip('a', 'v', 0, 9)], { m: transcript(['a', 0, 1], ['b', 3, 4], ['c', 4.2, 5]) })
    expect(longPauses(words, 1, 0.4).map((p) => [sec(p.start), sec(p.end)])).toEqual([[1.2, 2.8]])
  })

  test('Delete in the Transcript cuts the clips and closes the gap', () => {
    load(project([track('v')], [clip('a', 'v', 0, 6)]), { transcripts: t })
    const words = wordsOnTimeline(state().project.events, t)
    expect(A.deleteWords(words, new Set([1]))).toBe(1)
    const after = wordsOnTimeline(state().project.events, t).map((w) => w.text)
    expect(after).toEqual(['one', 'three', 'four'])
  })
})

describe('captions follow the clips', () => {
  const t = { m: transcript(['hello', 1, 1.5], ['big', 2, 2.5], ['world', 3, 3.5]) }
  const caption = (): ReturnType<typeof clip> =>
    clip('cap', 'c', 1, 3, {
      mediaId: '',
      text: {
        ...({} as NonNullable<ReturnType<typeof clip>['text']>),
        text: 'hello big world',
        words: [
          { text: 'hello', start: 0, end: 0.5, src: ['m', 0] },
          { text: 'big', start: 1, end: 1.5, src: ['m', 1] },
          { text: 'world', start: 2, end: 2.5, src: ['m', 2] }
        ]
      }
    })

  test('a word cut out of the clip leaves the caption, which closes up', () => {
    load(project([track('c'), track('v')], [caption(), clip('a', 'v', 0, 6)]), { transcripts: t })
    A.cutRanges(['a'], [{ start: s(1.8), end: s(2.8) }], 'remove')
    const cap = ev('cap')
    expect(cap.text?.text).toBe('hello world')
    expect([sec(cap.start), sec(cap.start + cap.length)]).toEqual([1, 3])
    expect(cap.text?.words?.map((w) => [w.text, w.start, w.end])).toEqual([
      ['hello', 0, 0.5],
      ['world', 1, 1.5]
    ])
  })

  test('moving the clip moves the caption', () => {
    load(project([track('c'), track('v')], [caption(), clip('a', 'v', 0, 6)]), { transcripts: t })
    A.commit((d) => void (d.events.find((e) => e.id === 'a')!.start = s(10)))
    expect(spans('c')).toEqual([[11, 14]])
  })

  test('deleting the clip deletes the caption', () => {
    load(project([track('c'), track('v')], [caption(), clip('a', 'v', 0, 6)]), { transcripts: t })
    A.commit((d) => void (d.events = d.events.filter((e) => e.id !== 'a')))
    expect(spans('c')).toEqual([])
  })

  test('with the option off, captions stay where they are', () => {
    load(project([track('c'), track('v')], [caption(), clip('a', 'v', 0, 6)]), { transcripts: t, options: { linkedCaptions: false } })
    A.commit((d) => void (d.events.find((e) => e.id === 'a')!.start = s(10)))
    expect(spans('c')).toEqual([[1, 4]])
  })
})

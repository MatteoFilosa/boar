import { describe, expect, test } from 'vitest'
import * as A from '@/core/actions'
import {
  breakLines,
  captionTranslations,
  plainCaption,
  sentenceGroups,
  splitTranslation,
  translationRoute
} from '@/core/translation'
import type { TimelineEvent } from '@/core/types'
import { clip, ev, load, project, state, track } from './helpers'

const PAIRS = ['it-en', 'it-fr', 'en-fr', 'en-de', 'fr-en', 'mul-en']

describe('translation route', () => {
  test('a pair of its own, else through English, else the multilingual model', () => {
    expect(translationRoute('it', 'fr', PAIRS)).toEqual(['it-fr'])
    expect(translationRoute('it', 'de', PAIRS)).toEqual(['it-en', 'en-de'])
    expect(translationRoute('pt', 'en', PAIRS)).toEqual(['mul-en'])
    expect(translationRoute('pt', 'fr', PAIRS)).toEqual(['mul-en', 'en-fr'])
    expect(translationRoute('en', 'en', PAIRS)).toEqual([])
    expect(translationRoute('fr', 'it', PAIRS)).toBeNull()
    expect(translationRoute('pt', 'en', ['it-en'])).toBeNull()
  })
})

describe('caption sentences', () => {
  const line = (text: string, start: number, end = start + 1): { text: string; start: number; end: number } => ({ text, start, end })

  test('a sentence ends at its punctuation or at a pause', () => {
    const lines = [line('Ciao a tutti,', 0), line('oggi parliamo di video.', 1), line('Poi', 2), line('dopo una pausa', 5), line('', 6), line('fine', 6.5)]
    expect(sentenceGroups(lines)).toEqual([[0, 1], [2], [3, 5]])
  })

  test('long runs are cut at a caption', () => {
    const long = 'parola '.repeat(40).trim()
    const groups = sentenceGroups([line(long, 0), line(long, 1), line(long, 2)])
    expect(groups.length).toBeGreaterThan(1)
  })

  test('a translation is shared by length, at least a word each, cut after punctuation', () => {
    expect(splitTranslation('Hi everyone, today we talk about video.', [13, 23])).toEqual(['Hi everyone,', 'today we talk about video.'])
    expect(splitTranslation('One two', [10, 10, 10])).toEqual(['One', '', 'two'])
    expect(splitTranslation('a b c d e f', [1, 1, 1])).toEqual(['a b', 'c d', 'e f'])
  })

  test('the text read for translation leaves out emphasis, emoji and line breaks', () => {
    expect(plainCaption('Che *bella*\ngiornata ☀️')).toBe('Che bella giornata')
  })

  test('each caption keeps its lines and the emoji at its end', () => {
    const originals = ['Che bella giornata ☀️', 'oggi andiamo\nal mare.']
    const groups = [[0, 1]]
    const out = captionTranslations(originals, groups, ['What a beautiful day today we go to the sea.'])
    expect(out[0].endsWith(' ☀️')).toBe(true)
    expect(captionTranslations(['bello😀'], [[0]], ['nice'])).toEqual(['nice😀'])
    expect(out[1].split('\n')).toHaveLength(2)
    expect(out.join(' ').replace(/\n/g, ' ').replace(' ☀️', '')).toBe('What a beautiful day today we go to the sea.')
    expect(breakLines('one two three four', 2)).toBe('one two\nthree four')
  })
})

describe('translated caption tracks', () => {
  const caption = (id: string, start: number, text: string): TimelineEvent =>
    clip(id, 'cap', start, 2, {
      mediaId: '',
      text: {
        ...({} as NonNullable<TimelineEvent['text']>),
        text,
        words: text.split(' ').map((w, i) => ({ text: w, start: i * 0.5, end: i * 0.5 + 0.4, src: ['m', i] as [string, number] }))
      }
    })

  test('a new track above, captions copied with the translated words, the original muted; again replaces it', () => {
    load(project([{ ...track('cap'), name: 'Captions' }, track('v')], [caption('c1', 0, 'ciao a tutti'), caption('c2', 2, 'come va'), clip('a', 'v', 0, 4)]))
    const id = A.addTranslatedCaptions('cap', ['c1', 'c2'], ['hello everyone', ''], 'en')!
    const tracks = state().project.tracks
    expect(tracks.map((t) => [t.name, t.muted])).toEqual([
      ['Captions (EN)', false],
      ['Captions', true],
      ['v', false]
    ])
    const made = state().project.events.filter((e) => e.trackId === id)
    expect(made).toHaveLength(1)
    expect(made[0].start).toBe(ev('c1').start)
    expect(made[0].text?.text).toBe('hello everyone')
    // Two words over the span of three: shared by length, no link to the transcript.
    expect(made[0].text?.words?.map((w) => w.text)).toEqual(['hello', 'everyone'])
    expect(made[0].text?.words?.every((w) => !w.src)).toBe(true)
    expect(made[0].text?.words?.[0].start).toBe(0)

    // French: the English track is muted too; English again replaces its captions.
    const fr = A.addTranslatedCaptions('cap', ['c1', 'c2'], ['bonjour à tous', 'ça va'], 'fr')!
    expect(state().project.tracks.find((t) => t.id === fr)?.muted).toBe(false)
    expect(state().project.tracks.find((t) => t.id === id)?.muted).toBe(true)
    A.addTranslatedCaptions('cap', ['c1', 'c2'], ['hi all', 'how are you'], 'en')
    expect(state().project.tracks.filter((t) => t.name === 'Captions (EN)')).toHaveLength(1)
    expect(state().project.events.filter((e) => e.trackId === id).map((e) => e.text?.text)).toEqual(['hi all', 'how are you'])
    A.undo()
    expect(state().project.events.filter((e) => e.trackId === id).map((e) => e.text?.text)).toEqual(['hello everyone'])
  })
})

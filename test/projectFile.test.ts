import { describe, expect, test } from 'vitest'
import { parseProject, serializeProject } from '@/core/projectFile'
import { DEFAULT_FADE_CURVE } from '@/core/fades'
import early from './fixtures/early-project.boar?raw'
import { clip, media, project, s, track } from './helpers'

describe('projects saved by earlier versions', () => {
  const { project: p, media: files, transcripts, shorts } = parseProject(early)

  test('fields added since are filled with their defaults', () => {
    expect(p.settings.sampleRate).toBe(48000)
    const e = p.events.find((x) => x.id === 'e1')!
    expect(e).toMatchObject({
      fadeIn: 0,
      fadeOut: 0,
      fadeInCurve: DEFAULT_FADE_CURVE,
      fadeOutCurve: DEFAULT_FADE_CURVE,
      rate: 1,
      gain: 1,
      panCrop: [],
      mask: null,
      text: null,
      envelope: [],
      transition: null,
      transitionOut: null
    })
    expect(p.events.find((x) => x.id === 'e2')).toMatchObject({ fadeIn: 23520000, gain: 0.8, fx: [] })
  })

  test('text keeps what it had and gets the rest of a title style', () => {
    const text = p.events.find((x) => x.id === 'e3')!.text!
    expect(text.text).toBe('Hello')
    expect(text.size).toBe(120)
    expect(text.font).toBeTruthy()
    expect(text.wordStyle).toBeTruthy()
  })

  test('the chroma key hue becomes a key color', () => {
    const fx = p.events.find((x) => x.id === 'e1')!.fx[0]
    expect(fx.params.color).toBe(0x00ff00)
    expect(fx.params.hue).toBeUndefined()
    expect(fx.params.tolerance).toBe(0.3)
  })

  test('damaged entries are dropped, the rest is kept', () => {
    expect(files.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(files[1].reverseOf).toBeUndefined()
    expect(transcripts.m1.words).toEqual([{ text: 'ciao', start: 1, end: 1.4 }])
    expect(shorts.map((c) => c.id)).toEqual(['s1'])
  })
})

describe('saving', () => {
  test('a saved project opens as the same project', () => {
    const p = project([track('v')], [clip('a', 'v', 1, 4, { rate: 1.5, fadeOutCurve: 'smooth', transitionOut: { type: 'flash', duration: s(1) } })], [
      { id: 'k', time: s(2), label: 'x' }
    ])
    const json = serializeProject(p, [media('m')], { m: { language: 'en', model: 'base', words: [{ text: 'hi', start: 1, end: 2 }] } })
    const back = parseProject(json)
    expect(back.project).toEqual(p)
    expect(back.media).toEqual([{ id: 'm', name: 'm.mp4', kind: 'video', path: '/media/m.mp4', size: 1000 }])
    expect(back.transcripts.m.words).toHaveLength(1)
  })

  test('a file that failed to load is left out unless the timeline uses it', () => {
    const p = project([track('v')], [clip('a', 'v', 0, 4, { mediaId: 'used' })])
    const json = serializeProject(p, [media('used', { status: 'error' }), media('unused', { status: 'error' }), media('fine')])
    expect(parseProject(json).media.map((m) => m.id)).toEqual(['used', 'fine'])
  })

  test('Pan/Crop keyframes saved before stretch keep the picture\'s own proportions', () => {
    const key = { time: 0, cx: 0.4, cy: 0.5, zoom: 2, rotation: 0, stretch: 1.5, ease: 'smooth' as const }
    const p = project([track('v')], [clip('a', 'v', 0, 4, { panCrop: [key] })])
    const json = serializeProject(p, [media('m')])
    expect(parseProject(json).project.events[0].panCrop).toEqual([key])
    const data = JSON.parse(json)
    delete data.project.events[0].panCrop[0].stretch
    expect(parseProject(JSON.stringify(data)).project.events[0].panCrop).toEqual([{ ...key, stretch: 1 }])
  })

  test('the early fixture survives a save and reopen unchanged', () => {
    const first = parseProject(early)
    const files = first.media.map((m) => media(m.id, { name: m.name, path: m.path, size: m.size }))
    const again = parseProject(serializeProject(first.project, files, first.transcripts, first.shorts))
    expect(again.project).toEqual(first.project)
    expect(again.transcripts).toEqual(first.transcripts)
    expect(again.shorts).toEqual(first.shorts)
  })
})

describe('refused files', () => {
  test('not JSON', () => expect(() => parseProject('{oops')).toThrow('not a valid project file'))
  test('JSON but not a project', () => expect(() => parseProject('{"tracks": []}')).toThrow('not a Boar project'))
  test('from a newer Boar', () => {
    const newer = JSON.stringify({ app: 'Boar', version: 2, project: { tracks: [], events: [] } })
    expect(() => parseProject(newer)).toThrow('newer Boar')
  })
})

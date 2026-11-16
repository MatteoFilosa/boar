import { describe, expect, test } from 'vitest'
import * as A from '@/core/actions'
import { type ClipTrack, makeClipboard, mapTracks } from '@/core/clipboard'
import type { MediaTranscript } from '@/core/transcript'
import type { TimelineEvent } from '@/core/types'
import { clip, ev, load, media, project, s, sec, spans, state, track } from './helpers'

const transcript = (...words: string[]): MediaTranscript => ({
  language: 'it',
  model: 'small',
  words: words.map((text, i) => ({ text, start: i, end: i + 0.5 }))
})

const caption = (id: string, trackId: string, start: number, mediaId: string): TimelineEvent =>
  clip(id, trackId, start, 2, {
    mediaId: '',
    text: {
      ...({} as NonNullable<TimelineEvent['text']>),
      text: 'ciao mondo',
      words: [
        { text: 'ciao', start: 0, end: 0.5, src: [mediaId, 0] },
        { text: 'mondo', start: 1, end: 1.5, src: [mediaId, 1] }
      ]
    }
  })

/** Copies events in one project, then opens another one in the same store (as another window would hold it). */
function copyFrom(events: TimelineEvent[], tracks = [track('cap'), track('v')]): ReturnType<typeof A.clipboardContent> {
  load(project(tracks, events), {
    media: [media('m', { path: '/clips/talk.mp4' })],
    transcripts: { m: transcript('ciao', 'mondo') },
    selection: events.map((e) => e.id)
  })
  A.copySelection()
  return A.clipboardContent()
}

describe('pasting into another project', () => {
  test('brings the file, its transcript and the caption links along, on new tracks in the same order', () => {
    copyFrom([caption('c1', 'cap', 0, 'm'), clip('v1', 'v', 0, 4)], [{ ...track('cap'), name: 'Captions' }, track('v')])
    // The other window: its own file on a full track.
    load(project([track('main')], [clip('other', 'main', 0, 20, { mediaId: 'o' })]), { media: [media('o')], cursor: s(5) })
    const { ids, added } = A.pasteClipboard()
    expect(ids).toHaveLength(2)
    expect(added.map((m) => [m.id, m.path, m.status])).toEqual([['m', '/clips/talk.mp4', 'analyzing']])
    expect(state().media.map((m) => m.id)).toEqual(['o', 'm'])
    expect(state().transcripts.m?.words.map((w) => w.text)).toEqual(['ciao', 'mondo'])
    const [cap, video] = ids.map(ev)
    expect(video.mediaId).toBe('m')
    expect(cap.text?.words?.map((w) => w.src)).toEqual([
      ['m', 0],
      ['m', 1]
    ])
    // 'main' is busy at 5 s: two new tracks, above it (video in front), captions on top, named like the source ones.
    const tracks = state().project.tracks
    expect(tracks.map((t) => t.id === 'main' || t.name)).toEqual(['Captions', 'v', true])
    expect(tracks.findIndex((t) => t.id === cap.trackId)).toBe(0)
    expect(tracks.findIndex((t) => t.id === video.trackId)).toBe(1)
    expect([sec(cap.start), sec(video.start)]).toEqual([5, 5])
    // One undo step for the events.
    A.undo()
    expect(state().project.events.map((e) => e.id)).toEqual(['other'])
  })

  test('reuses the same file already there and a free track of the same kind', () => {
    copyFrom([clip('v1', 'v', 2, 3)])
    load(project([track('a'), track('b')], [clip('busy', 'a', 0, 10, { mediaId: 'x' })]), {
      media: [media('x'), media('x2', { path: '/clips/talk.mp4' })],
      cursor: s(1)
    })
    const { ids, added } = A.pasteClipboard()
    expect(added).toEqual([])
    expect(ev(ids[0]).mediaId).toBe('x2')
    expect(spans('b')).toEqual([[1, 4]])
  })

  test('caption words lose their link when the transcript there differs', () => {
    copyFrom([caption('c1', 'cap', 0, 'm')])
    load(project([track('t')], []), {
      media: [media('same', { path: '/clips/talk.mp4' })],
      transcripts: { same: transcript('hello', 'world', 'again') }
    })
    const { ids } = A.pasteClipboard()
    expect(ev(ids[0]).text?.words?.map((w) => w.src)).toEqual([undefined, undefined])
    expect(state().transcripts.same?.words).toHaveLength(3)
  })

  test('events whose file has no path are left out', () => {
    load(project([track('v')], [clip('v1', 'v', 0, 2), clip('t1', 'v', 3, 2, { mediaId: '', text: {} as TimelineEvent['text'] })]), {
      media: [media('m', { path: '' })],
      selection: ['v1', 't1']
    })
    A.copySelection()
    load(project([track('v')], []), { media: [] })
    const { ids } = A.pasteClipboard()
    expect(ids.map((id) => ev(id).mediaId)).toEqual([''])
    expect(state().status).toMatch(/1 left out/)
  })

  test('in the same project the events go back to their own tracks', () => {
    load(project([track('a'), track('b')], [clip('x', 'b', 0, 2)]), { selection: ['x'], cursor: s(4) })
    A.copySelection()
    const { ids, added } = A.pasteClipboard()
    expect(added).toEqual([])
    expect(ev(ids[0]).trackId).toBe('b')
  })

  test('the clipboard lists the originals of reversed copies and the files captions point to', () => {
    load(project([track('v')], [clip('r', 'v', 0, 2, { mediaId: 'rev' }), caption('c', 'v', 4, 'm')]), {
      media: [media('m'), media('rev', { reverseOf: { mediaId: 'orig', start: 0, end: s(2) } }), media('orig'), media('unused')]
    })
    const p = state()
    const copied = makeClipboard(p.project, p.media, p.transcripts, ['r', 'c'])
    expect(copied.media.map((m) => m.id).sort()).toEqual(['m', 'orig', 'rev'])
  })
})

describe('mapTracks', () => {
  const clipTracks: ClipTrack[] = [
    { id: 's1', kind: 'video', name: 'Titles', index: 0 },
    { id: 's2', kind: 'video', name: 'Video', index: 2 }
  ]

  test('dropped on a track: the grabbed track goes there and the others keep their distance', () => {
    const tracks = [track('t0'), track('t1'), track('t2'), track('t3', 'audio')]
    const out = mapTracks(clipTracks, tracks, () => track('new'), () => true, { trackId: 's1', to: 't0' })
    expect([out.get('s1'), out.get('s2')]).toEqual(['t0', 't2'])
  })

  test('a busy or missing neighbour becomes a new track below the grabbed one', () => {
    const tracks = [track('t0'), track('t1')]
    let n = 0
    const out = mapTracks(clipTracks, tracks, (kind, name) => ({ ...track(`n${++n}`, kind), name }), (id) => id !== 't1', {
      trackId: 's1',
      to: 't1'
    })
    expect(out.get('s1')).toBe('t1')
    expect(out.get('s2')).toBe('t0')
    const plain = [track('t0')]
    const out2 = mapTracks(clipTracks, plain, (kind, name) => ({ ...track(`n${++n}`, kind), name }), () => false, { trackId: 's2', to: 't0' })
    expect(out2.get('s2')).toBe('t0')
    expect(plain.map((t) => t.id)).toEqual([`n${n}`, 't0'])
    expect(plain[0].name).toBe('Titles')
  })
})

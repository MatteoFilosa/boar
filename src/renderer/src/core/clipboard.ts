import type { MediaItem, Project, TimelineEvent, Track, TrackKind } from './types'
import type { Flicks } from './time'
import type { MediaTranscript } from './transcript'
import { savedMedia, type SavedMedia } from './projectFile'
import { eventEnd } from './timeline'

// Copied events travel between editor windows (each with its own project)
// through the main process, so they carry what the events need from their
// project: the files they play, listed like a project file does, the
// transcripts their linked captions point into, and the tracks they sat on.

export interface ClipTrack {
  id: string
  kind: TrackKind
  name: string
  /** Position in the source project, top to bottom (dropped events keep their distance). */
  index: number
}

export interface EventClipboard {
  events: TimelineEvent[]
  /** The tracks of the events, top to bottom. */
  tracks: ClipTrack[]
  /** Files the events play, plus files only their caption words or reversed copies point to. */
  media: SavedMedia[]
  /** Transcripts of those files by media id. */
  transcripts: Record<string, MediaTranscript>
}

/** Media ids an event needs: its own file and the transcripts its caption words come from. */
function referencedMedia(e: TimelineEvent): string[] {
  const ids = e.mediaId ? [e.mediaId] : []
  for (const w of e.text?.words ?? []) if (w.src) ids.push(w.src[0])
  return ids
}

/** The events with these ids, as a clipboard any window can paste. */
export function makeClipboard(
  project: Project,
  media: readonly MediaItem[],
  transcripts: Record<string, MediaTranscript>,
  ids: Iterable<string>
): EventClipboard {
  const wanted = new Set(ids)
  const events = project.events.filter((e) => wanted.has(e.id)).map((e) => structuredClone(e))
  const used = new Set(events.flatMap(referencedMedia))
  for (const m of media) if (used.has(m.id) && m.reverseOf) used.add(m.reverseOf.mediaId)
  const trackIds = new Set(events.map((e) => e.trackId))
  return {
    events,
    tracks: project.tracks.flatMap((t, index) => (trackIds.has(t.id) ? [{ id: t.id, kind: t.kind, name: t.name, index }] : [])),
    media: media.filter((m) => used.has(m.id)).map(savedMedia),
    transcripts: Object.fromEntries([...used].filter((id) => transcripts[id]).map((id) => [id, structuredClone(transcripts[id])]))
  }
}

/** Earliest start and length of the copied events together. */
export function clipSpan(clip: EventClipboard): { start: Flicks; length: Flicks } {
  if (clip.events.length === 0) return { start: 0, length: 0 }
  const start = Math.min(...clip.events.map((e) => e.start))
  return { start, length: Math.max(...clip.events.map(eventEnd)) - start }
}

type TargetMedia = Pick<MediaItem, 'id' | 'path' | 'convertedFrom' | 'status'>

export interface MediaPlan {
  /** Clipboard media id → media id in the project the events are pasted into. */
  ids: Map<string, string>
  /** Files to add to Project Media, with the ids they get. */
  add: SavedMedia[]
  /** Transcripts the project gets (it had none for those files), by its media ids. */
  transcripts: Record<string, MediaTranscript>
  /** Clipboard media whose transcript there differs: caption words lose their link to it. */
  unlinked: Set<string>
}

const sameWords = (a: MediaTranscript, b: MediaTranscript): boolean =>
  a.words.length === b.words.length && a.words.every((w, i) => w.text === b.words[i].text)

/**
 * Which files of the project the copied events play. The same file (by id
 * in the same project, else by path) is reused; files the events play that
 * the project lacks are added; files only caption words or reversed copies
 * point to are linked when the project has them, never added.
 */
export function planMedia(
  clip: EventClipboard,
  media: readonly TargetMedia[],
  transcripts: Record<string, MediaTranscript>,
  newId: () => string
): MediaPlan {
  const played = new Set(clip.events.map((e) => e.mediaId).filter(Boolean))
  const ids = new Map<string, string>()
  const add: SavedMedia[] = []
  const taken = new Set(media.map((m) => m.id))
  for (const m of clip.media) {
    const same = media.find((t) => t.id === m.id)
    if (same && (same.path === m.path || !m.path)) {
      ids.set(m.id, m.id)
      continue
    }
    if (!m.path) continue
    const existing = media.find(
      (t) => t.status !== 'error' && (t.path === m.path || (!!m.convertedFrom && t.convertedFrom === m.convertedFrom))
    )
    if (existing) {
      ids.set(m.id, existing.id)
      continue
    }
    if (!played.has(m.id)) continue
    const id = taken.has(m.id) ? newId() : m.id
    taken.add(id)
    ids.set(m.id, id)
    add.push({ ...m, id })
  }
  for (const m of add) {
    if (!m.reverseOf) continue
    const original = ids.get(m.reverseOf.mediaId)
    if (original) m.reverseOf = { ...m.reverseOf, mediaId: original }
    else delete m.reverseOf
  }
  const plan: MediaPlan = { ids, add, transcripts: {}, unlinked: new Set() }
  for (const [from, to] of ids) {
    const copied = clip.transcripts[from]
    if (!copied) continue
    const there = transcripts[to]
    if (!there) plan.transcripts[to] = structuredClone(copied)
    else if (!sameWords(there, copied)) plan.unlinked.add(from)
  }
  return plan
}

/**
 * The copied events with the project's media ids (without their track and
 * place yet). Events whose file the project cannot open are left out.
 */
export function plannedEvents(clip: EventClipboard, plan: MediaPlan): { events: TimelineEvent[]; skipped: number } {
  const events: TimelineEvent[] = []
  for (const source of clip.events) {
    const mediaId = source.mediaId ? plan.ids.get(source.mediaId) : ''
    if (mediaId === undefined) continue
    const e = structuredClone(source)
    e.mediaId = mediaId
    if (e.text?.words) {
      e.text.words = e.text.words.map((w) => {
        if (!w.src) return w
        const to = plan.ids.get(w.src[0])
        const { src, ...word } = w
        return to && !plan.unlinked.has(src[0]) ? { ...word, src: [to, src[1]] } : word
      })
    }
    events.push(e)
  }
  return { events, skipped: clip.events.length - events.length }
}

/**
 * Tracks of the project for the copied events' tracks (`tracks` is changed:
 * missing tracks are inserted). In the same project the events go back to
 * their own tracks. Elsewhere, or dropped on a track: the grabbed event's
 * track goes to `anchor.to` and the others keep their distance, else a
 * track of the same kind and name, else any track of that kind, else a new
 * track named like the source one, placed to keep the copied order.
 * `isClear(trackId)`: nothing on that track where the events land (tracks
 * found by name or kind must be clear; a track the user chose need not be).
 */
export function mapTracks(
  clipTracks: readonly ClipTrack[],
  tracks: Track[],
  newTrack: (kind: TrackKind, name: string) => Track,
  isClear: (trackId: string) => boolean,
  anchor?: { trackId: string; to: string }
): Map<string, string> {
  const out = new Map<string, string>()
  const used = new Set<string>()
  const take = (from: ClipTrack, t: Track): void => {
    out.set(from.id, t.id)
    used.add(t.id)
  }
  const free = (t: Track | undefined, kind: TrackKind): t is Track => !!t && t.kind === kind && !used.has(t.id)
  const anchorTrack = anchor ? clipTracks.find((c) => c.id === anchor.trackId) : undefined
  const anchorAt = anchor ? tracks.findIndex((t) => t.id === anchor.to) : -1
  if (anchor && anchorTrack && anchorAt >= 0) {
    const first = tracks[anchorAt]
    if (free(first, anchorTrack.kind)) take(anchorTrack, first)
    for (const c of clipTracks) {
      if (out.has(c.id)) continue
      const t = tracks[anchorAt + c.index - anchorTrack.index]
      if (free(t, c.kind) && isClear(t.id)) take(c, t)
    }
  } else if (!anchor) {
    for (const c of clipTracks) {
      const t = tracks.find((o) => o.id === c.id)
      if (free(t, c.kind)) take(c, t)
    }
  }
  for (const c of clipTracks) {
    if (out.has(c.id)) continue
    const t = c.name ? tracks.find((o) => free(o, c.kind) && o.name === c.name && isClear(o.id)) : undefined
    if (t) take(c, t)
  }
  for (const c of clipTracks) {
    if (out.has(c.id)) continue
    const t = tracks.find((o) => free(o, c.kind) && isClear(o.id))
    if (t) take(c, t)
  }
  // New tracks: just above the track of the next copied track of that kind,
  // else just below the previous one's, else video in front and audio last.
  clipTracks.forEach((c, i) => {
    if (out.has(c.id)) return
    const track = newTrack(c.kind, c.name)
    const next = clipTracks.slice(i + 1).find((o) => o.kind === c.kind && out.has(o.id))
    const prev = clipTracks.slice(0, i).findLast((o) => o.kind === c.kind && out.has(o.id))
    let at: number
    if (next) at = tracks.findIndex((t) => t.id === out.get(next.id))
    else if (prev) at = tracks.findIndex((t) => t.id === out.get(prev.id)) + 1
    else if (c.kind === 'video') at = Math.max(0, tracks.findIndex((t) => t.kind === 'video'))
    else at = tracks.length
    tracks.splice(at, 0, track)
    take(c, track)
  })
  return out
}

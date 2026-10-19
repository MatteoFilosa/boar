import { secondsToFlicks, type Flicks } from '@/core/time'
import type { MediaItem, Project, TimelineEvent, Track, TrackKind } from '@/core/types'
import type { MediaTranscript } from '@/core/transcript'
import { DEFAULT_FADE_CURVE } from '@/core/fades'
import { type EditorOptions, useEditor } from '@/core/store'

/** Seconds to flicks. */
export const s = secondsToFlicks

/** Flicks to seconds, rounded to the microsecond (readable assertions). */
export const sec = (t: Flicks): number => Math.round((t / 705_600_000) * 1e6) / 1e6

export const FPS30 = { num: 30, den: 1 }

export function track(id: string, kind: TrackKind = 'video'): Track {
  return { id, kind, name: id, color: 0, muted: false, solo: false, level: 1, volumeDb: 0, pan: 0, height: 80 }
}

/** A media event; times in seconds. */
export function clip(
  id: string,
  trackId: string,
  start: number,
  length: number,
  patch: Partial<TimelineEvent> & { offsetSeconds?: number } = {}
): TimelineEvent {
  const { offsetSeconds = 0, ...rest } = patch
  return {
    id,
    trackId,
    mediaId: 'm',
    kind: 'video',
    start: s(start),
    length: s(length),
    offset: s(offsetSeconds),
    fadeIn: 0,
    fadeOut: 0,
    fadeInCurve: DEFAULT_FADE_CURVE,
    fadeOutCurve: DEFAULT_FADE_CURVE,
    rate: 1,
    groupId: null,
    gain: 1,
    panCrop: [],
    text: null,
    shape: null,
    mask: null,
    fx: [],
    envelope: [],
    transition: null,
    transitionOut: null,
    ...rest
  }
}

export function project(tracks: Track[], events: TimelineEvent[], markers: Project['markers'] = []): Project {
  return { settings: { width: 1920, height: 1080, frameRate: FPS30, sampleRate: 48000 }, tracks, events, markers }
}

export function media(id: string, patch: Partial<MediaItem> = {}): MediaItem {
  return {
    id,
    name: `${id}.mp4`,
    kind: 'video',
    file: null,
    url: '',
    path: `/media/${id}.mp4`,
    size: 1000,
    status: 'ready',
    error: '',
    duration: s(60),
    hasVideo: true,
    hasAudio: true,
    width: 1920,
    height: 1080,
    fps: 30,
    videoCodec: 'avc1.640028',
    audioCodec: 'mp4a.40.2',
    sampleRate: 48000,
    channels: 2,
    poster: '',
    ...patch
  }
}

/** Puts a project in the editor store with a fresh history (30 fps, quantize on, Auto Ripple off). */
export function load(
  p: Project,
  extra: { media?: MediaItem[]; transcripts?: Record<string, MediaTranscript>; options?: Partial<EditorOptions>; selection?: string[]; cursor?: Flicks } = {}
): void {
  const { options } = useEditor.getState()
  useEditor.setState({
    project: p,
    savedProject: p,
    past: [],
    future: [],
    media: extra.media ?? [media('m')],
    transcripts: extra.transcripts ?? {},
    selection: extra.selection ?? [],
    selectedTrackId: null,
    timeSelection: null,
    cursor: extra.cursor ?? 0,
    options: { ...options, quantize: true, autoRipple: false, rippleMode: 'tracks', linkedCaptions: true, ...extra.options }
  })
}

export const state = useEditor.getState

/** Event by id in the current project (throws when missing, for short assertions). */
export function ev(id: string): TimelineEvent {
  const e = state().project.events.find((x) => x.id === id)
  if (!e) throw new Error(`no event ${id}`)
  return e
}

/** Events of a track sorted by start, as [start, end] in seconds. */
export function spans(trackId: string): [number, number][] {
  return state()
    .project.events.filter((e) => e.trackId === trackId)
    .sort((a, b) => a.start - b.start)
    .map((e) => [sec(e.start), sec(e.start + e.length)])
}

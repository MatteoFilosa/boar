import type { Flicks, FrameRate } from './time'
import type { PanCropKey } from './pancrop'
import type { TextContent } from './text'
import type { EventMask } from './mask'
import type { EventFx } from './fx'
import type { EventTransition } from './transitions'
import type { FadeCurve } from './fades'

export type TrackKind = 'video' | 'audio'
export type MediaKind = 'video' | 'audio' | 'image'

export interface ProjectSettings {
  width: number
  height: number
  frameRate: FrameRate
  sampleRate: number
}

export interface Track {
  id: string
  kind: TrackKind
  name: string
  /** Index into TRACK_COLORS. */
  color: number
  muted: boolean
  solo: boolean
  /** Video composite level, 0..1. */
  level: number
  /** Audio volume in dB. */
  volumeDb: number
  /** Audio pan, -1 (left) .. 1 (right). */
  pan: number
  height: number
}

/** A point of an event's volume envelope. `time` is source time, like Pan/Crop keys. */
export interface VolumePoint {
  time: Flicks
  /** Linear gain multiplier (1 = unchanged). */
  gain: number
}

/** A clip placed on a track (an "event"). */
export interface TimelineEvent {
  id: string
  trackId: string
  mediaId: string
  kind: TrackKind
  /** Position on the timeline. */
  start: Flicks
  length: Flicks
  /** Source in-point: how far into the media the event begins. */
  offset: Flicks
  fadeIn: Flicks
  fadeOut: Flicks
  fadeInCurve: FadeCurve
  fadeOutCurve: FadeCurve
  /**
   * Playback rate (Ctrl+drag an edge): source time advances `rate` times as
   * fast as the timeline. Always 1 for stills and text.
   */
  rate: number
  /** Events sharing a group move and trim together (a video file's picture and sound). */
  groupId: string | null
  /** Video opacity / audio gain multiplier. */
  gain: number
  /** Event Pan/Crop keyframes (video only). Empty = source fitted in the frame. */
  panCrop: PanCropKey[]
  /** Set for generated text events, which have no media file (mediaId is ''). */
  text: TextContent | null
  /** Shape mask (video events). */
  mask: EventMask | null
  /** Event FX chain (video effects on video events, audio effects on audio events). */
  fx: EventFx[]
  /** Volume envelope (audio events; written by Auto Ducking). Empty = flat. */
  envelope: VolumePoint[]
  /** Transition at the start of this event: from the previous one on the track, or from the tracks below (video). */
  transition: EventTransition | null
  /** Transition at the end of this event when nothing follows it: to the tracks below (video). */
  transitionOut: EventTransition | null
}

export interface Marker {
  id: string
  time: Flicks
  label: string
}

/** Everything that is undoable. Media files live outside, in the editor store. */
export interface Project {
  settings: ProjectSettings
  tracks: Track[]
  events: TimelineEvent[]
  markers: Marker[]
}

export interface MediaItem {
  id: string
  name: string
  kind: MediaKind
  /** Imported file, or null when the media comes from a saved project (read by path). */
  file: File | null
  /** Playback URL: object URL of the file, or the boar-media:// URL of the path. */
  url: string
  /** Absolute path on disk (Electron only, empty in the browser). */
  path: string
  size: number
  status: 'analyzing' | 'ready' | 'error'
  error: string
  /** Playable length. 0 for still images (they can be stretched freely). */
  duration: Flicks
  hasVideo: boolean
  hasAudio: boolean
  width: number
  height: number
  fps: number
  videoCodec: string
  audioCodec: string
  sampleRate: number
  channels: number
  /** Small preview image URL for the media list. */
  poster: string
  /** Light copy the preview plays instead (videos that are slow to seek), boar-media:// URL. */
  proxyUrl?: string
  /** 0..1 while the proxy is being made. */
  proxyProgress?: number
  /** Seeking decodes many frames (rare keyframes or a big picture): worth a proxy. */
  slowSeek?: boolean
}

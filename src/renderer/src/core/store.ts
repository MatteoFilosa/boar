import { create } from 'zustand'
import type { MediaItem, Project, ProjectSettings } from './types'
import type { Flicks } from './time'
import type { MediaTranscript } from './transcript'
import type { ShortCandidate } from './shorts'
import type { TransitionSide } from './transitions'
import type { UpdateInfo } from '../platform'

export type PreviewQuality = 'draft' | 'preview' | 'good' | 'best'
export type DockTab = 'media' | 'explorer' | 'transitions' | 'fx' | 'afx' | 'generators' | 'transcript' | 'shorts'

export interface ViewState {
  /** Horizontal zoom. */
  pxPerSecond: number
  /** Scroll offsets of the track area, in CSS pixels. */
  scrollX: number
  scrollY: number
}

/** Which events move to close (or open) a gap: the Auto Ripple modes. */
export type RippleMode = 'tracks' | 'tracksMarkers' | 'all'

/** Event properties that Paste Event Attributes copies from one event to others. */
export type EventAttribute = 'fx' | 'panCrop' | 'mask' | 'gain' | 'textStyle'

export type EditTool = 'normal' | 'select'

export interface EditorOptions {
  snapping: boolean
  autoCrossfade: boolean
  quantize: boolean
  loop: boolean
  previewQuality: PreviewQuality
  masterDb: number
  /** Show title/action safe areas (16:9) or social app UI zones (9:16) over the preview. */
  safeAreas: boolean
  /** Deleting, cutting and pasting close/open gaps automatically. */
  autoRipple: boolean
  rippleMode: RippleMode
  /** Render As loudness target in LUFS, null = off. */
  renderLoudness: number | null
  /** Render As choices, kept for the next render. */
  renderCodec: 'avc' | 'hevc' | 'av1' | 'vp9'
  renderEncoder: 'auto' | 'gpu' | 'cpu'
  renderAudio: 'aac' | 'opus' | 'none'
  /** Optional feature: Download from Link through yt-dlp (off until the user enables it). */
  linkDownloads: boolean
  /** Look for a new release when Boar starts. */
  checkUpdates: boolean
  /** Videos that are slow to seek get a light copy for the preview. */
  proxies: boolean
  /** Space stops and goes back to where playback started (off: it pauses where it is). */
  spaceReturns: boolean
  /** What Selectively Paste Event Attributes pastes (remembered). */
  pasteAttributes: EventAttribute[]
  /** Interface theme: a built-in id ('dark', 'light'...) or a loaded file ('user:...'). */
  theme: string
  /** Size of the whole interface (1 = 100%), Ctrl++ / Ctrl+- (desktop app). */
  uiScale: number
  /** Captions made from the transcript move, shrink and disappear with the clips they caption. */
  linkedCaptions: boolean
}

const DEFAULT_OPTIONS: EditorOptions = {
  snapping: true,
  autoCrossfade: true,
  quantize: true,
  loop: false,
  previewQuality: 'preview',
  masterDb: 0,
  safeAreas: false,
  autoRipple: false,
  rippleMode: 'tracks',
  renderLoudness: -14,
  renderCodec: 'avc',
  renderEncoder: 'auto',
  renderAudio: 'aac',
  linkDownloads: false,
  checkUpdates: true,
  proxies: true,
  spaceReturns: false,
  pasteAttributes: ['fx', 'panCrop', 'mask', 'gain', 'textStyle'],
  theme: 'dark',
  uiScale: 1,
  linkedCaptions: true
}

const OPTIONS_KEY = 'boar.options'

/** Editor options are a per-user preference, remembered between sessions. */
function loadOptions(): EditorOptions {
  try {
    const saved = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? '{}') as Partial<EditorOptions>
    return { ...DEFAULT_OPTIONS, ...saved }
  } catch {
    return { ...DEFAULT_OPTIONS }
  }
}

export interface TimeRange {
  start: Flicks
  end: Flicks
}

export type Dialog =
  | { kind: 'projectProperties' }
  | { kind: 'matchMedia'; mediaId: string }
  | { kind: 'panCrop'; eventId: string }
  | { kind: 'text'; eventId: string }
  | { kind: 'render' }
  | { kind: 'captions' }
  | { kind: 'mask'; eventId: string }
  /** Event FX chain window; `focus` selects one effect in it. */
  | { kind: 'fx'; eventId: string; focus?: string }
  | { kind: 'youtube' }
  | { kind: 'silence' }
  | { kind: 'themes' }
  | { kind: 'pasteAttributes' }
  /** Transition window for one side of an event. */
  | { kind: 'transition'; eventId: string; side: TransitionSide }
  | { kind: 'ducking' }
  | { kind: 'reframe' }
  | { kind: 'autoZoom' }
  | { kind: 'agents' }
  | { kind: 'saveSfx'; eventId: string }
  | { kind: 'shortcuts' }
  | { kind: 'about' }
  | { kind: 'update'; info: UpdateInfo | null; error?: string }

export interface EditorState {
  project: Project
  past: Project[]
  future: Project[]
  media: MediaItem[]
  selection: string[]
  selectedTrackId: string | null
  cursor: Flicks
  playing: boolean
  view: ViewState
  options: EditorOptions
  dockTab: DockTab
  dialog: Dialog | null
  status: string
  /** Timeline position highlighted while a drag snaps to it. */
  snapLine: Flicks | null
  /** Timeline edit tool: normal (move, trim, fade) or selection (drag a rectangle anywhere to select). */
  editTool: EditTool
  /** Time selection across all tracks (loop region), kept until cleared. */
  timeSelection: TimeRange | null
  /** What a tool is about to cut (Remove Silences), shown in red on those tracks. */
  cutPreview: { trackIds: string[]; ranges: TimeRange[] } | null
  /** A render is in progress (the Render As dialog cannot be closed). */
  exporting: boolean
  /** Path of the open .boar file (Electron), or its name in the browser. */
  projectPath: string | null
  /** Project as last saved or opened; differs from `project` when there are unsaved changes. */
  savedProject: Project
  /** Speech of media files by media id (Transcript tab, captions); saved with the project, not undoable. */
  transcripts: Record<string, MediaTranscript>
  /** Transcripts as last saved or opened. */
  savedTranscripts: Record<string, MediaTranscript>
  /** Short-form candidates found in this (long) video; saved with the project. */
  shorts: ShortCandidate[]
  savedShorts: ShortCandidate[]
  /** Project Media as last saved or opened (mediaKey). */
  savedMediaKey: string
  /** While editing a Short made with Make Short: the long video to go back to. */
  longVideo: LongVideo | null
}

/** The long project kept in memory while a Short made from it is edited (same media). */
export interface LongVideo {
  name: string
  project: Project
  savedProject: Project
  past: Project[]
  future: Project[]
  projectPath: string | null
  transcripts: Record<string, MediaTranscript>
  savedTranscripts: Record<string, MediaTranscript>
  shorts: ShortCandidate[]
  savedShorts: ShortCandidate[]
}

export const DEFAULT_SETTINGS: ProjectSettings = {
  width: 1920,
  height: 1080,
  frameRate: { num: 30000, den: 1001 },
  sampleRate: 48000
}

export function emptyProject(): Project {
  return {
    settings: { ...DEFAULT_SETTINGS, frameRate: { ...DEFAULT_SETTINGS.frameRate } },
    tracks: [],
    events: [],
    markers: []
  }
}

const initialProject = emptyProject()
const noTranscripts: Record<string, MediaTranscript> = {}
const noShorts: ShortCandidate[] = []

/** What a project file keeps of Project Media: which files, in which order. */
export const mediaKey = (media: MediaItem[]): string => media.map((m) => m.id).join('|')

/** Anything a save would write differs from the last save: timeline, transcripts, Shorts, Project Media. */
export function hasUnsavedChanges(s: EditorState): boolean {
  return (
    s.project !== s.savedProject ||
    s.transcripts !== s.savedTranscripts ||
    s.shorts !== s.savedShorts ||
    mediaKey(s.media) !== s.savedMediaKey
  )
}

export const useEditor = create<EditorState>()(() => ({
  project: initialProject,
  savedProject: initialProject,
  projectPath: null,
  past: [],
  future: [],
  media: [],
  selection: [],
  selectedTrackId: null,
  cursor: 0,
  playing: false,
  view: { pxPerSecond: 60, scrollX: 0, scrollY: 0 },
  options: loadOptions(),
  dockTab: 'media',
  dialog: null,
  status: 'Ready',
  snapLine: null,
  editTool: 'normal',
  timeSelection: null,
  cutPreview: null,
  exporting: false,
  transcripts: noTranscripts,
  savedTranscripts: noTranscripts,
  shorts: noShorts,
  savedShorts: noShorts,
  savedMediaKey: '',
  longVideo: null
}))

useEditor.subscribe((s, p) => {
  if (s.options === p.options) return
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(s.options))
  } catch {
    // Storage unavailable: options just reset next time.
  }
})

let mediaIndexSource: MediaItem[] | null = null
let mediaIndex = new Map<string, MediaItem>()

export function mediaById(id: string): MediaItem | undefined {
  const media = useEditor.getState().media
  if (media !== mediaIndexSource) {
    mediaIndex = new Map(media.map((m) => [m.id, m]))
    mediaIndexSource = media
  }
  return mediaIndex.get(id)
}

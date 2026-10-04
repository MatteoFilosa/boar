import { produce, type Draft } from 'immer'
import {
  emptyProject,
  hasUnsavedChanges,
  mediaById,
  useEditor,
  type Dialog,
  type DockTab,
  type EditorOptions,
  type EditorState,
  type RippleMode,
  type TimeRange,
  type ViewState
} from './store'
import type { MediaItem, Project, ProjectSettings, TimelineEvent, Track, TrackKind } from './types'
import { uid } from './ids'
import {
  type Flicks,
  FLICKS_PER_SECOND,
  floorToFrame,
  fps,
  frameFlicks,
  nearestStandardRate,
  quantizeToFrame,
  secondsToFlicks
} from './time'
import { editPoints, eventEnd, projectEnd, sourceLength, sourceTime } from './timeline'
import { DEFAULT_FADE_CURVE, type FadeCurve, clampRate, formatRate } from './fades'
import { type PanCropKey, DEFAULT_PANCROP, framingZoom, normalizeAngle, turnState } from './pancrop'
import { type TextContent, presetById, retimeWords } from './text'
import type { CaptionChunk } from './captions'
import type { EventMask } from './mask'
import { type FxKind, cloneFx, createFx, fxDef } from './fx'
import { DEFAULT_TRANSITION_LENGTH } from './transitions'
import { type MediaTranscript, type TimelineWord, rangesForWords } from './transcript'
import { addEmoji, emphasizeKeywords } from './captionStyle'
import type { ShortCandidate } from './shorts'
import { type Corner, cornerFrame, coverFrame, halfFrame } from './layouts'
import { dropMediaCache } from '../media/cache'

const HISTORY_LIMIT = 200
const get = useEditor.getState
const set = useEditor.setState

export const TRACK_COLORS = ['#5b8fd9', '#5fb36f', '#d9a03f', '#a56fd6', '#d65f5f', '#43b5ad', '#c9c24a', '#d9793f']
export const IMAGE_DEFAULT_LENGTH = secondsToFlicks(5)

// History

function withHistory(previous: Project, next: Project): Partial<EditorState> {
  const past = get().past
  const trimmed = past.length >= HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT + 1) : past
  return { project: next, past: [...trimmed, previous], future: [] }
}

function validSelection(project: Project, selection: string[]): string[] {
  const ids = new Set(project.events.map((e) => e.id))
  return selection.filter((id) => ids.has(id))
}

/** Applies an undoable change to the project. */
export function commit(recipe: (draft: Draft<Project>) => void): boolean {
  lastCoalesced = null
  const { project } = get()
  const next = produce(project, recipe)
  if (next === project) return false
  set(withHistory(project, next))
  return true
}

let lastCoalesced: { key: string; at: number } | null = null

/**
 * Like commit(), but rapid changes with the same key (typing, color pickers)
 * merge into one undo step.
 */
export function commitCoalesced(key: string, recipe: (draft: Draft<Project>) => void): void {
  const now = performance.now()
  const previous = lastCoalesced
  if (previous && previous.key === key && now - previous.at < 1200 && get().past.length > 0) {
    const { project } = get()
    const next = produce(project, recipe)
    if (next !== project) set({ project: next, future: [] })
  } else {
    commit(recipe)
  }
  lastCoalesced = { key, at: now }
}

// Gestures (drags, slider moves) recompute every update from the project as it
// was when the gesture started, and end up as a single undo step.
let gestureBase: Project | null = null

export const gestureActive = (): boolean => gestureBase !== null

export function beginGesture(): void {
  gestureBase = get().project
}

export function updateGesture(recipe: (draft: Draft<Project>) => void): void {
  if (!gestureBase) return
  set({ project: produce(gestureBase, recipe) })
}

export function endGesture(): void {
  const base = gestureBase
  gestureBase = null
  set({ snapLine: null })
  if (!base) return
  const { project } = get()
  if (project !== base) set(withHistory(base, project))
}

export function cancelGesture(): void {
  if (gestureBase) set({ project: gestureBase, snapLine: null })
  gestureBase = null
}

export function undo(): void {
  const { past, project, future, selection } = get()
  if (gestureBase || past.length === 0) return
  const previous = past[past.length - 1]
  set({
    project: previous,
    past: past.slice(0, -1),
    future: [project, ...future],
    selection: validSelection(previous, selection)
  })
  setStatus('Undo')
}

export function redo(): void {
  const { past, project, future, selection } = get()
  if (gestureBase || future.length === 0) return
  const next = future[0]
  set({
    project: next,
    past: [...past, project],
    future: future.slice(1),
    selection: validSelection(next, selection)
  })
  setStatus('Redo')
}

// Ui state

export function setStatus(status: string): void {
  set({ status })
}

export const openDialog = (dialog: Dialog): void => set({ dialog })
export const closeDialog = (): void => set({ dialog: null })
export const setDockTab = (dockTab: DockTab): void => set({ dockTab })

export function setView(patch: Partial<ViewState>): void {
  set((s) => ({ view: { ...s.view, ...patch } }))
}

export function setOption<K extends keyof EditorOptions>(key: K, value: EditorOptions[K]): void {
  set((s) => ({ options: { ...s.options, [key]: value } }))
}

/** Turns the optional Download from Link feature on (after the user agrees) or off. */
export function toggleLinkDownloads(): void {
  if (get().options.linkDownloads) {
    setOption('linkDownloads', false)
    return
  }
  const ok = window.confirm(
    'Download from Link uses yt-dlp, a separate open source tool that is downloaded the first time you use it.\n\n' +
      'Only download videos you have the rights to use: the terms of many sites do not allow downloading.\n\nEnable it?'
  )
  if (ok) setOption('linkDownloads', true)
}

const OPTION_LABELS = {
  snapping: 'Snapping',
  autoCrossfade: 'Automatic crossfades',
  quantize: 'Quantize to frames',
  loop: 'Loop playback',
  autoRipple: 'Auto Ripple',
  checkUpdates: 'Check for updates at startup',
  proxies: 'Proxies for videos that are slow to seek'
} as const

export function toggleOption(key: keyof typeof OPTION_LABELS): void {
  const value = !get().options[key]
  setOption(key, value)
  const detail = key === 'autoRipple' && value ? ` (${RIPPLE_LABELS[get().options.rippleMode]})` : ''
  setStatus(`${OPTION_LABELS[key]}: ${value ? 'on' : 'off'}${detail}`)
}

/** Size of the visible track area, kept current by the timeline component. */
export const timelineViewport = { width: 800, height: 300 }

export const MIN_PX_PER_SECOND = 0.2
export const MAX_PX_PER_SECOND = 4000

export function zoomAround(factor: number, anchorPx: number): void {
  const { view } = get()
  const pxPerSecond = Math.min(MAX_PX_PER_SECOND, Math.max(MIN_PX_PER_SECOND, view.pxPerSecond * factor))
  const anchorSeconds = (view.scrollX + anchorPx) / view.pxPerSecond
  setView({ pxPerSecond, scrollX: Math.max(0, anchorSeconds * pxPerSecond - anchorPx) })
}

/** Zoom keeping the cursor in place when it is visible, else the view center. */
export function zoomStep(direction: 1 | -1): void {
  const { view, cursor } = get()
  const cursorPx = (cursor / FLICKS_PER_SECOND) * view.pxPerSecond - view.scrollX
  const anchor = cursorPx >= 0 && cursorPx <= timelineViewport.width ? cursorPx : timelineViewport.width / 2
  zoomAround(direction > 0 ? 1.5 : 1 / 1.5, anchor)
}

export function zoomToFit(): void {
  const seconds = Math.max(10, projectEnd(get().project) / FLICKS_PER_SECOND)
  const pxPerSecond = Math.min(
    MAX_PX_PER_SECOND,
    Math.max(MIN_PX_PER_SECOND, (timelineViewport.width - 40) / seconds)
  )
  setView({ pxPerSecond, scrollX: 0 })
}

// Cursor

const seekListeners = new Set<(t: Flicks) => void>()

/** Called whenever the user moves the cursor (not during playback updates). */
export function onUserSeek(listener: (t: Flicks) => void): () => void {
  seekListeners.add(listener)
  return () => seekListeners.delete(listener)
}

export function setCursor(t: Flicks): void {
  const { project, options } = get()
  let next = Math.max(0, t)
  if (options.quantize) next = quantizeToFrame(next, project.settings.frameRate)
  set({ cursor: next })
  for (const listener of seekListeners) listener(next)
}

export function stepFrames(count: number): void {
  const { cursor, project } = get()
  setCursor(cursor + count * frameFlicks(project.settings.frameRate))
}

export function jumpToEditPoint(direction: 1 | -1): void {
  const { cursor, project } = get()
  const points = editPoints(project)
  const target =
    direction > 0 ? points.find((p) => p > cursor) : [...points].reverse().find((p) => p < cursor)
  if (target !== undefined) setCursor(target)
}

export const goToStart = (): void => setCursor(0)
export const goToEnd = (): void => setCursor(projectEnd(get().project))

// Media

export function addMediaItem(item: MediaItem): void {
  set((s) => ({ media: [...s.media, item] }))
}

export function updateMedia(id: string, patch: Partial<MediaItem>): void {
  set((s) => ({ media: s.media.map((m) => (m.id === id ? { ...m, ...patch } : m)) }))
}

/** Removes media not used on the timeline. Returns how many were removed. */
export function removeUnusedMedia(ids: string[]): number {
  const used = new Set(get().project.events.map((e) => e.mediaId))
  const removable = new Set(ids.filter((id) => !used.has(id)))
  if (removable.size === 0) {
    setStatus('Media in use on the timeline cannot be removed')
    return 0
  }
  for (const m of get().media) {
    if (!removable.has(m.id)) continue
    URL.revokeObjectURL(m.url)
    if (m.poster.startsWith('blob:') && m.poster !== m.url) URL.revokeObjectURL(m.poster)
    dropMediaCache(m.id)
  }
  set((s) => ({ media: s.media.filter((m) => !removable.has(m.id)) }))
  setStatus(`Removed ${removable.size} media file${removable.size > 1 ? 's' : ''}`)
  return removable.size
}

// Tracks

function makeTrack(kind: TrackKind, existing: readonly Track[]): Track {
  return {
    id: uid(),
    kind,
    name: '',
    color: existing.length % TRACK_COLORS.length,
    muted: false,
    solo: false,
    level: 1,
    volumeDb: 0,
    pan: 0,
    height: kind === 'video' ? 86 : 76
  }
}

/** Video tracks go after the last video track, audio tracks at the bottom. */
function insertTrack(d: Draft<Project>, kind: TrackKind, index?: number): Track {
  const track = makeTrack(kind, d.tracks)
  let at = index
  if (at === undefined) {
    if (kind === 'video') {
      let lastVideo = -1
      d.tracks.forEach((t, i) => {
        if (t.kind === 'video') lastVideo = i
      })
      at = lastVideo + 1
    } else {
      at = d.tracks.length
    }
  }
  d.tracks.splice(at, 0, track)
  return track
}

/**
 * Where Insert Track puts a new track: video tracks go above the selected track
 * (or the track of the selected event) and at the top otherwise, so the new
 * track is in front; audio tracks go below the selected audio track, else last.
 */
function newTrackIndex(tracks: readonly Track[], kind: TrackKind): number {
  const { selectedTrackId, selection, project } = get()
  const refId = selectedTrackId ?? project.events.find((e) => selection.includes(e.id) && e.kind === kind)?.trackId
  const ref = tracks.findIndex((t) => t.id === refId && t.kind === kind)
  if (kind === 'video') return ref >= 0 ? ref : Math.max(0, tracks.findIndex((t) => t.kind === 'video'))
  return ref >= 0 ? ref + 1 : tracks.length
}

export function addTrack(kind: TrackKind): void {
  let id = ''
  commit((d) => {
    id = insertTrack(d, kind, newTrackIndex(d.tracks, kind)).id
  })
  set({ selectedTrackId: id })
  setStatus(kind === 'video' ? 'Video track added' : 'Audio track added')
}

/** Moves a track to another position (dragging its header, or Move Track Up/Down). */
export function moveTrack(trackId: string, toIndex: number): void {
  commit((d) => {
    const from = d.tracks.findIndex((t) => t.id === trackId)
    if (from < 0) return
    const to = Math.max(0, Math.min(d.tracks.length - 1, toIndex))
    if (to === from) return
    const [track] = d.tracks.splice(from, 1)
    d.tracks.splice(to, 0, track)
  })
  set({ selectedTrackId: trackId })
}

export function removeTrack(trackId: string): void {
  commit((d) => {
    d.tracks = d.tracks.filter((t) => t.id !== trackId)
    d.events = d.events.filter((e) => e.trackId !== trackId)
  })
  set((s) => ({ selectedTrackId: null, selection: validSelection(s.project, s.selection) }))
}

export function updateTrack(trackId: string, patch: Partial<Track>): void {
  const apply = (d: Draft<Project>): void => {
    const track = d.tracks.find((t) => t.id === trackId)
    if (track) Object.assign(track, patch)
  }
  if (gestureBase) updateGesture(apply)
  else commit(apply)
}

export const selectTrack = (trackId: string | null): void => set({ selectedTrackId: trackId })

// Events

export function expandGroups(ids: Iterable<string>, events: readonly TimelineEvent[]): string[] {
  const out = new Set(ids)
  const groups = new Set<string>()
  for (const e of events) if (out.has(e.id) && e.groupId) groups.add(e.groupId)
  if (groups.size) for (const e of events) if (e.groupId && groups.has(e.groupId)) out.add(e.id)
  return [...out]
}

export function selectEvents(ids: string[], mode: 'replace' | 'toggle' | 'add' = 'replace'): void {
  const { project, selection } = get()
  const expanded = expandGroups(ids, project.events)
  let next: string[]
  if (mode === 'replace') next = expanded
  else if (mode === 'add') next = [...new Set([...selection, ...expanded])]
  else {
    const current = new Set(selection)
    const allSelected = expanded.every((id) => current.has(id))
    for (const id of expanded) {
      if (allSelected) current.delete(id)
      else current.add(id)
    }
    next = [...current]
  }
  set({ selection: next, selectedTrackId: null })
}

export const clearSelection = (): void => set({ selection: [] })

export function selectAll(): void {
  set((s) => ({ selection: s.project.events.map((e) => e.id) }))
}

function differsFromProject(m: MediaItem, settings: ProjectSettings): boolean {
  return (
    m.width !== settings.width ||
    m.height !== settings.height ||
    (m.fps > 0 && Math.abs(m.fps - fps(settings.frameRate)) > 0.05)
  )
}

/**
 * Places media on the timeline at `at`. Video files become a grouped pair of
 * video and audio events. Missing tracks are created; `'new'` always creates
 * fresh tracks at the bottom (drop below the last track), `'top'`
 * a new video track in front of the others (pasted images).
 */
export function addMediaToTimeline(mediaId: string, at: Flicks, trackId?: string | 'new' | 'top' | null): string[] {
  const media = mediaById(mediaId)
  if (!media) return []
  if (media.status !== 'ready') {
    setStatus(media.status === 'error' ? `Cannot use ${media.name}: ${media.error}` : `${media.name} is still being analyzed`)
    return []
  }
  const { project, options } = get()
  const rate = project.settings.frameRate
  const start = Math.max(0, options.quantize ? quantizeToFrame(at, rate) : at)
  const length =
    media.kind === 'image'
      ? IMAGE_DEFAULT_LENGTH
      : Math.max(frameFlicks(rate), options.quantize ? floorToFrame(media.duration, rate) : media.duration)
  const wasEmpty = project.events.length === 0
  const created: string[] = []

  commit((d) => {
    const pick = (kind: TrackKind, below: number): Track => {
      if (trackId === 'new') return insertTrack(d, kind, d.tracks.length)
      if (trackId === 'top' && kind === 'video') return insertTrack(d, kind, Math.max(0, d.tracks.findIndex((t) => t.kind === 'video')))
      if (trackId) {
        const preferred = d.tracks.find((t) => t.id === trackId && t.kind === kind)
        if (preferred) return preferred
      }
      return d.tracks.find((t, i) => t.kind === kind && i > below) ?? insertTrack(d, kind)
    }
    const groupId = media.hasVideo && media.hasAudio ? uid() : null
    const base = { mediaId, start, length, offset: 0, fadeIn: 0, fadeOut: 0, fadeInCurve: DEFAULT_FADE_CURVE, fadeOutCurve: DEFAULT_FADE_CURVE, rate: 1, groupId, gain: 1, panCrop: [], text: null, mask: null, fx: [], envelope: [], transition: null }
    let videoIndex = -1
    if (media.hasVideo) {
      const track = pick('video', -1)
      videoIndex = d.tracks.findIndex((t) => t.id === track.id)
      const id = uid()
      d.events.push({ ...base, id, trackId: track.id, kind: 'video' })
      created.push(id)
    }
    if (media.hasAudio) {
      const track = pick('audio', videoIndex)
      const id = uid()
      d.events.push({ ...base, id, trackId: track.id, kind: 'audio' })
      created.push(id)
    }
  })
  set({ selection: created, selectedTrackId: null })
  setStatus(`Added ${media.name}`)
  if (wasEmpty && media.kind === 'video' && differsFromProject(media, project.settings)) {
    openDialog({ kind: 'matchMedia', mediaId })
  }
  return created
}

export function deleteSelection(): void {
  const { selection, selectedTrackId } = get()
  if (selection.length > 0) {
    const ids = new Set(selection)
    commit((d) => {
      d.events = d.events.filter((e) => !ids.has(e.id))
    })
    set({ selection: [] })
    setStatus(`Deleted ${ids.size} event${ids.size > 1 ? 's' : ''}`)
    return
  }
  if (selectedTrackId) {
    removeTrack(selectedTrackId)
    setStatus('Track deleted')
  }
}

/**
 * Splits the events in `ids` that span time t (strictly inside). Right halves
 * get new ids (returned) and, for grouped events, a new shared group.
 */
function splitInDraft(d: Draft<Project>, ids: Set<string>, t: Flicks): string[] {
  const groupMap = new Map<string, string>()
  const added: TimelineEvent[] = []
  for (const e of d.events) {
    if (!ids.has(e.id) || !(e.start < t && t < e.start + e.length)) continue
    const cut = t - e.start
    let groupId = e.groupId
    if (groupId) {
      if (!groupMap.has(groupId)) groupMap.set(groupId, uid())
      groupId = groupMap.get(groupId) ?? null
    }
    const rightLength = e.length - cut
    added.push({
      ...e,
      id: uid(),
      start: t,
      // Text events advance too: caption word timings are relative to start - offset.
      offset: e.offset + Math.round(cut * e.rate),
      length: rightLength,
      fadeIn: 0,
      fadeOut: Math.min(e.fadeOut, rightLength),
      groupId,
      // Keyframes use source time, so both halves keep the same motion.
      panCrop: e.panCrop.map((k) => ({ ...k })),
      text: e.text ? { ...e.text } : null,
      mask: e.mask ? { ...e.mask } : null,
      fx: cloneFx(e.fx),
      envelope: e.envelope.map((p) => ({ ...p })),
      // The new cut inside the event is a plain cut.
      transition: null
    })
    e.length = cut
    e.fadeIn = Math.min(e.fadeIn, cut)
    e.fadeOut = 0
  }
  d.events.push(...added)
  return added.map((e) => e.id)
}

/** Splits selected events at the cursor, or every event under it when nothing is selected (key S). */
export function splitAtCursor(): void {
  const { project, selection, cursor } = get()
  const under = project.events.filter((e) => e.start < cursor && cursor < eventEnd(e))
  const selected = new Set(selection)
  const targets = selection.length > 0 ? under.filter((e) => selected.has(e.id)) : under
  if (targets.length === 0) {
    setStatus('Nothing to split at the cursor')
    return
  }
  commit((d) => {
    splitInDraft(d, new Set(targets.map((e) => e.id)), cursor)
  })
  setStatus(`Split ${targets.length} event${targets.length > 1 ? 's' : ''}`)
}

// Clipboard and ripple

let clipboard: TimelineEvent[] = []

export function copySelection(): number {
  const { project, selection } = get()
  const ids = new Set(selection)
  clipboard = project.events.filter((e) => ids.has(e.id)).map((e) => structuredClone(e))
  if (clipboard.length) {
    setStatus(`Copied ${clipboard.length} event${clipboard.length > 1 ? 's' : ''}`)
    // An image copied earlier must not win over these events on the next Ctrl+V.
    void window.boar?.claimClipboard()
  }
  return clipboard.length
}

export function cutSelection(): void {
  if (copySelection() > 0) deleteCommand(false)
}

/**
 * Pastes the copied events at the cursor, on their original tracks when they
 * still exist. With Auto Ripple, later events move right to make room.
 */
export function pasteAtCursor(): void {
  if (clipboard.length === 0) {
    setStatus('Nothing to paste')
    return
  }
  const { cursor, options } = get()
  const earliest = Math.min(...clipboard.map((e) => e.start))
  const span = Math.max(...clipboard.map((e) => eventEnd(e))) - earliest
  const groupMap = new Map<string, string>()
  const ids: string[] = []
  commit((d) => {
    const targets = clipboard.map((source) => {
      let track = d.tracks.find((t) => t.id === source.trackId)
      if (!track) track = d.tracks.find((t) => t.kind === source.kind) ?? insertTrack(d, source.kind)
      return { source, trackId: track.id }
    })
    if (options.autoRipple) {
      const mode = options.rippleMode
      const tracks = new Set(targets.map((t) => t.trackId))
      for (const e of d.events) if (e.start >= cursor && (mode === 'all' || tracks.has(e.trackId))) e.start += span
      if (mode !== 'tracks') for (const m of d.markers) if (m.time >= cursor) m.time += span
    }
    for (const { source, trackId } of targets) {
      let groupId = source.groupId
      if (groupId) {
        if (!groupMap.has(groupId)) groupMap.set(groupId, uid())
        groupId = groupMap.get(groupId) ?? null
      }
      const id = uid()
      ids.push(id)
      d.events.push({ ...structuredClone(source), id, trackId, groupId, start: cursor + (source.start - earliest) })
    }
  })
  set({ selection: ids })
  setStatus(`Pasted ${ids.length} event${ids.length > 1 ? 's' : ''}${options.autoRipple ? ' (ripple insert)' : ''}`)
}

type Interval = { start: Flicks; end: Flicks }

function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = [...list].sort((a, b) => a.start - b.start)
  const merged: Interval[] = []
  for (const r of sorted) {
    const last = merged[merged.length - 1]
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end)
    else merged.push({ ...r })
  }
  return merged
}

/** Total length of the removed intervals that end at or before t. */
const shiftBefore = (removed: Interval[], t: Flicks): Flicks =>
  removed.reduce((sum, r) => (r.end <= t ? sum + r.end - r.start : sum), 0)

/**
 * Deletes the selected events and closes the gaps they leave. `mode`: only
 * the affected tracks, affected tracks plus markers, or everything.
 */
export function rippleDeleteSelection(mode?: RippleMode): void {
  const { project, selection, options } = get()
  if (selection.length === 0) return
  const scope = mode ?? (options.autoRipple ? options.rippleMode : 'tracks')
  const ids = new Set(selection)
  const removed = project.events.filter((e) => ids.has(e.id))
  const byTrack = new Map<string, Interval[]>()
  for (const e of removed) byTrack.set(e.trackId, [...(byTrack.get(e.trackId) ?? []), { start: e.start, end: eventEnd(e) }])
  for (const [trackId, list] of byTrack) byTrack.set(trackId, mergeIntervals(list))
  const everywhere = mergeIntervals(removed.map((e) => ({ start: e.start, end: eventEnd(e) })))
  commit((d) => {
    d.events = d.events.filter((e) => !ids.has(e.id))
    for (const e of d.events) {
      const gaps = scope === 'all' ? everywhere : byTrack.get(e.trackId)
      if (gaps) e.start -= shiftBefore(gaps, e.start)
    }
    if (scope !== 'tracks') for (const m of d.markers) m.time -= shiftBefore(everywhere, m.time)
  })
  set({ selection: [] })
  setStatus(`Ripple deleted ${ids.size} event${ids.size > 1 ? 's' : ''}`)
}

/**
 * Delete key: removes the time-selection portion or the selected events (or
 * the selected track). Ripples when Auto Ripple is on or `forceRipple` is set.
 */
export function deleteCommand(forceRipple: boolean): void {
  const { options, selection } = get()
  const ripple = forceRipple || options.autoRipple
  if (timeSelectionActive()) deleteTimeSelection(ripple)
  else if (ripple && selection.length > 0) rippleDeleteSelection()
  else deleteSelection()
}

export function setRippleMode(rippleMode: RippleMode): void {
  set((s) => ({ options: { ...s.options, rippleMode, autoRipple: true } }))
  setStatus(`Auto Ripple: ${RIPPLE_LABELS[rippleMode]}`)
}

export const RIPPLE_LABELS: Record<RippleMode, string> = {
  tracks: 'Affected tracks',
  tracksMarkers: 'Affected tracks and markers',
  all: 'All tracks and markers'
}

// Time selection (loop region): not part of the undoable project, like the cursor.

export function setTimeSelection(range: TimeRange | null): void {
  set({ timeSelection: range && range.end > range.start ? range : null })
}

export const clearTimeSelection = (): void => set({ timeSelection: null })

/**
 * Events a time-selection edit applies to: the selected events that overlap
 * the range, or every overlapping event when none of the selected ones do.
 */
function rangeTargets(range: TimeRange): TimelineEvent[] {
  const { project, selection } = get()
  const inRange = project.events.filter((e) => e.start < range.end && eventEnd(e) > range.start)
  const selected = new Set(selection)
  const chosen = inRange.filter((e) => selected.has(e.id))
  return chosen.length > 0 ? chosen : inRange
}

/** True when Delete/S should act on the time selection rather than on whole events. */
export function timeSelectionActive(): boolean {
  const { timeSelection, selection, project } = get()
  if (!timeSelection) return false
  if (selection.length === 0) return true
  const selected = new Set(selection)
  return project.events.some(
    (e) => selected.has(e.id) && e.start < timeSelection.end && eventEnd(e) > timeSelection.start
  )
}

/** Splits events at both edges of the time selection. */
export function splitAtTimeSelection(): void {
  const range = get().timeSelection
  if (!range) return
  const targets = rangeTargets(range)
  if (targets.length === 0) {
    setStatus('No events in the time selection')
    return
  }
  commit((d) => {
    const ids = new Set(targets.map((e) => e.id))
    const right = splitInDraft(d, ids, range.start)
    splitInDraft(d, new Set([...ids, ...right]), range.end)
  })
  setStatus(`Split ${targets.length} event${targets.length > 1 ? 's' : ''} at the selection edges`)
}

/**
 * Removes the part of the events inside the time selection. With ripple, later
 * events move left to close the gap: per the Auto Ripple mode when it is on;
 * otherwise every track when the whole range was cut, or only the tracks of
 * the selected events.
 */
export function deleteTimeSelection(ripple: boolean): void {
  const range = get().timeSelection
  if (!range) return
  const targets = rangeTargets(range)
  if (targets.length === 0 && !ripple) {
    setStatus('No events in the time selection')
    return
  }
  const { selection, options } = get()
  const wholeRange = !targets.some((e) => selection.includes(e.id))
  const scope: RippleMode = options.autoRipple ? options.rippleMode : wholeRange ? 'all' : 'tracks'
  const tracks = new Set(targets.map((e) => e.trackId))
  const gap = range.end - range.start
  commit((d) => {
    const ids = new Set(targets.map((e) => e.id))
    const right = splitInDraft(d, ids, range.start)
    const pieces = new Set([...ids, ...right])
    splitInDraft(d, pieces, range.end)
    d.events = d.events.filter((e) => !(pieces.has(e.id) && e.start >= range.start && e.start + e.length <= range.end))
    if (!ripple) return
    for (const e of d.events) {
      if (e.start >= range.end && (scope === 'all' || tracks.has(e.trackId))) e.start -= gap
    }
    if (scope !== 'tracks') {
      d.markers = d.markers.filter((m) => m.time < range.start || m.time >= range.end)
      for (const m of d.markers) if (m.time >= range.end) m.time -= gap
    }
  })
  if (ripple) {
    set({ selection: [], timeSelection: null })
    setCursor(range.start)
  } else {
    set({ selection: [] })
  }
  setStatus(ripple ? 'Ripple deleted the time selection' : 'Deleted the time selection')
}

/** Keeps only the part of the events inside the time selection (Trim to Time Selection). */
export function trimToTimeSelection(): void {
  const range = get().timeSelection
  if (!range) return
  const targets = new Set(rangeTargets(range).map((e) => e.id))
  if (targets.size === 0) return
  commit((d) => {
    for (const e of d.events) {
      if (!targets.has(e.id)) continue
      const start = Math.max(e.start, range.start)
      const end = Math.min(e.start + e.length, range.end)
      const media = mediaById(e.mediaId)
      if ((media && media.kind !== 'image') || e.text) e.offset += Math.round((start - e.start) * e.rate)
      e.start = start
      e.length = end - start
      e.fadeIn = Math.min(e.fadeIn, e.length)
      e.fadeOut = Math.min(e.fadeOut, e.length - e.fadeIn)
    }
  })
  setStatus(`Trimmed ${targets.size} event${targets.size > 1 ? 's' : ''} to the selection`)
}

export function selectEventsInTimeSelection(): void {
  const range = get().timeSelection
  if (!range) return
  const ids = get()
    .project.events.filter((e) => e.start < range.end && eventEnd(e) > range.start)
    .map((e) => e.id)
  set({ selection: ids, selectedTrackId: null })
}

export function zoomToTimeSelection(): void {
  const range = get().timeSelection
  if (!range) return
  const seconds = (range.end - range.start) / FLICKS_PER_SECOND
  const pxPerSecond = Math.min(
    MAX_PX_PER_SECOND,
    Math.max(MIN_PX_PER_SECOND, (timelineViewport.width * 0.9) / Math.max(seconds, 0.1))
  )
  const left = (range.start / FLICKS_PER_SECOND) * pxPerSecond - timelineViewport.width * 0.05
  setView({ pxPerSecond, scrollX: Math.max(0, left) })
}

export function removeFadesFromSelection(): void {
  const ids = new Set(get().selection)
  commit((d) => {
    for (const e of d.events) {
      if (!ids.has(e.id)) continue
      e.fadeIn = 0
      e.fadeOut = 0
    }
  })
}

/** Fade Type: the curve of the fade in or out of the events (and of their groups). */
export function setFadeCurve(eventIds: string[], side: 'in' | 'out', curve: FadeCurve): void {
  const ids = new Set(expandGroups(eventIds, get().project.events))
  if (ids.size === 0) return
  commit((d) => {
    for (const e of d.events) {
      if (!ids.has(e.id)) continue
      if (side === 'in') e.fadeInCurve = curve
      else e.fadeOutCurve = curve
    }
  })
  setStatus(`Fade ${side} curve: ${curve}`)
}

/** Events whose speed can change: media with a duration (not stills or text). */
export function canStretch(e: TimelineEvent): boolean {
  if (e.text) return false
  const media = mediaById(e.mediaId)
  return !!media && media.kind !== 'image'
}

/**
 * Playback rate presets: the events (and their groups) play the same part of
 * the media faster or slower, so they get shorter or longer. With Auto Ripple,
 * later events on the affected tracks follow.
 */
export function setPlaybackRate(eventIds: string[], rate: number): number {
  const { project, options } = get()
  const r = clampRate(rate)
  const ids = new Set(expandGroups(eventIds, project.events).filter((id) => project.events.some((e) => e.id === id && canStretch(e))))
  if (ids.size === 0) {
    setStatus('Select a video or audio clip to change its speed')
    return 0
  }
  const frameRate = project.settings.frameRate
  const frame = frameFlicks(frameRate)
  const before = new Map(project.events.map((e) => [e.id, e.start]))
  const changes: { id: string; trackId: string; end: Flicks; delta: Flicks }[] = []
  commit((d) => {
    for (const e of d.events) {
      if (!ids.has(e.id)) continue
      let length = Math.max(frame, Math.round(sourceLength(e) / r))
      if (options.quantize) length = Math.max(frame, quantizeToFrame(length, frameRate))
      // Rounding to frames must not read past the end of the media.
      const media = mediaById(e.mediaId)
      const available = media && media.duration > 0 ? media.duration - e.offset : Infinity
      if (length * r > available) {
        const fit = Math.floor(available / r)
        length = Math.max(frame, options.quantize ? floorToFrame(fit, frameRate) : fit)
      }
      changes.push({ id: e.id, trackId: e.trackId, end: e.start + e.length, delta: length - e.length })
      e.length = length
      e.rate = r
      e.fadeIn = Math.min(e.fadeIn, e.length)
      e.fadeOut = Math.min(e.fadeOut, e.length - e.fadeIn)
    }
    if (!options.autoRipple) return
    for (const e of d.events) {
      const start = before.get(e.id) ?? e.start
      let shift = 0
      for (const c of changes) if (c.id !== e.id && c.trackId === e.trackId && c.end <= start) shift += c.delta
      e.start = Math.max(0, e.start + shift)
    }
  })
  setStatus(`Playback rate ${formatRate(r)} on ${ids.size} event${ids.size > 1 ? 's' : ''}`)
  return ids.size
}

export function groupSelection(): void {
  const selection = new Set(get().selection)
  if (selection.size < 2) {
    setStatus('Select at least two events to group')
    return
  }
  const groupId = uid()
  commit((d) => {
    for (const e of d.events) if (selection.has(e.id)) e.groupId = groupId
  })
  setStatus('Events grouped')
}

export function ungroupSelection(): void {
  const selection = new Set(get().selection)
  if (selection.size === 0) return
  commit((d) => {
    for (const e of d.events) if (selection.has(e.id)) e.groupId = null
  })
  setStatus('Events ungrouped')
}

export function addMarkerAt(time: Flicks): void {
  const { project, options } = get()
  const t = options.quantize ? quantizeToFrame(Math.max(0, time), project.settings.frameRate) : Math.max(0, time)
  if (project.markers.some((m) => m.time === t)) return
  commit((d) => {
    d.markers.push({ id: uid(), time: t, label: String(d.markers.length + 1) })
    d.markers.sort((a, b) => a.time - b.time)
  })
  setStatus('Marker added')
}

export const addMarkerAtCursor = (): void => addMarkerAt(get().cursor)

export function removeMarker(markerId: string): void {
  commit((d) => {
    d.markers = d.markers.filter((m) => m.id !== markerId)
  })
}

// Project

export function setProjectSettings(settings: ProjectSettings): void {
  commit((d) => {
    d.settings = { ...settings, frameRate: { ...settings.frameRate } }
  })
  setStatus(`Project: ${settings.width}x${settings.height}`)
}

export function setFrameSize(width: number, height: number): void {
  commit((d) => {
    d.settings.width = width
    d.settings.height = height
  })
  setStatus(`Project: ${width}x${height}`)
}

export function matchProjectToMedia(mediaId: string): void {
  const media = mediaById(mediaId)
  if (!media || !media.width || !media.height) return
  const { settings } = get().project
  setProjectSettings({
    ...settings,
    width: media.width,
    height: media.height,
    frameRate: media.fps > 0 ? nearestStandardRate(media.fps) : settings.frameRate
  })
}

// Pan/crop

/** Opens Event Pan/Crop for an event, or for the first selected video event. */
export function openPanCrop(eventId?: string): void {
  const { project, selection } = get()
  const candidates = eventId ? [eventId] : selection
  const event = project.events.find((e) => candidates.includes(e.id) && e.kind === 'video')
  if (!event) {
    setStatus('Select a video event to open Event Pan/Crop')
    return
  }
  set({ dialog: { kind: 'panCrop', eventId: event.id } })
}

export function setPanCropKeys(eventId: string, keys: PanCropKey[]): void {
  const apply = (d: Draft<Project>): void => {
    const event = d.events.find((e) => e.id === eventId)
    if (event) event.panCrop = keys.map((k) => ({ ...k }))
  }
  if (gestureBase) updateGesture(apply)
  else commit(apply)
}

/** Replaces the Pan/Crop keyframes of several events in one undo step (Auto Reframe). */
export function setPanCropForEvents(keys: Map<string, PanCropKey[]>): void {
  if (keys.size === 0) return
  commit((d) => {
    for (const e of d.events) {
      const k = keys.get(e.id)
      if (k) e.panCrop = k.map((key) => ({ ...key }))
    }
  })
}

/**
 * Reframes video events to the project frame: `fill` crops so there are no
 * black bars (16:9 footage in a 9:16 project), `fit` restores the default.
 * Both keep a rotation (a quarter turn fits or fills the turned picture).
 * Applies to the selected events, or to every video event when none is selected.
 */
export function reframeVideoEvents(mode: 'fill' | 'fit'): void {
  const { project, selection } = get()
  const { width, height } = project.settings
  const selected = new Set(selection)
  const targets = new Set(
    project.events.filter((e) => e.kind === 'video' && (selected.size === 0 || selected.has(e.id))).map((e) => e.id)
  )
  if (targets.size === 0) {
    setStatus('No video events to reframe')
    return
  }
  commit((d) => {
    for (const event of d.events) {
      if (!targets.has(event.id)) continue
      if (mode === 'fit' && event.panCrop.every((k) => k.rotation === 0)) {
        event.panCrop = []
        continue
      }
      const media = mediaById(event.mediaId)
      if (!media || !media.width || !media.height) continue
      const zoomFor = (rotation: number): number => framingZoom(mode, rotation, media.width, media.height, width, height)
      if (event.panCrop.length === 0) {
        event.panCrop = [{ time: event.offset, cx: 0.5, cy: 0.5, zoom: zoomFor(0), rotation: 0, ease: 'smooth' }]
        continue
      }
      for (const key of event.panCrop) {
        key.zoom = zoomFor(key.rotation)
        if (mode === 'fit') {
          key.cx = 0.5
          key.cy = 0.5
        }
      }
    }
  })
  setStatus(mode === 'fill' ? `Filled frame on ${targets.size} event(s)` : `Reset framing on ${targets.size} event(s)`)
}

/**
 * Turns video, image and text events clockwise on screen by `degrees`, or back
 * upright with 'reset'. Media events turn every Pan/Crop keyframe around the
 * picture's center, so an animation keeps its motion. Returns the count.
 */
export function rotateEvents(ids: readonly string[], degrees: number | 'reset'): number {
  const { project } = get()
  const { width, height } = project.settings
  const wanted = new Set(ids)
  const targets = new Set(
    project.events
      .filter((e) => wanted.has(e.id) && e.kind === 'video')
      .filter((e) => e.text || (mediaById(e.mediaId)?.width ?? 0) > 0)
      .map((e) => e.id)
  )
  if (targets.size === 0) {
    setStatus('Select a video, image or text event to rotate')
    return 0
  }
  commit((d) => {
    for (const event of d.events) {
      if (!targets.has(event.id)) continue
      if (event.text) {
        event.text.rotation = degrees === 'reset' ? 0 : normalizeAngle(event.text.rotation + degrees)
        continue
      }
      const media = mediaById(event.mediaId) as MediaItem
      if (degrees === 'reset' && event.panCrop.every((k) => k.rotation === 0)) continue
      const keys = event.panCrop.length > 0 ? event.panCrop : [{ time: event.offset, ...DEFAULT_PANCROP, ease: 'smooth' as const }]
      const turned = keys.map((k) => ({
        ...k,
        ...turnState(k, degrees === 'reset' ? k.rotation : degrees, media.width, media.height, width, height)
      }))
      // Whole turns off the first keyframe, the same for all so the interpolation keeps its direction.
      const turns = Math.round(turned[0].rotation / 360) * 360
      event.panCrop = turned.map((k) => ({ ...k, rotation: k.rotation - turns }))
    }
  })
  const label = degrees === 'reset' ? 'upright' : `${degrees > 0 ? '+' : ''}${degrees}°`
  setStatus(`Rotated ${targets.size} event(s) ${label}`)
  return targets.size
}

// Text

export const TEXT_DEFAULT_LENGTH = secondsToFlicks(4)

/**
 * Adds a text event from a preset. Without a target track it goes on a video
 * track at the top that is free at that time (created if needed), so titles
 * stay in front of the footage.
 */
export function addTextEvent(presetId: string, at: Flicks, trackId?: string | 'new' | null): string | null {
  const preset = presetById(presetId)
  if (!preset) return null
  const { project, options } = get()
  const rate = project.settings.frameRate
  const start = Math.max(0, options.quantize ? quantizeToFrame(at, rate) : at)
  const end = start + TEXT_DEFAULT_LENGTH
  const id = uid()
  commit((d) => {
    const busy = (t: Track): boolean => d.events.some((e) => e.trackId === t.id && e.start < end && eventEnd(e) > start)
    let track: Track | undefined
    if (trackId && trackId !== 'new') {
      const target = d.tracks.find((t) => t.id === trackId && t.kind === 'video')
      // Dropped on footage: put the text on a new track just above instead of crossfading into it.
      if (target && busy(target)) {
        track = insertTrack(d, 'video', d.tracks.indexOf(target))
        track.name = 'Text'
      } else {
        track = target
      }
    }
    if (!track && trackId !== 'new') {
      const first = d.tracks.findIndex((t) => t.kind === 'video')
      const top = first >= 0 ? d.tracks[first] : undefined
      if (top && !busy(top)) track = top
    }
    if (!track) {
      // New text tracks go above the other video tracks so titles stay in front.
      const firstVideo = d.tracks.findIndex((t) => t.kind === 'video')
      track = insertTrack(d, 'video', Math.max(0, firstVideo))
      track.name = 'Text'
    }
    d.events.push({
      id,
      trackId: track.id,
      mediaId: '',
      kind: 'video',
      start,
      length: TEXT_DEFAULT_LENGTH,
      offset: 0,
      fadeIn: 0,
      fadeOut: 0,
      fadeInCurve: DEFAULT_FADE_CURVE,
      fadeOutCurve: DEFAULT_FADE_CURVE,
      rate: 1,
      groupId: null,
      gain: 1,
      panCrop: [],
      text: { ...preset.content },
      mask: null,
      fx: [],
      envelope: [],
      transition: null
    })
  })
  set({ selection: [id], selectedTrackId: null, dialog: { kind: 'text', eventId: id } })
  setStatus(`Added text: ${preset.label}`)
  return id
}

/**
 * Adds one text event per caption on a new "Captions" track above the video.
 * Word timings (seconds on the same clock as the captions) are kept on each
 * event for the word-by-word styles.
 */
export function addCaptionEvents(captions: CaptionChunk[], origin: Flicks, presetId: string): number {
  const preset = presetById(presetId)
  if (!preset || captions.length === 0) return 0
  const { project, options } = get()
  const rate = project.settings.frameRate
  const frame = frameFlicks(rate)
  const sorted = [...captions].sort((a, b) => a.start - b.start)
  const ids: string[] = []
  commit((d) => {
    const firstVideo = d.tracks.findIndex((t) => t.kind === 'video')
    const track = insertTrack(d, 'video', Math.max(0, firstVideo))
    track.name = 'Captions'
    sorted.forEach((c, i) => {
      // Never overlap the next caption (that would become a crossfade), but
      // bridge short pauses so captions do not flicker off between phrases.
      const next = sorted[i + 1]?.start
      const endSeconds = next === undefined ? c.end : next - c.end < 0.4 ? next : Math.min(c.end, next)
      let start = origin + secondsToFlicks(c.start)
      let end = origin + secondsToFlicks(endSeconds)
      if (options.quantize) {
        start = quantizeToFrame(start, rate)
        end = quantizeToFrame(end, rate)
      }
      if (end - start < frame) end = start + frame
      const toEvent = (seconds: number): number => (origin + secondsToFlicks(seconds) - start) / FLICKS_PER_SECOND
      const id = uid()
      ids.push(id)
      d.events.push({
        id,
        trackId: track.id,
        mediaId: '',
        kind: 'video',
        start,
        length: end - start,
        offset: 0,
        fadeIn: 0,
        fadeOut: 0,
        fadeInCurve: DEFAULT_FADE_CURVE,
        fadeOutCurve: DEFAULT_FADE_CURVE,
        rate: 1,
        groupId: null,
        gain: 1,
        panCrop: [],
        text: {
          ...preset.content,
          text: c.text,
          words: c.words.length ? c.words.map((w) => ({ text: w.text, start: toEvent(w.start), end: toEvent(w.end) })) : null
        },
        mask: null,
        fx: [],
        envelope: [],
        transition: null
      })
    })
  })
  set({ selection: ids, selectedTrackId: null })
  setStatus(`Added ${ids.length} captions`)
  return ids.length
}

/** Copies a text event's look (not its words, text or timing) to the other text events on its track. */
export function applyTextStyleToTrack(eventId: string): number {
  const source = get().project.events.find((e) => e.id === eventId)
  if (!source?.text) return 0
  const { text: _text, words: _words, ...style } = source.text
  let count = 0
  commit((d) => {
    for (const e of d.events) {
      if (e.id === eventId || e.trackId !== source.trackId || !e.text) continue
      Object.assign(e.text, style)
      count++
    }
  })
  setStatus(`Style applied to ${count} text event${count === 1 ? '' : 's'} on the track`)
  return count
}

export function updateText(eventId: string, patch: Partial<TextContent>, field = 'text'): void {
  commitCoalesced(`text:${eventId}:${field}`, (d) => {
    const event = d.events.find((e) => e.id === eventId)
    if (!event?.text) return
    const words = event.text.words
    Object.assign(event.text, patch)
    // Editing a caption keeps its word timings in step with the new words.
    if (patch.text !== undefined && words && patch.words === undefined) event.text.words = retimeWords(words, patch.text)
  })
}

export function setMask(eventId: string, mask: EventMask | null, field = 'mask'): void {
  commitCoalesced(`mask:${eventId}:${field}`, (d) => {
    const event = d.events.find((e) => e.id === eventId)
    if (event) event.mask = mask ? { ...mask } : null
  })
}

/** Replaces an event's mask in one undo step (custom shape edits, Smart Select, tracking). */
export function replaceMask(eventId: string, mask: EventMask | null): void {
  commit((d) => {
    const event = d.events.find((e) => e.id === eventId)
    if (event) event.mask = mask
  })
}

export function openMaskEditor(eventId?: string): void {
  const { project, selection } = get()
  const candidates = eventId ? [eventId] : selection
  const event = project.events.find((e) => candidates.includes(e.id) && e.kind === 'video')
  if (!event) {
    setStatus('Select a video or text event to edit its mask')
    return
  }
  set({ dialog: { kind: 'mask', eventId: event.id } })
}

export function openTextEditor(eventId?: string): void {
  const { project, selection } = get()
  const candidates = eventId ? [eventId] : selection
  const event = project.events.find((e) => candidates.includes(e.id) && e.text)
  if (!event) {
    setStatus('Select a text event to edit it')
    return
  }
  set({ dialog: { kind: 'text', eventId: event.id } })
}

/** Opens "Save as Sound Effect" for the selected audio event (or the sound of a selected video). */
export function openSaveSoundEffect(eventId?: string): void {
  const { project, selection } = get()
  const ids = eventId ? [eventId] : selection
  const event = ids.map((id) => fxTarget(project, id, 'audio')).find(Boolean)
  if (!event) {
    setStatus('Select an audio event to save it as a sound effect')
    return
  }
  set({ dialog: { kind: 'saveSfx', eventId: event.id } })
}

// Automatic edits

/**
 * Jump cuts: cuts time ranges (timeline time) out of the given events and
 * their groups. 'remove' deletes what is inside and closes the gaps on the
 * affected tracks (one undo step); 'split' only splits there and selects the
 * pieces inside, to review them. Returns how many ranges were cut.
 */
export function cutRanges(eventIds: string[], ranges: TimeRange[], mode: 'remove' | 'split'): number {
  const { project, options } = get()
  const rate = project.settings.frameRate
  const q = (t: Flicks): Flicks => (options.quantize ? quantizeToFrame(t, rate) : t)
  const sorted = mergeIntervals(ranges.map((r) => ({ start: q(r.start), end: q(r.end) })).filter((r) => r.end > r.start)).sort(
    (a, b) => b.start - a.start
  )
  if (sorted.length === 0) return 0
  const ids = new Set(expandGroups(eventIds, project.events))
  const tracks = new Set(project.events.filter((e) => ids.has(e.id)).map((e) => e.trackId))
  const frame = frameFlicks(rate)
  const inside: string[] = []
  let cuts = 0
  commit((d) => {
    // Right to left, so earlier ranges keep their timeline positions.
    for (const range of sorted) {
      const overlapping = new Set(
        d.events.filter((e) => ids.has(e.id) && e.start < range.end && e.start + e.length > range.start).map((e) => e.id)
      )
      if (overlapping.size === 0) continue
      cuts++
      for (const id of splitInDraft(d, overlapping, range.start)) {
        ids.add(id)
        overlapping.add(id)
      }
      for (const id of splitInDraft(d, overlapping, range.end)) ids.add(id)
      const within = (e: TimelineEvent): boolean => ids.has(e.id) && e.start >= range.start && e.start + e.length <= range.end
      if (mode === 'split') {
        for (const e of d.events) if (within(e)) inside.push(e.id)
        continue
      }
      d.events = d.events.filter((e) => !within(e))
      const gap = range.end - range.start
      for (const e of d.events) if (tracks.has(e.trackId) && e.start >= range.end) e.start -= gap
    }
    // One-frame audio fades at the cuts avoid clicks.
    if (mode === 'remove') {
      for (const e of d.events) {
        if (!ids.has(e.id) || e.kind !== 'audio') continue
        const f = Math.min(frame, Math.floor(e.length / 4))
        if (e.fadeIn === 0) e.fadeIn = f
        if (e.fadeOut === 0) e.fadeOut = f
      }
    }
  })
  set({ selection: mode === 'split' ? inside : [...ids].filter((id) => get().project.events.some((e) => e.id === id)) })
  return cuts
}

/** Name of the tracks that hold Blurred Background copies (left out of automatic framing tools). */
export const BACKGROUND_TRACK = 'Background'

/** Video clips the automatic framing tools work on by default: not text, not background copies. */
export function foregroundVideoEvents(): TimelineEvent[] {
  const { project } = get()
  const background = new Set(project.tracks.filter((t) => t.name === BACKGROUND_TRACK).map((t) => t.id))
  return project.events.filter((e) => e.kind === 'video' && !e.text && !background.has(e.trackId))
}

/** Video events showing a picture (not text), with a known size. */
function framedEvents(ids: readonly string[]): TimelineEvent[] {
  return get().project.events.filter((e) => {
    if (!ids.includes(e.id) || e.kind !== 'video' || e.text) return false
    const media = mediaById(e.mediaId)
    return !!media && media.kind !== 'audio' && media.width > 0 && media.height > 0
  })
}

/**
 * Blurred background layout: each clip is shown whole over a cropped, blurred
 * and darkened copy of itself on a Background track below.
 */
export function blurredBackground(eventIds: readonly string[]): number {
  const targets = framedEvents(eventIds)
  if (targets.length === 0) {
    setStatus('Select a video clip for the blurred background')
    return 0
  }
  const { width, height } = get().project.settings
  const byTrack = new Map<string, TimelineEvent[]>()
  for (const t of targets) byTrack.set(t.trackId, [...(byTrack.get(t.trackId) ?? []), t])
  commit((d) => {
    for (const [sourceTrack, clips] of byTrack) {
      // One background track under each track: reused when its time is free.
      const index = d.tracks.findIndex((tr) => tr.id === sourceTrack)
      const below = d.tracks[index + 1]
      const free = (tr: Track): boolean =>
        !d.events.some((e) => e.trackId === tr.id && clips.some((c) => e.start < eventEnd(c) && eventEnd(e) > c.start))
      let track = below && below.kind === 'video' && below.name === BACKGROUND_TRACK && free(below) ? below : null
      if (!track) {
        track = insertTrack(d, 'video', index + 1)
        track.name = BACKGROUND_TRACK
      }
      for (const t of clips) addBackground(d, t, track)
    }
  })
  setStatus(`Blurred background behind ${targets.length} clip${targets.length === 1 ? '' : 's'}`)
  return targets.length

  /** A cropped, blurred and darkened copy of the clip on the background track; the clip itself is shown whole. */
  function addBackground(d: Draft<Project>, t: TimelineEvent, track: Track): void {
    const media = mediaById(t.mediaId) as MediaItem
    const blur = createFx('blur')
    const darken = createFx('colorCorrector')
    if (blur) blur.params.radius = 70
    if (darken) darken.params.brightness = -0.15
    const copy = JSON.parse(JSON.stringify(t)) as TimelineEvent
    d.events.push({
      ...copy,
      id: uid(),
      trackId: track.id,
      groupId: null,
      mask: null,
      transition: null,
      panCrop: [{ time: t.offset, ...coverFrame(media.width, media.height, width, height), ease: 'smooth' }],
      fx: [blur, darken].filter((f): f is NonNullable<typeof f> => f !== null)
    })
    const original = d.events.find((e) => e.id === t.id)
    if (original) original.panCrop = []
  }
}

/** Layout: split screen. Two clips on two video tracks: the upper one fills the top half, the other the bottom half. */
export function splitScreen(eventIds: readonly string[]): boolean {
  const targets = framedEvents(eventIds)
  const order = get().project.tracks.map((t) => t.id)
  targets.sort((a, b) => order.indexOf(a.trackId) - order.indexOf(b.trackId) || a.start - b.start)
  if (targets.length !== 2 || targets[0].trackId === targets[1].trackId) {
    setStatus('Split screen: select two video clips on two different video tracks (the upper one goes on top)')
    return false
  }
  const { width, height } = get().project.settings
  commit((d) => {
    targets.forEach((t, i) => {
      const media = mediaById(t.mediaId) as MediaItem
      const e = d.events.find((o) => o.id === t.id)
      if (e) e.panCrop = [{ time: t.offset, ...halfFrame(media.width, media.height, width, height, i === 0 ? 'top' : 'bottom'), ease: 'smooth' }]
    })
  })
  setStatus('Split screen: top and bottom halves (fine-tune in Event Pan/Crop)')
  return true
}

/** Layout: picture in picture. The clips shrink into a corner (reaction videos, facecam). */
export function pictureInPicture(eventIds: readonly string[], corner: Corner, size = 0.4): number {
  const targets = framedEvents(eventIds)
  if (targets.length === 0) {
    setStatus('Select the video clip to put in the corner')
    return 0
  }
  const { width, height } = get().project.settings
  commit((d) => {
    for (const t of targets) {
      const media = mediaById(t.mediaId) as MediaItem
      const e = d.events.find((o) => o.id === t.id)
      if (e) e.panCrop = [{ time: t.offset, ...cornerFrame(media.width, media.height, width, height, corner, size, 0.04), ease: 'smooth' }]
    }
  })
  setStatus('Picture in picture: drag it in the preview to move it, corners to resize')
  return targets.length
}

/** Highlights key words (*word*) or adds emoji in the selected captions, or in all of them. */
export function enhanceCaptions(kind: 'emphasis' | 'emoji'): number {
  const { project, selection } = get()
  const captions = project.events.filter((e) => e.text && e.text.words)
  const selected = captions.filter((e) => selection.includes(e.id))
  const targets = new Set((selected.length ? selected : captions).map((e) => e.id))
  if (targets.size === 0) {
    setStatus('No captions yet: Tools › Generate Captions, or Captions in the Transcript tab')
    return 0
  }
  let changed = 0
  commit((d) => {
    for (const e of d.events) {
      if (!targets.has(e.id) || !e.text) continue
      const next = kind === 'emphasis' ? emphasizeKeywords(e.text.text) : addEmoji(e.text.text)
      if (next === e.text.text) continue
      e.text.text = next
      if (e.text.words) e.text.words = retimeWords(e.text.words, next)
      changed++
    }
  })
  setStatus(kind === 'emphasis' ? `Highlighted key words in ${changed} captions (edit with *word*)` : `Added emoji to ${changed} captions`)
  return changed
}

/**
 * Keeps only these timeline ranges, in order, and removes everything else on
 * every track (gaps closed, markers follow). Returns how many parts went away.
 */
export function keepRanges(keep: readonly TimeRange[]): number {
  const sorted = [...keep].sort((a, b) => a.start - b.start)
  const merged: TimeRange[] = []
  for (const r of sorted) {
    const last = merged[merged.length - 1]
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end)
    else merged.push({ start: r.start, end: r.end })
  }
  const end = projectEnd(get().project)
  const gaps: TimeRange[] = []
  let at = 0
  for (const r of merged) {
    if (r.start > at) gaps.push({ start: at, end: r.start })
    at = Math.max(at, r.end)
  }
  if (end > at) gaps.push({ start: at, end })
  // From the end, so earlier times stay valid.
  for (const g of gaps.reverse()) {
    clearSelection()
    setTimeSelection(g)
    deleteTimeSelection(true)
  }
  clearTimeSelection()
  return gaps.length
}

/** Replaces the Short candidates (Shorts tab). */
export function setShorts(list: ShortCandidate[]): void {
  set({ shorts: list })
}

/** Stores the transcript of a media file (null removes it). */
export function setTranscript(mediaId: string, transcript: MediaTranscript | null): void {
  set((s) => {
    const transcripts = { ...s.transcripts }
    if (transcript) transcripts[mediaId] = transcript
    else delete transcripts[mediaId]
    return { transcripts }
  })
}

/**
 * Text-based editing: cuts the selected transcript words (each run with the
 * pause after it) out of the events that play them and closes the gaps.
 */
export function deleteWords(words: readonly TimelineWord[], selected: ReadonlySet<number>): number {
  const ranges = rangesForWords(words, selected)
  if (ranges.length === 0) return 0
  const { events } = get().project
  const playing = new Set(words.filter((_, i) => selected.has(i)).map((w) => w.eventId))
  const tracks = new Set(events.filter((e) => playing.has(e.id)).map((e) => e.trackId))
  const ids = events
    .filter((e) => tracks.has(e.trackId) && ranges.some((r) => e.start < r.end && e.start + e.length > r.start))
    .map((e) => e.id)
  const cuts = cutRanges(ids, ranges, 'remove')
  const seconds = ranges.reduce((n, r) => n + r.end - r.start, 0) / FLICKS_PER_SECOND
  setStatus(`Cut ${selected.size} word${selected.size === 1 ? '' : 's'} (${seconds.toFixed(1)} s)`)
  return cuts
}

export interface DuckingOptions {
  /** Level of the music while someone talks. */
  duckDb: number
  /** Seconds to go down before the voice starts, and back up after it stops. */
  attack: number
  release: number
}

/**
 * Auto ducking: writes volume envelopes on the audio events of `trackIds` so
 * they dip while the `voice` ranges (timeline time) play.
 */
export function applyDucking(trackIds: string[], voice: TimeRange[], o: DuckingOptions): number {
  const tracks = new Set(trackIds)
  const duck = Math.pow(10, o.duckDb / 20)
  const attack = Math.max(1, secondsToFlicks(o.attack))
  const release = Math.max(1, secondsToFlicks(o.release))
  // Pauses too short to come back up between them stay ducked.
  const merged = mergeIntervals(voice.map((v) => ({ start: v.start - attack, end: v.end + release }))).map((v) => ({
    start: v.start + attack,
    end: v.end - release
  }))
  const gainAt = (t: Flicks): number => {
    let g = 1
    for (const v of merged) {
      let f = 1
      if (t >= v.start && t <= v.end) f = duck
      else if (t < v.start && t > v.start - attack) f = 1 + ((duck - 1) * (t - (v.start - attack))) / attack
      else if (t > v.end && t < v.end + release) f = duck + ((1 - duck) * (t - v.end)) / release
      if (f < g) g = f
    }
    return g
  }
  let count = 0
  commit((d) => {
    for (const e of d.events) {
      if (!tracks.has(e.trackId) || e.kind !== 'audio') continue
      const from = e.start
      const to = e.start + e.length
      const times = new Set<Flicks>([from, to])
      for (const v of merged) for (const t of [v.start - attack, v.start, v.end, v.end + release]) if (t > from && t < to) times.add(t)
      const points = [...times].sort((a, b) => a - b).map((t) => ({ time: sourceTime(e, t), gain: gainAt(t) }))
      // Drop points in the middle of flat stretches.
      e.envelope = points.filter((p, i) => i === 0 || i === points.length - 1 || !(points[i - 1].gain === p.gain && points[i + 1].gain === p.gain))
      if (e.envelope.every((p) => p.gain === 1)) e.envelope = []
      else count++
    }
  })
  setStatus(count ? `Ducking applied to ${count} event${count > 1 ? 's' : ''}` : 'No music under the voice to duck')
  return count
}

export function clearEnvelopes(trackIds: string[]): void {
  const tracks = new Set(trackIds)
  commit((d) => {
    for (const e of d.events) if (tracks.has(e.trackId) && e.envelope.length) e.envelope = []
  })
  setStatus('Ducking removed')
}

// Transitions

/**
 * Sets the transition into each given video event (null removes it). Grouped
 * audio is ignored: transitions are visual.
 */
export function setTransition(eventIds: string[], type: string | null, duration?: Flicks): number {
  const { project } = get()
  const ids = new Set(
    eventIds
      .map((id) => {
        const e = project.events.find((o) => o.id === id)
        if (!e) return undefined
        if (e.kind === 'video') return e.id
        return e.groupId ? project.events.find((o) => o.groupId === e.groupId && o.kind === 'video')?.id : undefined
      })
      .filter((id): id is string => !!id)
  )
  if (ids.size === 0) {
    setStatus('Select a video or text event for the transition')
    return 0
  }
  commit((d) => {
    for (const e of d.events) {
      if (!ids.has(e.id)) continue
      e.transition = type ? { type, duration: duration ?? e.transition?.duration ?? DEFAULT_TRANSITION_LENGTH } : null
    }
  })
  setStatus(type ? `Transition on ${ids.size} event${ids.size > 1 ? 's' : ''}` : 'Transition removed')
  return ids.size
}

export function openTransitionWindow(eventId?: string): void {
  const { project, selection } = get()
  const ids = eventId ? [eventId] : selection
  const event = project.events.find((e) => ids.includes(e.id) && e.kind === 'video')
  if (!event) {
    setStatus('Select a video or text event to edit its transition')
    return
  }
  set({ dialog: { kind: 'transition', eventId: event.id } })
}

// Event fx

/** The event itself when it has the right kind, else its grouped partner of that kind (video ↔ its sound). */
function fxTarget(project: Project, eventId: string, kind: FxKind): TimelineEvent | undefined {
  const event = project.events.find((e) => e.id === eventId)
  if (!event) return undefined
  if (event.kind === kind) return event
  return event.groupId ? project.events.find((e) => e.groupId === event.groupId && e.kind === kind) : undefined
}

/** Opens the Video FX / Audio FX window for an event, or for the first selected event of that kind. */
export function openFxWindow(kind: FxKind, eventId?: string, focus?: string): void {
  const { project, selection } = get()
  const ids = eventId ? [eventId] : selection
  const event = ids.map((id) => fxTarget(project, id, kind)).find(Boolean)
  if (!event) {
    setStatus(kind === 'video' ? 'Select a video or text event to edit its Video FX' : 'Select an audio event to edit its Audio FX')
    return
  }
  set({ dialog: { kind: 'fx', eventId: event.id, focus } })
}

/** Adds an effect to the given events (their grouped partner when the kind differs). Returns the new effect id of the first one. */
export function addFx(eventIds: string[], type: string): string | null {
  const def = fxDef(type)
  if (!def) return null
  const { project } = get()
  const targets = [...new Set(eventIds.map((id) => fxTarget(project, id, def.kind)?.id).filter((id): id is string => !!id))]
  if (targets.length === 0) {
    setStatus(def.kind === 'video' ? `Select a video or text event to add ${def.label}` : `Select an audio event to add ${def.label}`)
    return null
  }
  let first: string | null = null
  commit((d) => {
    for (const id of targets) {
      const event = d.events.find((e) => e.id === id)
      const fx = createFx(type)
      if (!event || !fx) continue
      event.fx.push(fx)
      first ??= fx.id
    }
  })
  setStatus(`Added ${def.label} to ${targets.length} event${targets.length > 1 ? 's' : ''}`)
  if (first) set({ dialog: { kind: 'fx', eventId: targets[0], focus: first } })
  return first
}

function editFx(eventId: string, recipe: (list: Draft<Project>['events'][number]['fx']) => void): void {
  commit((d) => {
    const event = d.events.find((e) => e.id === eventId)
    if (event) recipe(event.fx)
  })
}

export function removeFx(eventId: string, fxId: string): void {
  editFx(eventId, (list) => {
    const i = list.findIndex((f) => f.id === fxId)
    if (i >= 0) list.splice(i, 1)
  })
}

export function setFxEnabled(eventId: string, fxId: string, enabled: boolean): void {
  editFx(eventId, (list) => {
    const fx = list.find((f) => f.id === fxId)
    if (fx) fx.enabled = enabled
  })
}

export function moveFx(eventId: string, fxId: string, direction: -1 | 1): void {
  editFx(eventId, (list) => {
    const i = list.findIndex((f) => f.id === fxId)
    const j = i + direction
    if (i < 0 || j < 0 || j >= list.length) return
    const [fx] = list.splice(i, 1)
    list.splice(j, 0, fx)
  })
}

export function resetFx(eventId: string, fxId: string): void {
  editFx(eventId, (list) => {
    const fx = list.find((f) => f.id === fxId)
    const fresh = fx ? createFx(fx.type) : null
    if (fx && fresh) fx.params = fresh.params
  })
}

/** Slider moves: rapid changes of one parameter are one undo step. */
export function setFxParam(eventId: string, fxId: string, key: string, value: number): void {
  commitCoalesced(`fx:${eventId}:${fxId}:${key}`, (d) => {
    const fx = d.events.find((e) => e.id === eventId)?.fx.find((f) => f.id === fxId)
    if (fx) fx.params[key] = value
  })
}

/** Sets several parameters at once (presets): one undo step. */
export function setFxParams(eventId: string, fxId: string, params: Record<string, number>): void {
  editFx(eventId, (list) => {
    const fx = list.find((f) => f.id === fxId)
    if (fx) Object.assign(fx.params, params)
  })
}

/** Copies an event's FX chain (replacing theirs) to the other selected events of the same kind. */
export function applyFxToSelection(eventId: string): number {
  const { project, selection } = get()
  const source = project.events.find((e) => e.id === eventId)
  if (!source) return 0
  const targets = new Set(
    selection.map((id) => fxTarget(project, id, source.kind)?.id).filter((id): id is string => !!id && id !== eventId)
  )
  if (targets.size === 0) return 0
  commit((d) => {
    for (const e of d.events) if (targets.has(e.id)) e.fx = cloneFx(source.fx).map((f) => ({ ...f, id: uid() }))
  })
  setStatus(`FX chain applied to ${targets.size} event${targets.size > 1 ? 's' : ''}`)
  return targets.size
}

export function newProject(): void {
  if (get().playing) return
  if (hasUnsavedChanges(get()) && !window.confirm('The project has unsaved changes. Discard them?')) return
  for (const m of get().media) {
    if (m.url.startsWith('blob:')) URL.revokeObjectURL(m.url)
    dropMediaCache(m.id)
  }
  const fresh = emptyProject()
  const transcripts = {}
  const shorts: ShortCandidate[] = []
  set({
    project: fresh,
    savedProject: fresh,
    projectPath: null,
    past: [],
    future: [],
    media: [],
    selection: [],
    selectedTrackId: null,
    timeSelection: null,
    cursor: 0,
    transcripts,
    savedTranscripts: transcripts,
    shorts,
    savedShorts: shorts,
    savedMediaKey: '',
    longVideo: null,
    status: 'New project'
  })
}

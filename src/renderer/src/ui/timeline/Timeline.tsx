import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  AudioLines,
  Blend,
  BookmarkPlus,
  CircleDashed,
  Crop,
  RotateCw,
  Gauge,
  LayoutTemplate,
  Locate,
  MapPin,
  Sparkles,
  TextCursorInput,
  Trash,
  Type
} from 'lucide-react'
import * as A from '../../core/actions'
import { FADE_CURVES, MAX_RATE, MIN_RATE, RATE_PRESETS, clampRate, formatRate } from '../../core/fades'
import { mediaById, useEditor } from '../../core/store'
import { eventEnd, eventsOnTrack, findSnap, projectEnd, snapPoints } from '../../core/timeline'
import {
  type Flicks,
  FLICKS_PER_SECOND,
  flicksToSeconds,
  formatTimecode,
  frameFlicks,
  quantizeToFrame
} from '../../core/time'
import type { TimelineEvent } from '../../core/types'
import { onMediaCacheChange } from '../../media/cache'
import { importFiles, importPaths } from '../../media/importer'
import { registerMediaDrop, useMediaDrag } from '../mediaDrag'
import { type MenuEntry, openContextMenu } from '../ContextMenu'
import { fadeCurveIcon } from '../FadeCurveIcon'
import { isMac, MOD } from '../../platform'
import type { Corner } from '../../core/layouts'
import { TrackHeader, useTrackDrag } from './TrackHeader'
import { type DropPreview, type Rect, drawOverlay, drawRuler, drawTracks } from './draw'
import {
  EDGE_PX,
  FADE_HANDLE_PX,
  FADE_ZONE_H,
  MARKER_BAR_H,
  SNAP_PX,
  TIMELINE_TOP_H,
  TRACKS_TAIL_PX,
  type TrackLayout,
  flicksToPx,
  fxButton,
  layoutAt,
  layoutTracks,
  panCropButton,
  pxToFlicks,
  timeToX,
  tracksHeight,
  xToTime
} from './geometry'

type Zone = 'body' | 'trimL' | 'trimR' | 'fadeIn' | 'fadeOut' | 'panCrop' | 'fx'

type Hit =
  | { kind: 'event'; event: TimelineEvent; zone: Zone; layout: TrackLayout }
  | { kind: 'track'; layout: TrackLayout }
  | { kind: 'empty' }

interface MoveItem {
  id: string
  start: Flicks
  end: Flicks
  trackIndex: number
}

interface TrimItem {
  id: string
  start: Flicks
  length: Flicks
  offset: Flicks
  fadeIn: Flicks
  fadeOut: Flicks
  /** Media length, Infinity for stills. */
  limit: Flicks
  rate: number
  /** The source moves with the left edge (media with a duration, and text: caption word timings). */
  slip: boolean
}

type Drag =
  | {
      kind: 'move'
      x0: number
      y0: number
      moved: boolean
      clickTime: Flicks
      items: MoveItem[]
      anchorIndex: number
      points: Flicks[]
    }
  | {
      kind: 'trim'
      side: 'L' | 'R'
      /** Ctrl+drag: the edge changes the playback rate instead of trimming. */
      stretch: boolean
      x0: number
      y0: number
      moved: boolean
      clickTime: Flicks
      items: TrimItem[]
      edge: Flicks
      points: Flicks[]
    }
  | {
      kind: 'fade'
      side: 'in' | 'out'
      x0: number
      y0: number
      moved: boolean
      clickTime: Flicks
      items: TrimItem[]
    }
  | {
      kind: 'rubber'
      x0: number
      y0: number
      contentY0: number
      moved: boolean
      clickTime: Flicks
      base: string[]
    }
  | {
      /** Dragging out a time selection on empty track space. */
      kind: 'range'
      x0: number
      y0: number
      moved: boolean
      clickTime: Flicks
      anchor: Flicks
      points: Flicks[]
    }

/** Ruler gestures: scrub the cursor handle, draw a time selection, or move one of its edges. */
type RulerDrag =
  | { kind: 'scrub' }
  | { kind: 'select'; x0: number; anchor: Flicks; moved: boolean; points: Flicks[] }
  | { kind: 'edge'; fixed: Flicks; points: Flicks[] }

const get = useEditor.getState

/** Frame-quantized and (when snapping) snapped time for a time-selection edge. */
function selectionTime(t: Flicks, points: Flicks[], freeMove: boolean): { t: Flicks; snapAt: Flicks | null } {
  const s = get()
  let time = Math.max(0, t)
  if (s.options.quantize) time = quantizeToFrame(time, s.project.settings.frameRate)
  if (s.options.snapping && !freeMove) {
    const snap = findSnap([time], points, pxToFlicks(SNAP_PX, s.view))
    if (snap) return { t: snap.at, snapAt: snap.at }
  }
  return { t: time, snapAt: null }
}

/** Menu entries for the time selection (right-click inside it). */
function timeSelectionEntries(): MenuEntry[] {
  return [
    { label: 'Split at Selection Edges', command: 'split' },
    { label: 'Delete Selection', command: 'deleteSelection' },
    { label: 'Ripple Delete Selection', command: 'rippleDelete' },
    { label: 'Trim to Selection', command: 'trimToSelection' },
    'separator',
    { label: 'Play Selection', command: 'playSelection' },
    { label: 'Select Events in Selection', command: 'selectInTimeSelection' },
    { label: 'Zoom to Selection', command: 'zoomToSelection' },
    { label: 'Render Selection...', command: 'render' },
    'separator',
    { label: 'Clear Time Selection', command: 'clearTimeSelection' }
  ]
}
const MAX_CONTENT_PX = 30_000_000

/** Owns the three timeline canvases and redraws them only when something changed. */
class TimelineCanvases {
  tracksDirty = true
  overlayDirty = true
  rulerDirty = true
  width = 0
  height = 0
  drop: DropPreview | null = null
  rubber: Rect | null = null
  private raf = 0
  private readonly unsubscribe: Array<() => void> = []

  constructor(
    private readonly tracks: HTMLCanvasElement,
    private readonly overlay: HTMLCanvasElement,
    private readonly ruler: HTMLCanvasElement
  ) {
    this.unsubscribe.push(
      useEditor.subscribe((s, p) => {
        if (
          s.project !== p.project ||
          s.media !== p.media ||
          s.selection !== p.selection ||
          s.view !== p.view ||
          s.options !== p.options ||
          s.selectedTrackId !== p.selectedTrackId
        ) {
          this.tracksDirty = true
          this.rulerDirty = true
          this.overlayDirty = true
        }
        if (
          s.cursor !== p.cursor ||
          s.playing !== p.playing ||
          s.snapLine !== p.snapLine ||
          s.timeSelection !== p.timeSelection ||
          s.cutPreview !== p.cutPreview
        ) {
          this.overlayDirty = true
          this.rulerDirty = true
        }
      })
    )
    this.unsubscribe.push(onMediaCacheChange(() => (this.tracksDirty = true)))
    this.raf = requestAnimationFrame(this.loop)
  }

  resize(width: number, height: number): void {
    const dpr = window.devicePixelRatio || 1
    this.width = width
    this.height = height
    for (const [canvas, h] of [
      [this.tracks, height],
      [this.overlay, height],
      [this.ruler, TIMELINE_TOP_H]
    ] as const) {
      canvas.width = Math.max(1, Math.round(width * dpr))
      canvas.height = Math.max(1, Math.round(h * dpr))
      canvas.style.width = `${width}px`
      canvas.style.height = `${h}px`
    }
    this.tracksDirty = this.overlayDirty = this.rulerDirty = true
  }

  private context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    return ctx
  }

  private readonly loop = (): void => {
    this.raf = requestAnimationFrame(this.loop)
    if (this.width === 0) return
    const s = get()
    if (this.tracksDirty) {
      this.tracksDirty = false
      drawTracks(this.context(this.tracks), this.width, this.height, s, layoutTracks(s.project.tracks))
    }
    if (this.overlayDirty) {
      this.overlayDirty = false
      drawOverlay(this.context(this.overlay), this.width, this.height, s, this.drop, this.rubber, layoutTracks(s.project.tracks))
    }
    if (this.rulerDirty) {
      this.rulerDirty = false
      drawRuler(this.context(this.ruler), this.width, TIMELINE_TOP_H, s)
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.raf)
    for (const off of this.unsubscribe) off()
  }
}

function hitTest(x: number, y: number): Hit {
  const s = get()
  const { view } = s
  const layouts = layoutTracks(s.project.tracks)
  const contentY = y + view.scrollY
  const layout = layoutAt(layouts, contentY)
  if (!layout) return { kind: 'empty' }
  const events = eventsOnTrack(s.project, layout.track.id)
  const rowY = contentY - layout.top
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    const ex = timeToX(event.start, view)
    const ew = flicksToPx(event.length, view)
    if (x < ex || x > ex + ew) continue
    if (rowY <= FADE_ZONE_H) {
      const fadeOutX = ex + ew - flicksToPx(event.fadeOut, view)
      const fadeInX = ex + flicksToPx(event.fadeIn, view)
      if (Math.abs(x - fadeOutX) <= FADE_HANDLE_PX) return { kind: 'event', event, zone: 'fadeOut', layout }
      if (Math.abs(x - fadeInX) <= FADE_HANDLE_PX) return { kind: 'event', event, zone: 'fadeIn', layout }
    }
    const mediaVideo = event.kind === 'video' && !event.text
    const fx = fxButton(ex, ew, 1, mediaVideo)
    if (fx && x >= fx.x && x <= fx.x + fx.size && rowY >= fx.y && rowY <= fx.y + fx.size) {
      return { kind: 'event', event, zone: 'fx', layout }
    }
    if (mediaVideo) {
      const button = panCropButton(ex, ew, 1)
      if (button && x >= button.x && x <= button.x + button.size && rowY >= button.y && rowY <= button.y + button.size) {
        return { kind: 'event', event, zone: 'panCrop', layout }
      }
    }
    const edge = Math.min(EDGE_PX, ew / 4)
    if (x - ex <= edge) return { kind: 'event', event, zone: 'trimL', layout }
    if (ex + ew - x <= edge) return { kind: 'event', event, zone: 'trimR', layout }
    return { kind: 'event', event, zone: 'body', layout }
  }
  return { kind: 'track', layout }
}

const HOVER_CURSORS: Record<Zone, string> = {
  body: 'default',
  trimL: 'col-resize',
  trimR: 'col-resize',
  fadeIn: 'nesw-resize',
  fadeOut: 'nwse-resize',
  panCrop: 'pointer',
  fx: 'pointer'
}

/** Ctrl over an event edge: time stretch, shown as a double arrow with a wave. */
const STRETCH_CURSOR = ((): string => {
  const path = 'M2 12h4l2-3 2.7 6 2.6-6 2.7 6 2-3h4M6 8l-4 4 4 4M18 8l4 4-4 4'
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke-linecap='round' stroke-linejoin='round'>" +
    `<path d='${path}' stroke='white' stroke-width='4'/><path d='${path}' stroke='black' stroke-width='1.5'/></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, ew-resize`
})()

/** Ctrl+drag on an edge stretches media events; on stills and text it trims as usual. */
const isStretch = (hit: Hit, ctrl: boolean): boolean =>
  ctrl && hit.kind === 'event' && (hit.zone === 'trimL' || hit.zone === 'trimR') && A.canStretch(hit.event)

function hoverCursor(hit: Hit, ctrl: boolean): string {
  if (hit.kind !== 'event') return 'default'
  return isStretch(hit, ctrl) ? STRETCH_CURSOR : HOVER_CURSORS[hit.zone]
}

function trimItems(events: TimelineEvent[]): TrimItem[] {
  return events.map((o) => {
    const media = mediaById(o.mediaId)
    return {
      id: o.id,
      start: o.start,
      length: o.length,
      offset: o.offset,
      fadeIn: o.fadeIn,
      fadeOut: o.fadeOut,
      limit: !media || media.kind === 'image' ? Infinity : media.duration,
      rate: o.rate,
      slip: o.text !== null || (!!media && media.kind !== 'image')
    }
  })
}

/** The clicked event plus grouped events whose matching edge lines up with it. */
function alignedGroup(event: TimelineEvent, edge: 'start' | 'end'): TimelineEvent[] {
  const at = edge === 'start' ? event.start : eventEnd(event)
  return get().project.events.filter(
    (o) =>
      o.id === event.id ||
      (event.groupId !== null && o.groupId === event.groupId && (edge === 'start' ? o.start : eventEnd(o)) === at)
  )
}

function beginEventDrag(
  hit: Extract<Hit, { kind: 'event' }>,
  x: number,
  y: number,
  clickTime: Flicks,
  stretch = false
): Drag | null {
  const s = get()
  const event = hit.event
  if (hit.zone === 'body') {
    if (!s.selection.includes(event.id)) return null
    const ids = new Set(s.selection)
    const layouts = layoutTracks(s.project.tracks)
    const items = s.project.events
      .filter((o) => ids.has(o.id))
      .map((o) => ({
        id: o.id,
        start: o.start,
        end: eventEnd(o),
        trackIndex: layouts.findIndex((l) => l.track.id === o.trackId)
      }))
    return {
      kind: 'move',
      x0: x,
      y0: y,
      moved: false,
      clickTime,
      items,
      anchorIndex: hit.layout.index,
      points: snapPoints(s.project, s.cursor, ids)
    }
  }
  if (hit.zone === 'trimL' || hit.zone === 'trimR') {
    const side = hit.zone === 'trimL' ? 'L' : 'R'
    const members = alignedGroup(event, side === 'L' ? 'start' : 'end').filter((m) => !stretch || A.canStretch(m))
    return {
      kind: 'trim',
      side,
      stretch,
      x0: x,
      y0: y,
      moved: false,
      clickTime,
      items: trimItems(members),
      edge: side === 'L' ? event.start : eventEnd(event),
      points: snapPoints(s.project, s.cursor, new Set(members.map((m) => m.id)))
    }
  }
  const side = hit.zone === 'fadeIn' ? 'in' : 'out'
  return {
    kind: 'fade',
    side,
    x0: x,
    y0: y,
    moved: false,
    clickTime,
    items: trimItems(alignedGroup(event, side === 'in' ? 'start' : 'end'))
  }
}

function applyDrag(drag: Exclude<Drag, { kind: 'rubber' | 'range' }>, x: number, y: number, freeMove: boolean): void {
  const s = get()
  const { view, options } = s
  const frameRate = s.project.settings.frameRate
  const snapThreshold = pxToFlicks(SNAP_PX, view)

  if (drag.kind === 'move') {
    let dt = pxToFlicks(x - drag.x0, view)
    if (options.quantize) dt = quantizeToFrame(dt, frameRate)
    const minStart = Math.min(...drag.items.map((i) => i.start))
    dt = Math.max(dt, -minStart)
    let snapAt: Flicks | null = null
    if (options.snapping && !freeMove) {
      const edges = drag.items.flatMap((i) => [i.start + dt, i.end + dt])
      const snap = findSnap(edges, drag.points, snapThreshold)
      if (snap && dt + snap.delta >= -minStart) {
        dt += snap.delta
        snapAt = snap.at
      }
    }
    const layouts = layoutTracks(s.project.tracks)
    const over = layoutAt(layouts, y + view.scrollY)
    const anchor = layouts[drag.anchorIndex]
    // Vertical moves count tracks of the dragged event's kind (video among video
    // tracks, audio among audio tracks); grouped events of the other kind stay
    // on their track, so a clip with its sound can move to another video track.
    const sameKind = anchor ? layouts.filter((l) => l.track.kind === anchor.track.kind) : []
    const ordinal = (index: number): number => sameKind.findIndex((l) => l.index === index)
    let dOrd = 0
    if (anchor && over && over.track.kind === anchor.track.kind) dOrd = ordinal(over.index) - ordinal(drag.anchorIndex)
    if (
      dOrd !== 0 &&
      !drag.items.every((i) => {
        const from = layouts[i.trackIndex]
        if (!from || from.track.kind !== anchor?.track.kind) return true
        return sameKind[ordinal(i.trackIndex) + dOrd] !== undefined
      })
    ) {
      dOrd = 0
    }
    A.updateGesture((d) => {
      for (const item of drag.items) {
        const ev = d.events.find((o) => o.id === item.id)
        if (!ev) continue
        ev.start = item.start + dt
        const from = layouts[item.trackIndex]
        if (!from) continue
        const target = from.track.kind === anchor?.track.kind ? sameKind[ordinal(item.trackIndex) + dOrd] : from
        if (target) ev.trackId = target.track.id
      }
    })
    useEditor.setState({ snapLine: snapAt })
    return
  }

  if (drag.kind === 'trim') {
    let dt = pxToFlicks(x - drag.x0, view)
    if (options.quantize) dt = quantizeToFrame(dt, frameRate)
    const frame = frameFlicks(frameRate)
    let lo = -Infinity
    let hi = Infinity
    for (const i of drag.items) {
      if (drag.stretch) {
        // The event keeps the same source range: its length sets the rate.
        const source = i.length * i.rate
        const minLength = Math.max(frame, source / MAX_RATE)
        const maxLength = source / MIN_RATE
        if (drag.side === 'L') {
          lo = Math.max(lo, -i.start, i.length - maxLength)
          hi = Math.min(hi, i.length - minLength)
        } else {
          lo = Math.max(lo, minLength - i.length)
          hi = Math.min(hi, maxLength - i.length)
        }
        continue
      }
      if (drag.side === 'L') {
        lo = Math.max(lo, -i.start)
        if (i.limit !== Infinity) lo = Math.max(lo, -i.offset / i.rate)
        hi = Math.min(hi, i.length - frame)
      } else {
        lo = Math.max(lo, frame - i.length)
        if (i.limit !== Infinity) hi = Math.min(hi, (i.limit - i.offset) / i.rate - i.length)
      }
    }
    lo = Math.ceil(lo)
    hi = Math.floor(hi)
    if (lo > hi) return
    let snapAt: Flicks | null = null
    if (options.snapping && !freeMove) {
      const snap = findSnap([drag.edge + dt], drag.points, snapThreshold)
      if (snap && dt + snap.delta >= lo && dt + snap.delta <= hi) {
        dt += snap.delta
        snapAt = snap.at
      }
    }
    dt = Math.min(hi, Math.max(lo, dt))
    A.updateGesture((d) => {
      for (const i of drag.items) {
        const ev = d.events.find((o) => o.id === i.id)
        if (!ev) continue
        if (drag.side === 'L') {
          ev.start = i.start + dt
          ev.length = i.length - dt
          if (!drag.stretch && i.slip) ev.offset = i.offset + Math.round(dt * i.rate)
        } else {
          ev.length = i.length + dt
        }
        if (drag.stretch) ev.rate = clampRate((i.rate * i.length) / ev.length)
        ev.fadeIn = Math.min(i.fadeIn, ev.length)
        ev.fadeOut = Math.min(i.fadeOut, ev.length - ev.fadeIn)
      }
    })
    useEditor.setState({ snapLine: snapAt })
    const first = drag.items[0]
    if (drag.stretch && first) {
      const length = drag.side === 'L' ? first.length - dt : first.length + dt
      A.setStatus(`Playback rate ${formatRate((first.rate * first.length) / length)} (${MOD}+drag)`)
    }
    return
  }

  const t = xToTime(x, view)
  A.updateGesture((d) => {
    for (const i of drag.items) {
      const ev = d.events.find((o) => o.id === i.id)
      if (!ev) continue
      if (drag.side === 'in') {
        let f = Math.min(i.length - i.fadeOut, Math.max(0, t - i.start))
        if (options.quantize) f = Math.min(i.length - i.fadeOut, quantizeToFrame(f, frameRate))
        ev.fadeIn = f
      } else {
        let f = Math.min(i.length - i.fadeIn, Math.max(0, i.start + i.length - t))
        if (options.quantize) f = Math.min(i.length - i.fadeIn, quantizeToFrame(f, frameRate))
        ev.fadeOut = f
      }
    }
  })
  const first = drag.items[0]
  const ev = first && get().project.events.find((o) => o.id === first.id)
  if (ev) A.setStatus(`Fade ${drag.side}: ${flicksToSeconds(drag.side === 'in' ? ev.fadeIn : ev.fadeOut).toFixed(2)} s · right-click the fade for its curve`)
}

/** Event-specific tools: text, Pan/Crop, mask and the FX windows (also for a grouped partner). */
function eventToolEntries(ev: TimelineEvent): MenuEntry[] {
  const entries: MenuEntry[] = []
  const partner = (kind: 'video' | 'audio'): boolean =>
    ev.kind === kind || (ev.groupId !== null && get().project.events.some((o) => o.groupId === ev.groupId && o.kind === kind))
  if (ev.text) entries.push({ label: 'Edit Text...', icon: TextCursorInput, run: () => A.openTextEditor(ev.id) })
  if (ev.text?.words) {
    entries.push({ label: 'Highlight Key Words', command: 'highlightKeywords' }, { label: 'Add Emoji', command: 'addEmoji' })
  }
  if (ev.kind === 'video' && !ev.text) entries.push({ label: 'Event Pan/Crop...', icon: Crop, run: () => A.openPanCrop(ev.id) })
  if (partner('video')) entries.push({ label: 'Video FX...', icon: Sparkles, run: () => A.openFxWindow('video', ev.id) })
  if (partner('audio')) entries.push({ label: 'Audio FX...', icon: AudioLines, run: () => A.openFxWindow('audio', ev.id) })
  if (ev.kind === 'video') entries.push({ label: 'Event Mask...', icon: CircleDashed, run: () => A.openMaskEditor(ev.id) })
  if (partner('video')) entries.push({ label: ev.transition ? 'Transition...' : 'Add Transition...', icon: Blend, run: () => A.openTransitionWindow(ev.id) })
  if (partner('audio')) entries.push({ label: 'Remove Silences...', command: 'removeSilences' })
  if (ev.kind === 'audio') entries.push({ label: 'Save as Sound Effect...', icon: BookmarkPlus, run: () => A.openSaveSoundEffect(ev.id) })
  return entries
}

/** Layout submenu for vertical videos: blurred background, split screen, picture in picture. */
function layoutEntry(): MenuEntry {
  const ids = (): string[] => get().selection
  const corner = (label: string, c: Corner): MenuEntry => ({ label, run: () => A.pictureInPicture(ids(), c) })
  return {
    label: 'Layout',
    icon: LayoutTemplate,
    submenu: [
      { label: 'Blurred Background', command: 'blurredBackground' },
      { label: 'Split Screen (select 2 clips)', command: 'splitScreen' },
      'separator',
      { header: 'Picture in picture' },
      corner('Top Right', 'topRight'),
      corner('Top Left', 'topLeft'),
      corner('Bottom Right', 'bottomRight'),
      corner('Bottom Left', 'bottomLeft')
    ]
  }
}

/** Rotate submenu for video, image and text events (the preview also rotates from just outside a corner). */
function rotateEntry(): MenuEntry {
  return {
    label: 'Rotate',
    icon: RotateCw,
    submenu: [
      { label: '90° Clockwise', command: 'rotateClockwise' },
      { label: '90° Counterclockwise', command: 'rotateCounterclockwise' },
      { label: 'Reset Rotation', command: 'resetRotation' },
      'separator',
      { label: 'Tip: drag just outside a corner in the preview', disabled: true }
    ]
  }
}

/** The fade whose region (from the event edge to the fade handle) contains timeline time `at`. */
function fadeSideAt(ev: TimelineEvent, at: Flicks): 'in' | 'out' | null {
  if (ev.fadeIn > 0 && at - ev.start <= ev.fadeIn) return 'in'
  if (ev.fadeOut > 0 && eventEnd(ev) - at <= ev.fadeOut) return 'out'
  return null
}

/** The selected events when `ev` is one of them, else just `ev`. */
function targetIds(ev: TimelineEvent): string[] {
  const selection = get().selection
  return selection.includes(ev.id) ? selection : [ev.id]
}

/** Fade Type submenu: the curve of the fade in or out (Fast, Linear, Slow, Smooth, Sharp). */
function fadeTypeEntry(ev: TimelineEvent, side: 'in' | 'out', label: string): MenuEntry {
  const current = side === 'in' ? ev.fadeInCurve : ev.fadeOutCurve
  return {
    label,
    icon: fadeCurveIcon(current, side),
    submenu: FADE_CURVES.map((c) => ({
      label: c.label,
      icon: fadeCurveIcon(c.id, side),
      selected: c.id === current,
      run: () => A.setFadeCurve(targetIds(ev), side, c.id)
    }))
  }
}

/** Playback Rate submenu: speed presets (Ctrl+drag an edge sets any rate in between). */
function playbackRateEntry(ev: TimelineEvent): MenuEntry {
  const isRate = (r: number): boolean => Math.abs(ev.rate - r) < 1e-3
  const submenu: MenuEntry[] = RATE_PRESETS.map((r) => ({
    label: r === 1 ? `${formatRate(r)} (normal)` : `${formatRate(r)} ${r < 1 ? '(slower)' : '(faster)'}`,
    checked: isRate(r),
    run: () => A.setPlaybackRate(targetIds(ev), r)
  }))
  if (!RATE_PRESETS.some(isRate)) submenu.unshift({ header: `Current ${formatRate(ev.rate)}` }, 'separator')
  submenu.push('separator', { label: `Tip: ${MOD}+drag an edge for any speed`, disabled: true })
  return { label: 'Playback Rate', icon: Gauge, submenu }
}

/** Right-click menu for an event, a track or the empty area. */
function contextEntries(hit: Hit, at: Flicks): MenuEntry[] {
  const range = get().timeSelection
  if (range && at >= range.start && at <= range.end) {
    // Inside the time selection: on an event the edits apply to that event (and
    // its group), on empty space to every track.
    const entries = timeSelectionEntries()
    if (hit.kind === 'event') {
      const ev = hit.event
      if (!get().selection.includes(ev.id)) A.selectEvents([ev.id], 'replace')
      entries.push('separator', ...eventToolEntries(ev))
    } else {
      A.clearSelection()
    }
    return entries
  }
  if (hit.kind === 'event') {
    const ev = hit.event
    if (!get().selection.includes(ev.id)) A.selectEvents([ev.id], 'replace')
    // Right-click inside a fade: its curve comes first.
    const fadeSide = fadeSideAt(ev, at)
    const entries: MenuEntry[] = fadeSide ? [fadeTypeEntry(ev, fadeSide, 'Fade Type'), 'separator'] : []
    entries.push(
      { label: 'Cut', command: 'cut' },
      { label: 'Copy', command: 'copy' },
      { label: 'Paste', command: 'paste' },
      'separator',
      { label: 'Split', command: 'split' },
      { label: 'Delete', command: 'deleteSelection' },
      { label: 'Ripple Delete', command: 'rippleDelete' },
      'separator',
      ...eventToolEntries(ev)
    )
    if (ev.kind === 'video' && !ev.text) {
      entries.push({ label: 'Fill Frame', command: 'fillFrame' }, { label: 'Fit Frame', command: 'fitFrame' }, layoutEntry())
    }
    if (ev.kind === 'video') entries.push(rotateEntry())
    if (A.canStretch(ev)) entries.push(playbackRateEntry(ev))
    entries.push('separator')
    if (!fadeSide && ev.fadeIn > 0) entries.push(fadeTypeEntry(ev, 'in', 'Fade In Type'))
    if (!fadeSide && ev.fadeOut > 0) entries.push(fadeTypeEntry(ev, 'out', 'Fade Out Type'))
    const ids = new Set(get().selection)
    const anyFade = get().project.events.some((o) => ids.has(o.id) && (o.fadeIn > 0 || o.fadeOut > 0))
    entries.push(
      { label: 'Remove Fades', command: 'removeFades', disabled: !anyFade },
      'separator',
      { label: 'Group Selected Events', command: 'group' },
      { label: 'Remove from Group', command: 'ungroup' }
    )
    return entries
  }
  const entries: MenuEntry[] = [
    { label: 'Paste at Cursor', command: 'paste' },
    { label: 'Insert Text Here', icon: Type, run: () => A.addTextEvent('title', at, hit.kind === 'track' ? hit.layout.track.id : null) },
    'separator',
    { label: 'Insert Video Track', command: 'addVideoTrack' },
    { label: 'Insert Audio Track', command: 'addAudioTrack' }
  ]
  if (hit.kind === 'track') {
    const trackId = hit.layout.track.id
    const index = hit.layout.index
    const count = get().project.tracks.length
    entries.push(
      'separator',
      { label: 'Move Track Up', icon: ArrowUp, disabled: index === 0, run: () => A.moveTrack(trackId, index - 1) },
      { label: 'Move Track Down', icon: ArrowDown, disabled: index >= count - 1, run: () => A.moveTrack(trackId, index + 1) },
      { label: 'Delete Track', icon: Trash, danger: true, run: () => A.removeTrack(trackId) }
    )
  }
  return entries
}

function TrackDropLine(): React.JSX.Element | null {
  const lineY = useTrackDrag((s) => s.lineY)
  return lineY === null ? null : <div className="th-drop-line" style={{ top: lineY - 1 }} />
}

function CursorTimecode(): React.JSX.Element {
  const cursor = useEditor((s) => s.cursor)
  const rate = useEditor((s) => s.project.settings.frameRate)
  return <div className="tl-timecode">{formatTimecode(cursor, rate)}</div>
}

export function Timeline(): React.JSX.Element {
  const tracks = useEditor((s) => s.project.tracks)
  const view = useEditor((s) => s.view)
  const end = useEditor((s) => projectEnd(s.project))
  const scrollRef = useRef<HTMLDivElement>(null)
  const tracksRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const rulerRef = useRef<HTMLCanvasElement>(null)
  const canvasesRef = useRef<TimelineCanvases | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const rulerDragRef = useRef<RulerDrag | null>(null)
  /** Last pointer position over the tracks (null when outside), for cursor updates on Ctrl. */
  const hoverRef = useRef<{ x: number; y: number } | null>(null)
  const [size, setSize] = useState({ width: 800, height: 300 })

  // Pressing or releasing Ctrl over an event edge switches between the trim and stretch cursors.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const canvas = overlayRef.current
      const at = hoverRef.current
      if ((e.key !== 'Control' && e.key !== 'Meta') || !canvas || !at || dragRef.current) return
      canvas.style.cursor = hoverCursor(hitTest(at.x, at.y), e.type === 'keydown')
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
    }
  }, [])

  useEffect(() => {
    const canvases = new TimelineCanvases(tracksRef.current!, overlayRef.current!, rulerRef.current!)
    canvasesRef.current = canvases
    const el = scrollRef.current!
    const observer = new ResizeObserver(() => {
      const width = el.clientWidth
      const height = el.clientHeight
      A.timelineViewport.width = width
      A.timelineViewport.height = height
      setSize({ width, height })
      canvases.resize(width, height)
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      canvases.dispose()
      canvasesRef.current = null
    }
  }, [])

  // The store owns the scroll position (zoom changes it); mirror it into the DOM.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (Math.abs(el.scrollLeft - view.scrollX) > 1) el.scrollLeft = view.scrollX
    if (Math.abs(el.scrollTop - view.scrollY) > 1) el.scrollTop = view.scrollY
  }, [view.scrollX, view.scrollY, view.pxPerSecond])

  // Keep the cursor visible while playing, or when moved off screen by the keyboard.
  useEffect(
    () =>
      useEditor.subscribe((s, p) => {
        if (s.cursor === p.cursor || dragRef.current || rulerDragRef.current) return
        const width = A.timelineViewport.width
        const x = (s.cursor / FLICKS_PER_SECOND) * s.view.pxPerSecond - s.view.scrollX
        if (s.playing ? x > width - 20 || x < 0 : x > width || x < 0) {
          const target = s.playing ? x + s.view.scrollX - 40 : x + s.view.scrollX - width / 2
          A.setView({ scrollX: Math.max(0, target) })
        }
      }),
    []
  )

  // Wheel: zoom (default), Ctrl = horizontal scroll, Shift = vertical scroll.
  useEffect(() => {
    const canvas = overlayRef.current!
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const el = scrollRef.current
      if (!el) return
      const rect = canvas.getBoundingClientRect()
      const delta = e.deltaMode === 1 ? e.deltaY * 32 : e.deltaY
      if (isMac && e.ctrlKey) A.zoomAround(Math.exp(-delta / 100), e.clientX - rect.left)
      else if (isMac ? e.metaKey : e.ctrlKey) el.scrollLeft += delta
      else if (e.shiftKey) el.scrollTop += delta
      else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) el.scrollLeft += e.deltaX
      else A.zoomAround(delta < 0 ? 1.25 : 1 / 1.25, e.clientX - rect.left)
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [])

  // Media dragged from Project Media.
  useEffect(() => {
    const inside = (cx: number, cy: number): DOMRect | null => {
      const canvas = overlayRef.current
      if (!canvas) return null
      const r = canvas.getBoundingClientRect()
      return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom ? r : null
    }
    const offDrop = registerMediaDrop((mediaId, cx, cy) => {
      const r = inside(cx, cy)
      if (!r) return false
      const s = get()
      const layout = layoutAt(layoutTracks(s.project.tracks), cy - r.top + s.view.scrollY)
      const at = xToTime(cx - r.left, s.view)
      if (mediaId.startsWith('tr:')) {
        const hit = hitTest(cx - r.left, cy - r.top)
        if (hit.kind !== 'event') {
          A.setStatus('Drop the transition on the clip after the cut')
          return true
        }
        const ids = s.selection.includes(hit.event.id) ? s.selection : [hit.event.id]
        A.setTransition(ids, mediaId.slice(3))
        return true
      }
      if (mediaId.startsWith('fx:')) {
        // An effect dropped on an event goes to it (and to the rest of the selection when it is selected).
        const hit = hitTest(cx - r.left, cy - r.top)
        if (hit.kind !== 'event') {
          A.setStatus('Drop the effect on an event')
          return true
        }
        const ids = s.selection.includes(hit.event.id) ? s.selection : [hit.event.id]
        A.addFx(ids, mediaId.slice(3))
        return true
      }
      if (mediaId.startsWith('path:')) {
        // A file from the Explorer tab: import it, then place it where it was dropped.
        const target = layout ? layout.track.id : 'new'
        void importPaths([mediaId.slice(5)])[0].then((media) => media && A.addMediaToTimeline(media.id, at, target))
        return true
      }
      if (mediaId.startsWith('text:')) A.addTextEvent(mediaId.slice(5), at, layout?.track.id ?? null)
      else A.addMediaToTimeline(mediaId, at, layout ? layout.track.id : 'new')
      return true
    })
    const offPreview = useMediaDrag.subscribe(({ drag }) => {
      const canvases = canvasesRef.current
      if (!canvases) return
      let preview: DropPreview | null = null
      const r = drag ? inside(drag.x, drag.y) : null
      if (drag && r) {
        const s = get()
        const media = mediaById(drag.mediaId)
        const y = drag.y - r.top + s.view.scrollY
        const layout = layoutAt(layoutTracks(s.project.tracks), y)
        if (drag.mediaId.startsWith('fx:') || drag.mediaId.startsWith('tr:')) {
          canvases.drop = null
          canvases.overlayDirty = true
          return
        }
        const length = drag.mediaId.startsWith('path:')
          ? 0
          : drag.mediaId.startsWith('text:')
          ? A.TEXT_DEFAULT_LENGTH
          : media
            ? media.kind === 'image'
              ? A.IMAGE_DEFAULT_LENGTH
              : media.duration
            : 0
        preview = {
          x: drag.x - r.left,
          width: flicksToPx(length, s.view),
          rowTop: (layout ? layout.top : tracksHeight(s.project.tracks)) - s.view.scrollY,
          rowHeight: layout ? layout.height : 70
        }
      }
      canvases.drop = preview
      canvases.overlayDirty = true
    })
    return () => {
      offDrop()
      offPreview()
    }
  }, [])

  const local = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = overlayRef.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const { x, y } = local(e)
    const s = get()
    const clickTime = xToTime(x, s.view)
    const hit = hitTest(x, y)
    const additive = e.ctrlKey || e.metaKey
    if (hit.kind === 'event' && hit.zone === 'panCrop') {
      A.selectEvents([hit.event.id], 'replace')
      A.openPanCrop(hit.event.id)
      return
    }
    if (hit.kind === 'event' && hit.zone === 'fx') {
      A.selectEvents([hit.event.id], 'replace')
      A.openFxWindow(hit.event.kind, hit.event.id)
      return
    }
    if (hit.kind === 'event') {
      // Ctrl+drag on an edge: time stretch (the event plays faster or slower).
      const stretch = isStretch(hit, additive)
      if (stretch) {
        if (!s.selection.includes(hit.event.id)) A.selectEvents([hit.event.id], 'replace')
      } else if (additive) A.selectEvents([hit.event.id], 'toggle')
      else if (!s.selection.includes(hit.event.id) || hit.zone !== 'body') A.selectEvents([hit.event.id], 'replace')
      const drag = beginEventDrag(hit, x, y, clickTime, stretch)
      dragRef.current = drag
      if (drag) A.beginGesture()
      return
    }
    A.selectTrack(null)
    if (e.shiftKey || additive) {
      // Shift/Ctrl + drag on empty space: rectangle selection of events.
      if (!additive) A.clearSelection()
      dragRef.current = {
        kind: 'rubber',
        x0: x,
        y0: y,
        contentY0: y + s.view.scrollY,
        moved: false,
        clickTime,
        base: additive ? s.selection : []
      }
      return
    }
    // Plain drag on empty space: time selection across all tracks.
    A.clearSelection()
    const points = snapPoints(s.project, s.cursor, new Set())
    dragRef.current = {
      kind: 'range',
      x0: x,
      y0: y,
      moved: false,
      clickTime,
      anchor: selectionTime(clickTime, points, e.altKey).t,
      points
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const { x, y } = local(e)
    const drag = dragRef.current
    if (!drag) {
      hoverRef.current = { x, y }
      e.currentTarget.style.cursor = hoverCursor(hitTest(x, y), e.ctrlKey || e.metaKey)
      return
    }
    if (!drag.moved) {
      if (Math.abs(x - drag.x0) < 3 && Math.abs(y - drag.y0) < 3) return
      drag.moved = true
    }
    if (drag.kind === 'range') {
      const { t, snapAt } = selectionTime(xToTime(x, get().view), drag.points, e.altKey)
      A.setTimeSelection({ start: Math.min(drag.anchor, t), end: Math.max(drag.anchor, t) })
      useEditor.setState({ snapLine: snapAt })
      return
    }
    if (drag.kind !== 'rubber') {
      applyDrag(drag, x, y, e.altKey)
      return
    }
    const s = get()
    const contentY = y + s.view.scrollY
    const tA = xToTime(Math.min(drag.x0, x), s.view)
    const tB = xToTime(Math.max(drag.x0, x), s.view)
    const yA = Math.min(drag.contentY0, contentY)
    const yB = Math.max(drag.contentY0, contentY)
    const layouts = new Map(layoutTracks(s.project.tracks).map((l) => [l.track.id, l]))
    const hits = s.project.events
      .filter((ev) => {
        const l = layouts.get(ev.trackId)
        return l && l.top < yB && l.top + l.height > yA && ev.start < tB && eventEnd(ev) > tA
      })
      .map((ev) => ev.id)
    useEditor.setState({ selection: [...new Set([...drag.base, ...hits])] })
    const canvases = canvasesRef.current
    if (canvases) {
      canvases.rubber = { x0: drag.x0, y0: drag.contentY0 - s.view.scrollY, x1: x, y1: y }
      canvases.overlayDirty = true
    }
  }

  const finishDrag = (cancelled: boolean): void => {
    const drag = dragRef.current
    dragRef.current = null
    if (!drag) return
    if (drag.kind === 'range') {
      useEditor.setState({ snapLine: null })
      if (cancelled) return
      if (!drag.moved) {
        // A plain click on empty space clears the time selection.
        A.clearTimeSelection()
        A.setCursor(drag.clickTime)
        return
      }
      const range = get().timeSelection
      if (range) A.setCursor(range.start)
      return
    }
    if (drag.kind === 'rubber') {
      const canvases = canvasesRef.current
      if (canvases) {
        canvases.rubber = null
        canvases.overlayDirty = true
      }
      if (!drag.moved && !cancelled) A.setCursor(drag.clickTime)
      return
    }
    if (cancelled) A.cancelGesture()
    else A.endGesture()
    if (!drag.moved && !cancelled) A.setCursor(drag.clickTime)
  }

  const onRulerPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - r.left
    const y = e.clientY - r.top
    const s = get()
    if (y < MARKER_BAR_H) {
      const marker = s.project.markers.find((m) => {
        const mx = timeToX(m.time, s.view)
        return x >= mx - 3 && x <= mx + 28
      })
      if (marker) {
        if (e.button === 2 || e.altKey) A.removeMarker(marker.id)
        else A.setCursor(marker.time)
        return
      }
    }
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const points = snapPoints(s.project, s.cursor, new Set())
    const range = s.timeSelection
    // Edges of an existing time selection can be dragged.
    if (range && Math.abs(x - timeToX(range.start, s.view)) <= 5) {
      rulerDragRef.current = { kind: 'edge', fixed: range.end, points }
      return
    }
    if (range && Math.abs(x - timeToX(range.end, s.view)) <= 5) {
      rulerDragRef.current = { kind: 'edge', fixed: range.start, points }
      return
    }
    // Grabbing the cursor handle scrubs; anywhere else a drag draws a time selection.
    if (Math.abs(x - timeToX(s.cursor, s.view)) <= 7) {
      rulerDragRef.current = { kind: 'scrub' }
      return
    }
    rulerDragRef.current = {
      kind: 'select',
      x0: x,
      anchor: selectionTime(xToTime(x, s.view), points, e.altKey).t,
      moved: false,
      points
    }
  }

  const onRulerPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - r.left
    const s = get()
    const drag = rulerDragRef.current
    if (!drag) {
      const range = s.timeSelection
      const onEdge =
        range &&
        (Math.abs(x - timeToX(range.start, s.view)) <= 5 || Math.abs(x - timeToX(range.end, s.view)) <= 5)
      const onCursor = Math.abs(x - timeToX(s.cursor, s.view)) <= 7
      e.currentTarget.style.cursor = onEdge ? 'ew-resize' : onCursor ? 'grab' : 'text'
      return
    }
    if (drag.kind === 'scrub') {
      A.setCursor(xToTime(x, s.view))
      return
    }
    if (drag.kind === 'select' && !drag.moved) {
      if (Math.abs(x - drag.x0) < 3) return
      drag.moved = true
    }
    const { t, snapAt } = selectionTime(xToTime(x, s.view), drag.points, e.altKey)
    const fixed = drag.kind === 'select' ? drag.anchor : drag.fixed
    A.setTimeSelection({ start: Math.min(fixed, t), end: Math.max(fixed, t) })
    useEditor.setState({ snapLine: snapAt })
  }

  const onRulerPointerUp = (cancelled: boolean): void => {
    const drag = rulerDragRef.current
    rulerDragRef.current = null
    useEditor.setState({ snapLine: null })
    if (!drag || cancelled || drag.kind !== 'select') return
    if (!drag.moved) {
      // Plain click on the ruler moves the cursor (the time selection stays).
      A.setCursor(xToTime(drag.x0, get().view))
      return
    }
    const range = get().timeSelection
    if (range) A.setCursor(range.start)
  }

  const onRulerContextMenu = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    e.preventDefault()
    const r = e.currentTarget.getBoundingClientRect()
    const at = xToTime(e.clientX - r.left, get().view)
    if (get().timeSelection) {
      openContextMenu(e.clientX, e.clientY, timeSelectionEntries())
      return
    }
    openContextMenu(e.clientX, e.clientY, [
      { label: 'Insert Marker Here', icon: MapPin, run: () => A.addMarkerAt(at) },
      { label: 'Move Cursor Here', icon: Locate, run: () => A.setCursor(at) },
      'separator',
      { label: 'Zoom to Fit Project', command: 'zoomFit' }
    ])
  }

  const onDrop = async (e: React.DragEvent<HTMLDivElement>): Promise<void> => {
    if (e.dataTransfer.files.length === 0) return
    e.preventDefault()
    e.stopPropagation()
    const { x, y } = local(e)
    const s = get()
    const layout = layoutAt(layoutTracks(s.project.tracks), y + s.view.scrollY)
    let at = Math.max(0, xToTime(x, s.view))
    let target: string | 'new' = layout ? layout.track.id : 'new'
    for (const pending of importFiles(Array.from(e.dataTransfer.files))) {
      const media = await pending
      if (!media) continue
      const created = A.addMediaToTimeline(media.id, at, target)
      // Later files of the same drop continue on the tracks the first one used.
      const first = get().project.events.find((ev) => ev.id === created[0])
      if (first) target = first.trackId
      at += media.kind === 'image' ? A.IMAGE_DEFAULT_LENGTH : media.duration
    }
  }

  const contentWidth = Math.min(
    MAX_CONTENT_PX,
    Math.max(flicksToSeconds(end) * view.pxPerSecond + 600, view.scrollX + size.width + 600)
  )
  const contentHeight = Math.max(tracksHeight(tracks) + TRACKS_TAIL_PX, size.height)

  return (
    <div className="timeline">
      <div className="tl-corner">
        <CursorTimecode />
      </div>
      <div className="tl-ruler">
        <canvas
          ref={rulerRef}
          onPointerDown={onRulerPointerDown}
          onPointerMove={onRulerPointerMove}
          onPointerUp={() => onRulerPointerUp(false)}
          onPointerCancel={() => onRulerPointerUp(true)}
          onContextMenu={onRulerContextMenu}
        />
      </div>
      <div
        className="tl-headers"
        onWheel={(e) => {
          if (scrollRef.current) scrollRef.current.scrollTop += e.deltaY
        }}
      >
        <div className="tl-headers-inner" style={{ transform: `translateY(${-view.scrollY}px)` }}>
          {tracks.map((track, index) => (
            <TrackHeader key={track.id} track={track} index={index} />
          ))}
          <TrackDropLine />
        </div>
      </div>
      <div
        className="tl-body"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
          }
        }}
        onDrop={(e) => void onDrop(e)}
      >
        <div
          className="tl-scroll"
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget
            const v = get().view
            if (el.scrollLeft !== v.scrollX || el.scrollTop !== v.scrollY) {
              A.setView({ scrollX: el.scrollLeft, scrollY: el.scrollTop })
            }
          }}
        >
          <div className="tl-sticky">
            <canvas ref={tracksRef} />
            <canvas
              ref={overlayRef}
              className="tl-overlay"
              data-dropzone="timeline"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={() => finishDrag(false)}
              onPointerCancel={() => finishDrag(true)}
              onPointerLeave={() => (hoverRef.current = null)}
              onDoubleClick={(e) => {
                const { x, y } = local(e)
                const hit = hitTest(x, y)
                if (hit.kind === 'event' && hit.event.text) A.openTextEditor(hit.event.id)
                else if (hit.kind === 'event' && hit.event.kind === 'video') A.openPanCrop(hit.event.id)
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                const { x, y } = local(e)
                openContextMenu(e.clientX, e.clientY, contextEntries(hitTest(x, y), xToTime(x, get().view)))
              }}
            />
          </div>
          <div style={{ width: contentWidth, height: contentHeight }} />
        </div>
      </div>
    </div>
  )
}

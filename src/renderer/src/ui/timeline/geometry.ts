import { FLICKS_PER_SECOND, type Flicks } from '../../core/time'
import type { ViewState } from '../../core/store'
import type { Track } from '../../core/types'

export const MARKER_BAR_H = 18
export const RULER_H = 26
export const TIMELINE_TOP_H = MARKER_BAR_H + RULER_H
export const TRACK_HEADER_W = 240
export const EVENT_HEAD_H = 15
/** Grab distance for trim edges, in px. */
export const EDGE_PX = 6
/** Grab distance for fade handles (event top corners), in px. */
export const FADE_HANDLE_PX = 7
export const FADE_ZONE_H = 12
export const SNAP_PX = 8
/** Empty space below the last track (drop target for new tracks). */
export const TRACKS_TAIL_PX = 140

export const timeToX = (t: Flicks, view: ViewState): number =>
  (t / FLICKS_PER_SECOND) * view.pxPerSecond - view.scrollX

export const xToTime = (x: number, view: ViewState): Flicks =>
  Math.round(((x + view.scrollX) / view.pxPerSecond) * FLICKS_PER_SECOND)

export const pxToFlicks = (px: number, view: ViewState): Flicks =>
  Math.round((px / view.pxPerSecond) * FLICKS_PER_SECOND)

export const flicksToPx = (t: Flicks, view: ViewState): number => (t / FLICKS_PER_SECOND) * view.pxPerSecond

/** The Event Pan/Crop button in the top-right corner of video events. */
export function panCropButton(eventX: number, eventW: number, eventTop: number): { x: number; y: number; size: number } | null {
  if (eventW < 64) return null
  const size = EVENT_HEAD_H - 3
  return { x: eventX + eventW - size - 12, y: eventTop + 2, size }
}

/**
 * The Event FX button: left of the Pan/Crop button on media video events, in
 * the corner on text and audio events.
 */
export function fxButton(
  eventX: number,
  eventW: number,
  eventTop: number,
  besidePanCrop: boolean
): { x: number; y: number; size: number } | null {
  if (eventW < (besidePanCrop ? 90 : 64)) return null
  const size = EVENT_HEAD_H - 3
  const right = besidePanCrop ? size + 16 : 0
  return { x: eventX + eventW - size - 12 - right, y: eventTop + 2, size }
}

export interface TrackLayout {
  track: Track
  index: number
  /** Top edge in content coordinates (before vertical scroll). */
  top: number
  height: number
}

export function layoutTracks(tracks: readonly Track[]): TrackLayout[] {
  let top = 0
  return tracks.map((track, index) => {
    const layout = { track, index, top, height: track.height }
    top += track.height
    return layout
  })
}

export const tracksHeight = (tracks: readonly Track[]): number => tracks.reduce((sum, t) => sum + t.height, 0)

export function layoutAt(layouts: TrackLayout[], contentY: number): TrackLayout | null {
  for (const l of layouts) if (contentY >= l.top && contentY < l.top + l.height) return l
  return null
}

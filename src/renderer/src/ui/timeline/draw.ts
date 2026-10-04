import { TRACK_COLORS } from '../../core/actions'
import { mediaById, type EditorState, type ViewState } from '../../core/store'
import { crossfadeIn, crossfadeOut, eventEnd, eventsOnTrack } from '../../core/timeline'
import { type FrameRate, flicksToSeconds, formatTimecode, fps, secondsToFlicks } from '../../core/time'
import type { MediaItem, TimelineEvent } from '../../core/types'
import { type FadeCurve, fadeShape, formatRate } from '../../core/fades'
import { imageCache, peakCache, thumbAt, thumbCache } from '../../media/cache'
import {
  EVENT_HEAD_H,
  MARKER_BAR_H,
  type TrackLayout,
  flicksToPx,
  panCropButton,
  fxButton,
  timeToX,
  xToTime
} from './geometry'
import { onThemeChange, themeColor } from '../themes'

const FONT = '11px "Segoe UI", system-ui, sans-serif'

const C = {
  background: '#1d1e21',
  rowA: '#2a2b30',
  rowB: '#27282d',
  rowSelected: '#323642',
  rowLine: 'rgba(0,0,0,0.55)',
  grid: 'rgba(255,255,255,0.035)',
  body: '#34373e',
  bodySelected: '#45506a',
  border: 'rgba(0,0,0,0.7)',
  borderSelected: '#ffcf70',
  fadeShade: 'rgba(0,0,0,0.5)',
  fadeLine: 'rgba(255,255,255,0.85)',
  text: '#f4f4f4',
  marker: '#ff9f1a',
  cursor: '#f2f2f2',
  cursorPlaying: '#ff6161',
  snap: '#40d4ff',
  // From the theme (see syncTheme).
  rulerTop: '#17181b',
  ruler: '#25262b',
  rulerTick: '#8d909a',
  rulerTickMinor: '#5b5e66',
  rulerText: '#b9bcc6',
  loop: '#4f9cff',
  hint: '#6b6f79'
}

/** Reads the canvas colors from the theme. */
function syncTheme(): void {
  C.background = themeColor('timeline-bg')
  C.rowA = themeColor('track-a')
  C.rowB = themeColor('track-b')
  C.rowSelected = themeColor('track-selected')
  C.rowLine = themeColor('track-line')
  C.grid = themeColor('grid')
  C.cursor = themeColor('cursor')
  C.rulerTop = themeColor('sunken')
  C.ruler = themeColor('ruler')
  C.rulerTick = themeColor('ruler-tick')
  C.rulerTickMinor = themeColor('ruler-tick-minor')
  C.rulerText = themeColor('ruler-text')
  C.loop = themeColor('accent')
  C.hint = themeColor('text-faint')
}
syncTheme()
onThemeChange(syncTheme)

export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface DropPreview {
  x: number
  width: number
  rowTop: number
  rowHeight: number
}

// Ruler

export function rulerTicks(view: ViewState, rate: FrameRate): { major: number; minor: number } {
  const frame = 1 / fps(rate)
  const candidates = [frame, 2 * frame, 5 * frame, 10 * frame, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200]
  let major = candidates[candidates.length - 1]
  for (const c of candidates) {
    if (c * view.pxPerSecond >= 96) {
      major = c
      break
    }
  }
  let divisions = 5
  if (major === 15 || major === 30) divisions = 3
  else if (major >= 60 && major % 60 === 0) divisions = 6
  else if (major <= 10 * frame + 1e-9) divisions = Math.max(1, Math.round(major / frame))
  let minor = major / divisions
  if (minor * view.pxPerSecond < 5) minor = major
  return { major, minor }
}

export function drawRuler(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  s: EditorState
): void {
  const { view, project, cursor } = s
  const rate = project.settings.frameRate
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = C.rulerTop
  ctx.fillRect(0, 0, width, MARKER_BAR_H)
  ctx.fillStyle = C.ruler
  ctx.fillRect(0, MARKER_BAR_H, width, height - MARKER_BAR_H)
  ctx.fillStyle = C.rowLine
  ctx.fillRect(0, MARKER_BAR_H - 1, width, 1)
  ctx.fillRect(0, height - 1, width, 1)

  // Time selection: a strip at the top (blue when looping) and a light band below it.
  const sel = s.timeSelection
  if (sel) {
    const x0 = Math.round(timeToX(sel.start, view))
    const x1 = Math.round(timeToX(sel.end, view))
    if (x1 > -2 && x0 < width + 2) {
      ctx.fillStyle = 'rgba(110,160,255,0.16)'
      ctx.fillRect(x0, 0, x1 - x0, height)
      ctx.fillStyle = s.options.loop ? C.loop : '#8a93a6'
      ctx.fillRect(x0, 0, x1 - x0, 5)
      ctx.beginPath()
      ctx.moveTo(x0, 0)
      ctx.lineTo(x0 + 7, 0)
      ctx.lineTo(x0, 9)
      ctx.closePath()
      ctx.moveTo(x1, 0)
      ctx.lineTo(x1 - 7, 0)
      ctx.lineTo(x1, 9)
      ctx.closePath()
      ctx.fill()
    }
  }

  const { major, minor } = rulerTicks(view, rate)
  const startSec = Math.max(0, view.scrollX / view.pxPerSecond)
  const endSec = (view.scrollX + width) / view.pxPerSecond
  const first = Math.floor(startSec / minor)
  const last = Math.ceil(endSec / minor)
  ctx.font = FONT
  ctx.textBaseline = 'top'
  for (let i = first; i <= last; i++) {
    const sec = i * minor
    const x = Math.round(sec * view.pxPerSecond - view.scrollX) + 0.5
    const ratio = sec / major
    const isMajor = Math.abs(ratio - Math.round(ratio)) < 1e-6
    ctx.fillStyle = isMajor ? C.rulerTick : C.rulerTickMinor
    const tick = isMajor ? 10 : 5
    ctx.fillRect(x - 0.5, height - tick, 1, tick)
    if (isMajor) {
      ctx.fillStyle = C.rulerText
      ctx.fillText(formatTimecode(secondsToFlicks(sec), rate), x + 3, MARKER_BAR_H + 3)
    }
  }

  // Markers live in the bar above the time ruler.
  for (const m of project.markers) {
    const x = Math.round(timeToX(m.time, view))
    if (x < -40 || x > width + 4) continue
    ctx.fillStyle = C.marker
    const labelWidth = Math.max(14, ctx.measureText(m.label).width + 8)
    ctx.fillRect(x, 2, labelWidth, MARKER_BAR_H - 5)
    ctx.fillRect(x, 2, 1.5, MARKER_BAR_H - 2)
    ctx.fillStyle = '#1b1300'
    ctx.textBaseline = 'middle'
    ctx.fillText(m.label, x + 4, 2 + (MARKER_BAR_H - 5) / 2 + 0.5)
    ctx.textBaseline = 'top'
  }

  const cx = Math.round(timeToX(cursor, view)) + 0.5
  if (cx >= -6 && cx <= width + 6) {
    ctx.fillStyle = s.playing ? C.cursorPlaying : C.cursor
    ctx.beginPath()
    ctx.moveTo(cx - 6, height - 9)
    ctx.lineTo(cx + 6, height - 9)
    ctx.lineTo(cx, height - 1)
    ctx.closePath()
    ctx.fill()
    ctx.fillRect(cx - 0.5, MARKER_BAR_H, 1, height - MARKER_BAR_H)
  }
}

// Tracks

export function drawTracks(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  s: EditorState,
  layouts: TrackLayout[]
): void {
  const { view, project } = s
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = C.background
  ctx.fillRect(0, 0, width, height)

  for (const l of layouts) {
    const y = l.top - view.scrollY
    if (y > height || y + l.height < 0) continue
    ctx.fillStyle = l.track.id === s.selectedTrackId ? C.rowSelected : l.index % 2 === 0 ? C.rowA : C.rowB
    ctx.fillRect(0, y, width, l.height)
    ctx.fillStyle = C.rowLine
    ctx.fillRect(0, y + l.height - 1, width, 1)
  }

  const { major } = rulerTicks(view, project.settings.frameRate)
  const firstMajor = Math.floor(view.scrollX / view.pxPerSecond / major)
  const lastMajor = Math.ceil((view.scrollX + width) / view.pxPerSecond / major)
  ctx.fillStyle = C.grid
  for (let i = firstMajor; i <= lastMajor; i++) {
    ctx.fillRect(Math.round(i * major * view.pxPerSecond - view.scrollX), 0, 1, height)
  }

  const t0 = xToTime(-10, view)
  const t1 = xToTime(width + 10, view)
  const selected = new Set(s.selection)
  for (const l of layouts) {
    const y = l.top - view.scrollY
    if (y > height || y + l.height < 0) continue
    const events = eventsOnTrack(project, l.track.id)
    for (const e of events) {
      if (eventEnd(e) < t0 || e.start > t1) continue
      drawEvent(ctx, e, events, l, y, width, s, selected.has(e.id))
    }
    if (s.options.autoCrossfade) drawCrossfades(ctx, events, y, l.height, width, view)
  }

  ctx.save()
  ctx.strokeStyle = 'rgba(255,159,26,0.5)'
  ctx.setLineDash([3, 4])
  for (const m of project.markers) {
    const x = Math.round(timeToX(m.time, view)) + 0.5
    if (x < 0 || x > width) continue
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, height)
    ctx.stroke()
  }
  ctx.restore()

  if (project.tracks.length === 0) {
    ctx.fillStyle = C.hint
    ctx.font = '13px "Segoe UI", system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('Drag media here from Project Media or from your file explorer', width / 2, Math.min(80, height / 2))
    ctx.textAlign = 'left'
  }
}

function drawEvent(
  ctx: CanvasRenderingContext2D,
  e: TimelineEvent,
  trackEvents: TimelineEvent[],
  layout: TrackLayout,
  rowY: number,
  width: number,
  s: EditorState,
  selected: boolean
): void {
  const { view } = s
  const x = timeToX(e.start, view)
  const w = flicksToPx(e.length, view)
  const y = rowY + 1
  const h = layout.height - 3
  const x0 = Math.max(x, -4)
  const x1 = Math.min(x + w, width + 4)
  if (x1 <= x0 || h <= 4) return
  const color = TRACK_COLORS[layout.track.color % TRACK_COLORS.length]
  const media = mediaById(e.mediaId)
  const headH = Math.min(EVENT_HEAD_H, Math.floor(h * 0.35))

  ctx.save()
  ctx.beginPath()
  ctx.rect(x0, y, x1 - x0, h)
  ctx.clip()
  ctx.fillStyle = selected ? C.bodySelected : C.body
  ctx.fillRect(x0, y, x1 - x0, h)
  if (e.text) {
    ctx.fillStyle = selected ? '#5a4b7a' : '#43395a'
    ctx.fillRect(x0, y + headH, x1 - x0, h - headH)
    ctx.fillStyle = 'rgba(255,255,255,0.75)'
    ctx.font = '600 13px "Segoe UI", system-ui, sans-serif'
    ctx.textBaseline = 'middle'
    ctx.fillText(`T  ${e.text.text.replace(/\n/g, ' ')}`, Math.max(x, 0) + 8, y + headH + (h - headH) / 2)
  } else if (media) {
    if (e.kind === 'video') drawThumbnails(ctx, e, media, x, y + headH, h - headH, x0, x1, view)
    else drawWaveform(ctx, e, media, x, y + headH, h - headH, x0, x1, view, color)
  }
  ctx.globalAlpha = selected ? 0.95 : 0.72
  ctx.fillStyle = color
  ctx.fillRect(x0, y, x1 - x0, headH)
  ctx.globalAlpha = 1

  const xIn = s.options.autoCrossfade ? crossfadeIn(e, trackEvents) : 0
  const xOut = s.options.autoCrossfade ? crossfadeOut(e, trackEvents) : 0
  if (e.fadeIn > xIn) drawFade(ctx, x, y, w, h, flicksToPx(e.fadeIn, view), 'in', e.fadeInCurve)
  if (e.fadeOut > xOut) drawFade(ctx, x, y, w, h, flicksToPx(e.fadeOut, view), 'out', e.fadeOutCurve)
  if (e.rate !== 1) drawRateMark(ctx, x0, x1, y + headH, e.rate)
  if (e.envelope.length > 0) drawEnvelope(ctx, e, x, y + headH, h - headH, x0, x1, view)

  ctx.fillStyle = C.text
  ctx.font = FONT
  ctx.textBaseline = 'middle'
  ctx.fillText(eventLabel(e, media), Math.max(x, 0) + 5 + (e.transition && x >= x0 - 1 ? headH : 0), y + headH / 2 + 0.5)
  const mediaVideo = e.kind === 'video' && !e.text
  if (mediaVideo) {
    const button = panCropButton(x, w, y)
    if (button && button.x > x0 && button.x + button.size < x1) {
      drawPanCropButton(ctx, button.x, button.y, button.size, e.panCrop.length > 0)
    }
  }
  if (e.transition && x >= x0 - 1) drawTransitionMark(ctx, x, y, headH)
  const fx = fxButton(x, w, y, mediaVideo)
  if (fx && fx.x > x0 && fx.x + fx.size < x1) {
    drawFxButton(ctx, fx.x, fx.y, fx.size, e.fx.some((f) => f.enabled), e.fx.length > 0)
  }
  ctx.restore()

  // Border, drawn without clipping artifacts when the event extends off screen.
  ctx.fillStyle = selected ? C.borderSelected : C.border
  const bw = selected ? 2 : 1
  ctx.fillRect(x0, y, x1 - x0, bw)
  ctx.fillRect(x0, y + h - bw, x1 - x0, bw)
  if (x >= -2) ctx.fillRect(x, y, bw, h)
  if (x + w <= width + 2) ctx.fillRect(x + w - bw, y, bw, h)
}

/** Bow-tie mark at the start of an event that has a transition into it. */
function drawTransitionMark(ctx: CanvasRenderingContext2D, x: number, y: number, headH: number): void {
  const s = Math.max(6, headH - 4)
  const cy = y + headH / 2
  ctx.fillStyle = '#ffffff'
  ctx.strokeStyle = '#1b1c20'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(x + 2, cy - s / 2)
  ctx.lineTo(x + 2 + s, cy + s / 2)
  ctx.lineTo(x + 2 + s, cy - s / 2)
  ctx.lineTo(x + 2, cy + s / 2)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
}

/** Volume envelope (Auto Ducking): a yellow line, 0 dB at the top of the body, -36 dB at the bottom. */
function drawEnvelope(
  ctx: CanvasRenderingContext2D,
  e: TimelineEvent,
  x: number,
  top: number,
  h: number,
  x0: number,
  x1: number,
  view: EditorState['view']
): void {
  const yOf = (gain: number): number => {
    const db = gain <= 0 ? -60 : 20 * Math.log10(gain)
    return top + 2 + Math.min(1, Math.max(0, -db / 36)) * (h - 4)
  }
  ctx.save()
  ctx.strokeStyle = '#ffcf3f'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  const first = e.envelope[0]
  ctx.moveTo(x0, yOf(first.gain))
  for (const p of e.envelope) {
    const px = x + flicksToPx((p.time - e.offset) / e.rate, view)
    if (px < x0 - 2000 || px > x1 + 2000) continue
    ctx.lineTo(Math.min(x1, Math.max(x0, px)), yOf(p.gain))
  }
  ctx.lineTo(x1, yOf(e.envelope[e.envelope.length - 1].gain))
  ctx.stroke()
  ctx.restore()
}

function drawPanCropButton(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, active: boolean): void {
  ctx.fillStyle = active ? '#ffcf70' : 'rgba(0,0,0,0.45)'
  ctx.fillRect(x, y, size, size)
  ctx.strokeStyle = active ? '#2a1d00' : '#e6e6e6'
  ctx.lineWidth = 1.2
  const a = 2.5
  const b = size - 2.5
  ctx.beginPath()
  // Two crop corners.
  ctx.moveTo(x + a + 2, y + a)
  ctx.lineTo(x + a, y + a)
  ctx.lineTo(x + a, y + b - 2)
  ctx.moveTo(x + a, y + b - 3.5)
  ctx.lineTo(x + b - 2, y + b - 3.5)
  ctx.moveTo(x + b - 3.5, y + a + 1.5)
  ctx.lineTo(x + b - 3.5, y + b)
  ctx.moveTo(x + a + 1.5, y + a + 1.5)
  ctx.lineTo(x + b - 3.5, y + a + 1.5)
  ctx.stroke()
}

/** "fx" badge: green when the event has active effects (Event FX button). */
function drawFxButton(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, active: boolean, any: boolean): void {
  ctx.fillStyle = active ? '#7be08a' : any ? '#8a8f99' : 'rgba(0,0,0,0.45)'
  ctx.fillRect(x, y, size, size)
  ctx.fillStyle = active ? '#0f2a12' : any ? '#1d1f23' : '#e6e6e6'
  ctx.font = 'italic 700 9px "Segoe UI", system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('fx', x + size / 2, y + size / 2 + 0.5)
  ctx.textAlign = 'left'
}

function eventLabel(e: TimelineEvent, media: MediaItem | undefined): string {
  if (e.text) return 'Text'
  if (!media) return 'Missing media'
  return e.rate !== 1 ? `${media.name}  ·  ${formatRate(e.rate)}` : media.name
}

/** Zigzag under the header of an event whose playback rate was changed. */
function drawRateMark(ctx: CanvasRenderingContext2D, x0: number, x1: number, y: number, rate: number): void {
  const step = 6
  ctx.save()
  ctx.strokeStyle = rate > 1 ? 'rgba(255,207,112,0.9)' : 'rgba(140,200,255,0.9)'
  ctx.lineWidth = 1
  ctx.beginPath()
  const start = Math.floor(x0 / step) * step
  for (let px = start, i = 0; px <= x1 + step; px += step, i++) {
    const py = y + 1.5 + (i % 2 ? 3 : 0)
    if (px === start) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.stroke()
  ctx.restore()
}

/** Fade region: the curve from the event edge (bottom) to the fade handle (top), shaded above. */
function drawFade(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  fadePx: number,
  side: 'in' | 'out',
  curve: FadeCurve
): void {
  const edge = side === 'in' ? x : x + w
  const dir = side === 'in' ? 1 : -1
  const steps = Math.max(2, Math.min(48, Math.ceil(fadePx / 3)))
  const point = (i: number): [number, number] => {
    const p = i / steps
    return [edge + dir * p * fadePx, y + h - fadeShape(curve, p) * h]
  }
  ctx.fillStyle = C.fadeShade
  ctx.beginPath()
  ctx.moveTo(edge, y)
  for (let i = 0; i <= steps; i++) ctx.lineTo(...point(i))
  ctx.closePath()
  ctx.fill()
  ctx.strokeStyle = C.fadeLine
  ctx.lineWidth = 1.2
  ctx.beginPath()
  for (let i = 0; i <= steps; i++) {
    const [px, py] = point(i)
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.stroke()
  // Handle at the top of the fade.
  ctx.fillStyle = C.fadeLine
  ctx.fillRect(edge + dir * fadePx - 2, y, 4, 4)
}

function drawCrossfades(
  ctx: CanvasRenderingContext2D,
  events: TimelineEvent[],
  rowY: number,
  rowH: number,
  width: number,
  view: ViewState
): void {
  const y = rowY + 1
  const h = rowH - 3
  for (let i = 0; i < events.length; i++) {
    const a = events[i]
    for (let j = i + 1; j < events.length; j++) {
      const b = events[j]
      if (b.start >= eventEnd(a)) break
      const x0 = timeToX(b.start, view)
      const x1 = timeToX(Math.min(eventEnd(a), eventEnd(b)), view)
      if (x1 < 0 || x0 > width || x1 - x0 < 1) continue
      ctx.fillStyle = 'rgba(0,0,0,0.3)'
      ctx.fillRect(x0, y, x1 - x0, h)
      ctx.strokeStyle = C.fadeLine
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x0, y)
      ctx.lineTo(x1, y + h)
      ctx.moveTo(x0, y + h)
      ctx.lineTo(x1, y)
      ctx.stroke()
    }
  }
}

function drawThumbnails(
  ctx: CanvasRenderingContext2D,
  e: TimelineEvent,
  media: MediaItem,
  x: number,
  top: number,
  h: number,
  x0: number,
  x1: number,
  view: ViewState
): void {
  if (h < 8) return
  const image = media.kind === 'image' ? imageCache.get(media.id) : undefined
  const strip = thumbCache.get(media.id)
  const aspect =
    media.kind === 'image'
      ? media.width / media.height || 1
      : (strip?.aspect ?? (media.width / media.height || 16 / 9))
  const tw = Math.max(8, h * aspect)
  const first = Math.max(0, Math.floor((x0 - x) / tw))
  const last = Math.ceil((x1 - x) / tw)
  const offset = flicksToSeconds(e.offset)
  for (let k = first; k < last; k++) {
    const sx = x + k * tw
    const source = image ?? (strip ? thumbAt(strip, offset + ((k * tw) / view.pxPerSecond) * e.rate) : null)
    if (source) ctx.drawImage(source, sx, top, tw, h)
    ctx.fillStyle = 'rgba(0,0,0,0.4)'
    ctx.fillRect(Math.round(sx + tw) - 1, top, 1, h)
  }
}

function drawWaveform(
  ctx: CanvasRenderingContext2D,
  e: TimelineEvent,
  media: MediaItem,
  x: number,
  top: number,
  h: number,
  x0: number,
  x1: number,
  view: ViewState,
  color: string
): void {
  if (h < 6) return
  const peaks = peakCache.get(media.id)
  if (!peaks) return
  const lanes = peaks.channels.length
  const laneH = h / lanes
  const offset = flicksToSeconds(e.offset)
  const per = peaks.perSecond
  const pps = view.pxPerSecond
  const fromPx = Math.floor(x0)
  const toPx = Math.ceil(x1)
  for (let c = 0; c < lanes; c++) {
    const data = peaks.channels[c]
    const mid = top + laneH * (c + 0.5)
    const amp = laneH / 2 - 1
    ctx.fillStyle = 'rgba(255,255,255,0.1)'
    ctx.fillRect(fromPx, Math.round(mid), toPx - fromPx, 1)
    ctx.fillStyle = color
    for (let px = fromPx; px < toPx; px++) {
      const s0 = offset + ((px - x) / pps) * e.rate
      let b0 = Math.floor(s0 * per)
      let b1 = Math.max(b0 + 1, Math.floor((s0 + e.rate / pps) * per))
      if (b1 <= 0 || b0 >= data.length) continue
      b0 = Math.max(0, b0)
      b1 = Math.min(data.length, b1)
      let peak = 0
      for (let b = b0; b < b1; b++) if (data[b] > peak) peak = data[b]
      if (peak < 0.003) continue
      const half = Math.max(0.5, peak * amp)
      ctx.fillRect(px, mid - half, 1, half * 2)
    }
  }
}

// Overlay

export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  s: EditorState,
  drop: DropPreview | null,
  rubber: Rect | null,
  layouts: TrackLayout[]
): void {
  const { view } = s
  ctx.clearRect(0, 0, width, height)

  // What Remove Silences is about to cut, on the tracks it cuts.
  const cuts = s.cutPreview
  if (cuts) {
    const rows = layouts.filter((l) => cuts.trackIds.includes(l.track.id))
    ctx.fillStyle = 'rgba(232,52,52,0.45)'
    for (const r of cuts.ranges) {
      const x0 = timeToX(r.start, view)
      const x1 = timeToX(r.end, view)
      if (x1 < 0 || x0 > width) continue
      for (const l of rows) {
        const y = l.top - view.scrollY
        if (y < height && y + l.height > 0) ctx.fillRect(x0, y + 1, Math.max(1, x1 - x0), l.height - 2)
      }
    }
  }

  const sel = s.timeSelection
  if (sel) {
    const x0 = timeToX(sel.start, view)
    const x1 = timeToX(sel.end, view)
    if (x1 > 0 && x0 < width) {
      ctx.fillStyle = 'rgba(110,160,255,0.16)'
      ctx.fillRect(x0, 0, x1 - x0, height)
      ctx.fillStyle = 'rgba(150,190,255,0.85)'
      ctx.fillRect(Math.round(x0), 0, 1, height)
      ctx.fillRect(Math.round(x1) - 1, 0, 1, height)
    }
  }

  if (drop) {
    ctx.fillStyle = 'rgba(64,212,255,0.18)'
    ctx.fillRect(drop.x, drop.rowTop + 1, Math.max(4, drop.width), drop.rowHeight - 3)
    ctx.strokeStyle = C.snap
    ctx.lineWidth = 1
    ctx.strokeRect(drop.x + 0.5, drop.rowTop + 1.5, Math.max(4, drop.width) - 1, drop.rowHeight - 4)
  }

  if (rubber) {
    const x = Math.min(rubber.x0, rubber.x1)
    const y = Math.min(rubber.y0, rubber.y1)
    ctx.fillStyle = 'rgba(120,170,255,0.12)'
    ctx.fillRect(x, y, Math.abs(rubber.x1 - rubber.x0), Math.abs(rubber.y1 - rubber.y0))
    ctx.strokeStyle = 'rgba(140,185,255,0.8)'
    ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(rubber.x1 - rubber.x0), Math.abs(rubber.y1 - rubber.y0))
  }

  if (s.snapLine !== null) {
    const x = Math.round(timeToX(s.snapLine, view)) + 0.5
    ctx.save()
    ctx.strokeStyle = C.snap
    ctx.setLineDash([4, 3])
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, height)
    ctx.stroke()
    ctx.restore()
  }

  const cx = Math.round(timeToX(s.cursor, view)) + 0.5
  if (cx >= 0 && cx <= width) {
    ctx.strokeStyle = s.playing ? C.cursorPlaying : C.cursor
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(cx, 0)
    ctx.lineTo(cx, height)
    ctx.stroke()
  }
}

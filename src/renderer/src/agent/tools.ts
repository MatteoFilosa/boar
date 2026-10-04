import * as A from '../core/actions'
import { mediaById, useEditor } from '../core/store'
import { FLICKS_PER_SECOND, type Flicks, fps, secondsToFlicks } from '../core/time'
import { eventEnd, projectEnd, sourceTime } from '../core/timeline'
import type { TimelineEvent } from '../core/types'
import { CAPTION_STYLES, alignWords, chunkWords } from '../core/captions'
import { type TimelineWord, defaultSpeechTrack, hasSpeech, speechTracks, wordFlag, wordsOnTimeline } from '../core/transcript'
import { TEXT_PRESETS } from '../core/text'
import { normalizeAngle, panCropAt, sourceToOutput } from '../core/pancrop'
import { DEFAULT_MASK, type EventMask, type MaskPoint } from '../core/mask'
import { smartOutline, trackOutline } from '../engine/smartMask'
import { AUDIO_FX, VIDEO_FX } from '../core/fx'
import type { Corner } from '../core/layouts'
import { renderStill } from '../engine/export'
import { autoThreshold, eventLevels, findSilences, mediaLevels } from '../engine/analysis'
import { analyzeFaces, reframeKeys } from '../engine/reframe'
import { type ZoomMode, faceAt, loudMoments, zoomKeys } from '../engine/autoZoom'
import { isDirty, saveProject } from '../core/session'
import { findHighlights, shortDuration } from '../core/shorts'
import { uid } from '../core/ids'
import { DEFAULT_SHORT_OPTIONS, type ShortFraming, backToLongVideo, makeShort } from '../engine/makeShort'
import { bridge } from '../platform'

// MCP tools. Times are seconds on the timeline, tracks are numbered from 1 at
// the top, and each editing tool is one undo step.

export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export interface ToolResult {
  content: ToolContent[]
  isError?: boolean
}

type Args = Record<string, unknown>

interface Tool {
  name: string
  title: string
  description: string
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
  /** Read-only tools do not change the project. */
  readOnly?: boolean
  run(args: Args): Promise<ToolResult | string | object> | ToolResult | string | object
}

export class ToolError extends Error {}

const get = useEditor.getState
const F = FLICKS_PER_SECOND
const sec = (t: Flicks): number => Math.round((t / F) * 1000) / 1000

// Arguments

function num(a: Args, key: string, o: { min?: number; max?: number; def?: number } = {}): number {
  const v = a[key]
  if (v === undefined || v === null || v === '') {
    if (o.def !== undefined) return o.def
    throw new ToolError(`"${key}" is required`)
  }
  const n = typeof v === 'string' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new ToolError(`"${key}" must be a number`)
  if (o.min !== undefined && n < o.min) throw new ToolError(`"${key}" must be at least ${o.min}`)
  if (o.max !== undefined && n > o.max) throw new ToolError(`"${key}" must be at most ${o.max}`)
  return n
}

function str(a: Args, key: string, def?: string): string {
  const v = a[key]
  if (v === undefined || v === null) {
    if (def !== undefined) return def
    throw new ToolError(`"${key}" is required`)
  }
  if (typeof v !== 'string') throw new ToolError(`"${key}" must be a string`)
  return v
}

const bool = (a: Args, key: string, def: boolean): boolean => (typeof a[key] === 'boolean' ? (a[key] as boolean) : def)

function oneOf<T extends string>(a: Args, key: string, values: readonly T[], def: T): T {
  const v = a[key] ?? def
  if (!values.includes(v as T)) throw new ToolError(`"${key}" must be one of: ${values.join(', ')}`)
  return v as T
}

function ranges(a: Args, key = 'ranges'): { start: Flicks; end: Flicks }[] {
  const v = a[key]
  if (!Array.isArray(v) || v.length === 0) throw new ToolError(`"${key}" must be a non-empty array of {start, end} in seconds`)
  return v.map((r, i) => {
    const start = num(r as Args, 'start', { min: 0 })
    const end = num(r as Args, 'end', { min: 0 })
    if (end <= start) throw new ToolError(`${key}[${i}]: end must be after start`)
    return { start: secondsToFlicks(start), end: secondsToFlicks(end) }
  })
}

function framePoints(a: Args, key: string): MaskPoint[] {
  const v = a[key]
  if (v === undefined) return []
  if (!Array.isArray(v)) throw new ToolError(`"${key}" must be an array of {x, y}`)
  return v.map((p) => [num(p as Args, 'x', { min: 0, max: 1 }), num(p as Args, 'y', { min: 0, max: 1 })])
}

/** Event ids that exist; when absent, `fallback` (e.g. the selection). */
function eventIds(a: Args, fallback: () => string[] = () => []): string[] {
  const v = a.event_ids
  if (v === undefined) return fallback()
  if (!Array.isArray(v) || v.some((id) => typeof id !== 'string')) throw new ToolError('"event_ids" must be an array of event ids (see get_project)')
  const known = new Set(get().project.events.map((e) => e.id))
  const missing = (v as string[]).filter((id) => !known.has(id))
  if (missing.length) throw new ToolError(`Unknown event ids: ${missing.join(', ')}`)
  return v as string[]
}

/** Track id from a 1-based track number. */
function trackId(a: Args, key = 'track'): string | null {
  if (a[key] === undefined || a[key] === null) return null
  const tracks = get().project.tracks
  const n = num(a, key, { min: 1, max: Math.max(1, tracks.length) })
  const track = tracks[Math.round(n) - 1]
  if (!track) throw new ToolError(`There is no track ${n}`)
  return track.id
}

// Schema helpers

const S = {
  num: (description: string) => ({ type: 'number', description }),
  int: (description: string) => ({ type: 'integer', description }),
  str: (description: string, values?: readonly string[]) => (values ? { type: 'string', description, enum: values } : { type: 'string', description }),
  bool: (description: string) => ({ type: 'boolean', description }),
  ids: (description = 'Event ids from get_project') => ({ type: 'array', items: { type: 'string' }, description }),
  points: (description: string) => ({
    type: 'array',
    description,
    items: {
      type: 'object',
      properties: { x: { type: 'number', description: '0 = left, 1 = right' }, y: { type: 'number', description: '0 = top, 1 = bottom' } },
      required: ['x', 'y']
    }
  }),
  ranges: (description: string) => ({
    type: 'array',
    description,
    items: {
      type: 'object',
      properties: { start: { type: 'number', description: 'Seconds' }, end: { type: 'number', description: 'Seconds' } },
      required: ['start', 'end']
    }
  })
}

const object = (properties: Record<string, unknown>, required: string[] = []): Tool['inputSchema'] => ({ type: 'object', properties, required })

// Shared helpers

function describeEvent(e: TimelineEvent, trackIndex: Map<string, number>): Record<string, unknown> {
  const media = mediaById(e.mediaId)
  const out: Record<string, unknown> = {
    id: e.id,
    track: (trackIndex.get(e.trackId) ?? 0) + 1,
    kind: e.kind,
    start: sec(e.start),
    end: sec(eventEnd(e))
  }
  if (e.text) out.text = e.text.progressBar ? '(progress bar)' : e.text.text
  else {
    out.media = media?.name ?? 'missing media'
    out.sourceIn = sec(e.offset)
  }
  if (e.rate !== 1) out.rate = Math.round(e.rate * 1000) / 1000
  if (e.fadeIn) out.fadeIn = sec(e.fadeIn)
  if (e.fadeOut) out.fadeOut = sec(e.fadeOut)
  if (e.fx.length) out.fx = e.fx.map((f) => f.type)
  if (e.panCrop.length) out.panCrop = e.panCrop.length === 1 ? `zoom ${e.panCrop[0].zoom.toFixed(2)}` : `${e.panCrop.length} keyframes`
  // Clockwise on screen (a Pan/Crop rotation turns the frame, so the picture the other way).
  const rotation = e.text ? e.text.rotation : e.panCrop.length === 1 ? normalizeAngle(-e.panCrop[0].rotation) : 0
  if (rotation) out.rotation = Math.round(rotation * 10) / 10
  if (e.groupId) out.group = e.groupId
  return out
}

/** The speech track to read: `track` if given, else the selected clip's sound, else the first track with speech. */
function speechTrack(a: Args): string {
  const project = get().project
  const candidates = speechTracks(project)
  const chosen = trackId(a)
  const id = chosen ?? defaultSpeechTrack(project, get().selection, candidates)
  if (!id) throw new ToolError('No clip with sound on the timeline')
  return id
}

function trackWords(id: string): { words: TimelineWord[]; missing: string[] } {
  const { project, transcripts } = get()
  const events = project.events.filter((e) => e.trackId === id && hasSpeech(e))
  const missing = [...new Set(events.map((e) => e.mediaId))].filter((m) => !transcripts[m]).map((m) => mediaById(m)?.name ?? m)
  return { words: wordsOnTimeline(events, transcripts), missing }
}

/** Words grouped into sentences (punctuation, pauses, length) with their times. */
function sentences(words: readonly TimelineWord[]): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = []
  let current: TimelineWord[] = []
  const flush = (): void => {
    if (!current.length) return
    out.push({ start: sec(current[0].start), end: sec(current[current.length - 1].end), text: current.map((w) => w.text).join(' ') })
    current = []
  }
  words.forEach((w, i) => {
    const previous = words[i - 1]
    if (previous && (w.start - previous.end > 0.7 * F || current.length >= 30)) flush()
    current.push(w)
    if (/[.!?…]$/.test(w.text)) flush()
  })
  flush()
  return out
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

function captionsFromWords(words: readonly TimelineWord[], style: string): number {
  const look = CAPTION_STYLES.find((s) => s.id === style) ?? CAPTION_STYLES[0]
  const timed = words.map((w) => ({ text: w.text, start: w.start / F, end: w.end / F }))
  return A.addCaptionEvents(chunkWords(timed, { maxChars: look.maxChars, maxWords: look.maxWords, maxGap: 0.6 }), 0, look.id)
}

const framedVideo = (ids: string[]): TimelineEvent[] =>
  get().project.events.filter((e) => ids.includes(e.id) && e.kind === 'video' && !e.text && mediaById(e.mediaId)?.status === 'ready')

const allVideo = (): string[] => A.foregroundVideoEvents().map((e) => e.id)

// Tools

const TOOLS: Tool[] = [
  {
    name: 'get_project',
    title: 'Read the project',
    description:
      'The whole edit: format, duration, tracks (numbered from 1 at the top), events with ids and times in seconds, markers, media files and which have transcripts. Call this first.',
    inputSchema: object({}),
    readOnly: true,
    run: () => {
      const { project, media, cursor, timeSelection, transcripts, projectPath } = get()
      const index = new Map(project.tracks.map((t, i) => [t.id, i]))
      return {
        project: projectPath ?? 'unsaved',
        format: { width: project.settings.width, height: project.settings.height, fps: Math.round(fps(project.settings.frameRate) * 1000) / 1000 },
        duration: sec(projectEnd(project)),
        cursor: sec(cursor),
        timeSelection: timeSelection ? { start: sec(timeSelection.start), end: sec(timeSelection.end) } : null,
        tracks: project.tracks.map((t, i) => ({ track: i + 1, kind: t.kind, name: t.name, muted: t.muted || undefined })),
        events: [...project.events].sort((a, b) => (index.get(a.trackId) ?? 0) - (index.get(b.trackId) ?? 0) || a.start - b.start).map((e) => describeEvent(e, index)),
        markers: project.markers.map((m) => ({ time: sec(m.time), label: m.label })),
        media: media.map((m) => ({
          id: m.id,
          name: m.name,
          kind: m.kind,
          duration: sec(m.duration),
          size: m.width ? `${m.width}x${m.height}` : undefined,
          audio: m.hasAudio,
          transcript: !!transcripts[m.id]
        }))
      }
    }
  },
  {
    name: 'get_transcript',
    title: 'Read what is said',
    description:
      'The speech of a track as timed sentences (or single words) at their timeline positions, after any cuts. Defaults to the main speech track. If media are not transcribed yet, call transcribe first.',
    inputSchema: object({
      track: S.int('Track number (default: the speech track)'),
      from: S.num('Only from this time (seconds)'),
      to: S.num('Only up to this time (seconds)'),
      mode: S.str('sentences (default) or words', ['sentences', 'words'])
    }),
    readOnly: true,
    run: (a) => {
      const id = speechTrack(a)
      const { words, missing } = trackWords(id)
      const from = secondsToFlicks(num(a, 'from', { def: 0 }))
      const to = a.to === undefined ? Infinity : secondsToFlicks(num(a, 'to'))
      const visible = words.filter((w) => w.end > from && w.start < to)
      const note = missing.length ? `Not transcribed yet (call transcribe): ${missing.join(', ')}` : undefined
      if (oneOf(a, 'mode', ['sentences', 'words'] as const, 'sentences') === 'words') {
        return { note, words: visible.map((w) => [sec(w.start), sec(w.end), w.text]) }
      }
      return { note, sentences: sentences(visible) }
    }
  },
  {
    name: 'transcribe',
    title: 'Transcribe speech (local Whisper)',
    description: 'Runs Whisper on this PC for the media of a track that have no transcript yet. Can take a while for long videos.',
    inputSchema: object({
      track: S.int('Track number (default: the speech track)'),
      language: S.str('Spoken language code (it, en, es, fr, de, pt) or auto', ['auto', 'it', 'en', 'es', 'fr', 'de', 'pt'])
    }),
    run: async (a) => {
      if (!bridge) throw new ToolError('Transcription needs the desktop app')
      const id = speechTrack(a)
      const language = oneOf(a, 'language', ['auto', 'it', 'en', 'es', 'fr', 'de', 'pt'] as const, 'auto')
      const status = await bridge.captionsStatus()
      if (!status.whisper) throw new ToolError('FFmpeg with the whisper filter is not installed (see the README)')
      const model = ['large-v3-turbo', 'small', 'base'].find((m) => status.models.some((x) => x.id === m && x.installed))
      if (!model) throw new ToolError('No Whisper model downloaded yet: ask the user to open the Transcript tab and click "Get Whisper"')
      const { project, transcripts } = get()
      const media = [...new Set(project.events.filter((e) => e.trackId === id && hasSpeech(e)).map((e) => e.mediaId))]
        .filter((m) => !transcripts[m])
        .map((m) => mediaById(m))
      for (const m of media) {
        if (!m?.path) continue
        A.setStatus(`Transcribing ${m.name}…`)
        const result = await bridge.transcribe({ path: m.path, start: 0, duration: m.duration / F, model, language })
        A.setTranscript(m.id, { language, model, words: alignWords(result) })
      }
      return `Transcribed ${media.length} file(s) with Whisper ${model}. Read it with get_transcript.`
    }
  },
  {
    name: 'get_frame',
    title: 'Look at a frame',
    description: 'A picture of the video at a time (as rendered: framing, captions, effects). Use it to check framing, text placement or what is on screen.',
    inputSchema: object({ time: S.num('Seconds'), width: S.int('Image width in pixels, 160-1080 (default 480)') }, ['time']),
    readOnly: true,
    run: async (a) => {
      const time = secondsToFlicks(num(a, 'time', { min: 0 }))
      const width = Math.round(num(a, 'width', { min: 160, max: 1080, def: 480 }))
      const blob = await renderStill(get().project, time, width, get().options.autoCrossfade)
      return { content: [{ type: 'image', data: await blobToBase64(blob), mimeType: 'image/jpeg' }] }
    }
  },
  {
    name: 'set_cursor',
    title: 'Move the cursor',
    description: 'Moves the play cursor (the user sees the frame there).',
    inputSchema: object({ time: S.num('Seconds') }, ['time']),
    readOnly: true,
    run: (a) => {
      A.setCursor(secondsToFlicks(num(a, 'time', { min: 0 })))
      return 'Cursor moved'
    }
  },
  {
    name: 'split',
    title: 'Split at a time',
    description: 'Splits the events under a time (all tracks, or one track) into two.',
    inputSchema: object({ time: S.num('Seconds'), track: S.int('Only this track') }, ['time']),
    run: (a) => {
      const t = secondsToFlicks(num(a, 'time', { min: 0 }))
      const track = trackId(a)
      const under = get().project.events.filter((e) => e.start < t && t < eventEnd(e) && (!track || e.trackId === track))
      if (!under.length) throw new ToolError('No event under that time')
      A.selectEvents(under.map((e) => e.id), 'replace')
      A.setCursor(t)
      A.splitAtCursor()
      return `Split ${under.length} event(s) at ${sec(t)} s`
    }
  },
  {
    name: 'delete_range',
    title: 'Cut out time ranges',
    description:
      'Removes time ranges from every track and closes the gaps (ripple), like deleting a time selection. Ranges are timeline seconds as they are now; they are processed from the last one.',
    inputSchema: object({ ranges: S.ranges('Ranges to remove'), ripple: S.bool('Close the gaps (default true)') }, ['ranges']),
    run: (a) => {
      const list = ranges(a).sort((x, y) => y.start - x.start)
      const ripple = bool(a, 'ripple', true)
      for (const r of list) {
        A.clearSelection()
        A.setTimeSelection(r)
        A.deleteTimeSelection(ripple)
      }
      A.clearTimeSelection()
      const total = list.reduce((n, r) => n + r.end - r.start, 0)
      return `Removed ${list.length} range(s), ${sec(total)} s. New duration ${sec(projectEnd(get().project))} s`
    }
  },
  {
    name: 'keep_ranges',
    title: 'Keep only some ranges',
    description: 'Keeps only these time ranges (in order) and removes everything else on every track: the quickest way to cut a long video down.',
    inputSchema: object({ ranges: S.ranges('Ranges to keep, timeline seconds') }, ['ranges']),
    run: (a) => {
      const gaps = A.keepRanges(ranges(a))
      return `Removed ${gaps} part(s). New duration ${sec(projectEnd(get().project))} s`
    }
  },
  {
    name: 'remove_words',
    title: 'Cut words out',
    description:
      'Text-based editing: cuts transcript words out of the speech track (with the pause after them). Give word positions as [start, end] seconds from get_transcript mode=words, or remove all fillers (ehm, uhm, repeated words).',
    inputSchema: object({
      track: S.int('Track number (default: the speech track)'),
      words: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: '[[start, end], ...] of the words to cut' },
      fillers: S.bool('Cut hesitation fillers and repeated words'),
      maybe_fillers: S.bool('Also cut words like cioè, tipo, allora, like, basically (check first)')
    }),
    run: (a) => {
      const id = speechTrack(a)
      const { words } = trackWords(id)
      if (!words.length) throw new ToolError('No transcript on this track: call transcribe first')
      const selected = new Set<number>()
      if (Array.isArray(a.words)) {
        for (const pair of a.words as unknown[]) {
          if (!Array.isArray(pair) || pair.length < 2) throw new ToolError('"words" must be [[start, end], ...]')
          const [s, e] = [secondsToFlicks(Number(pair[0])), secondsToFlicks(Number(pair[1]))]
          words.forEach((w, i) => {
            const middle = (w.start + w.end) / 2
            if (middle >= s && middle <= e) selected.add(i)
          })
        }
      }
      if (bool(a, 'fillers', false) || bool(a, 'maybe_fillers', false)) {
        words.forEach((_, i) => {
          const flag = wordFlag(words, i)
          if (flag === 'filler' || flag === 'repeat' || (flag === 'maybe' && bool(a, 'maybe_fillers', false))) selected.add(i)
        })
      }
      if (!selected.size) return 'No matching words: nothing cut'
      A.deleteWords(words, selected)
      return `Cut ${selected.size} word(s). New duration ${sec(projectEnd(get().project))} s`
    }
  },
  {
    name: 'remove_silences',
    title: 'Remove pauses (jump cuts)',
    description: 'Finds the pauses in the speech of a track by sound level and cuts them out (ripple).',
    inputSchema: object({
      track: S.int('Track number (default: the speech track)'),
      min_silence: S.num('Shortest pause to cut, seconds (default 0.5)'),
      padding: S.num('Sound kept around words, seconds (default 0.1)'),
      threshold_db: S.num('Level below which it is a pause (default: automatic)')
    }),
    run: async (a) => {
      const id = speechTrack(a)
      const events = get().project.events.filter((e) => e.trackId === id && hasSpeech(e))
      const analyses = await Promise.all(
        events.map(async (event) => ({
          event,
          levels: eventLevels(await mediaLevels(mediaById(event.mediaId)!), event.offset / F, event.length / F, event.rate)
        }))
      )
      const all = new Float32Array(analyses.reduce((n, x) => n + x.levels.length, 0))
      let at = 0
      for (const x of analyses) {
        all.set(x.levels, at)
        at += x.levels.length
      }
      const threshold = a.threshold_db === undefined ? autoThreshold(all) : num(a, 'threshold_db', { min: -90, max: -5 })
      const minSilence = num(a, 'min_silence', { min: 0.15, max: 10, def: 0.5 })
      const padding = num(a, 'padding', { min: 0, max: 1, def: 0.1 })
      const list = analyses.flatMap((x) =>
        findSilences(x.levels, threshold, minSilence, padding).map((s) => ({ start: x.event.start + secondsToFlicks(s.start), end: x.event.start + secondsToFlicks(s.end) }))
      )
      if (!list.length) return 'No pauses found'
      const cuts = A.cutRanges(events.map((e) => e.id), list, 'remove')
      return `Removed ${cuts} pause(s) (threshold ${threshold} dB). New duration ${sec(projectEnd(get().project))} s`
    }
  },
  {
    name: 'add_text',
    title: 'Add a title or text',
    description: `Adds a text event. Presets: ${TEXT_PRESETS.map((p) => p.id).join(', ')}. Write *word* to highlight words. "hook" is the opening line at the top of a Short; "progress" is a progress bar.`,
    inputSchema: object(
      {
        text: S.str('The text (\\n for a new line, *word* to highlight)'),
        start: S.num('Seconds'),
        duration: S.num('Seconds (default 4)'),
        preset: S.str('Look', TEXT_PRESETS.map((p) => p.id)),
        y: S.num('Vertical position, 0 = top, 1 = bottom (default: from the preset)'),
        rotation: S.num('Degrees, clockwise (default 0)')
      },
      ['text', 'start']
    ),
    run: (a) => {
      const preset = oneOf(a, 'preset', TEXT_PRESETS.map((p) => p.id), 'title')
      const start = secondsToFlicks(num(a, 'start', { min: 0 }))
      const id = A.addTextEvent(preset, start, null)
      if (!id) throw new ToolError('Could not add the text')
      A.closeDialog()
      const patch: Record<string, unknown> = { text: str(a, 'text') }
      if (a.y !== undefined) patch.y = num(a, 'y', { min: 0, max: 1 })
      if (a.rotation !== undefined) patch.rotation = normalizeAngle(num(a, 'rotation', { min: -3600, max: 3600 }))
      A.updateText(id, patch)
      if (a.duration !== undefined) {
        const length = secondsToFlicks(num(a, 'duration', { min: 0.1, max: 3600 }))
        A.commit((d) => {
          const e = d.events.find((o) => o.id === id)
          if (e) e.length = length
        })
      }
      return { id, note: 'Text added' }
    }
  },
  {
    name: 'add_captions',
    title: 'Add captions from the transcript',
    description: `Word-timed captions for the speech track as it is now (after cuts), on a new Captions track. Styles: ${CAPTION_STYLES.map((s) => `${s.id} (${s.label})`).join('; ')}.`,
    inputSchema: object({
      track: S.int('Speech track (default: the main one)'),
      style: S.str('Caption style', CAPTION_STYLES.map((s) => s.id)),
      emphasis: S.bool('Highlight key words (default true)'),
      emoji: S.bool('Add emoji to topic words (default false)')
    }),
    run: (a) => {
      const id = speechTrack(a)
      const { words, missing } = trackWords(id)
      if (!words.length) throw new ToolError(missing.length ? 'Not transcribed yet: call transcribe first' : 'No speech on that track')
      const count = captionsFromWords(words, oneOf(a, 'style', CAPTION_STYLES.map((s) => s.id), 'cap-highlight'))
      A.clearSelection()
      if (bool(a, 'emphasis', true)) A.enhanceCaptions('emphasis')
      if (bool(a, 'emoji', false)) A.enhanceCaptions('emoji')
      return `Added ${count} captions`
    }
  },
  {
    name: 'style_captions',
    title: 'Style the captions',
    description: 'Highlights key words (*word*) and/or adds emoji in the captions (the selected ones, or all).',
    inputSchema: object({ emphasis: S.bool('Highlight key words'), emoji: S.bool('Add emoji') }),
    run: (a) => {
      const done: string[] = []
      if (bool(a, 'emphasis', false)) done.push(`${A.enhanceCaptions('emphasis')} captions highlighted`)
      if (bool(a, 'emoji', false)) done.push(`emoji in ${A.enhanceCaptions('emoji')} captions`)
      return done.length ? done.join(', ') : 'Nothing to do: set emphasis or emoji to true'
    }
  },
  {
    name: 'set_format',
    title: 'Set the video format',
    description: 'Changes the frame size: 16:9 (YouTube), 9:16 (Shorts, Reels, TikTok), 1:1 or 4:5.',
    inputSchema: object({ aspect: S.str('Aspect ratio', ['16:9', '9:16', '1:1', '4:5']) }, ['aspect']),
    run: (a) => {
      const sizes = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080], '4:5': [1080, 1350] } as const
      const [w, h] = sizes[oneOf(a, 'aspect', ['16:9', '9:16', '1:1', '4:5'] as const, '16:9')]
      A.setFrameSize(w, h)
      A.closeDialog()
      return `Format ${w}x${h}`
    }
  },
  {
    name: 'frame_clips',
    title: 'Frame the clips',
    description:
      'How video clips fill the frame: fill (crop, no bars), fit (whole picture), blurred_background (fit over a blurred copy), split_screen (exactly two clips on two tracks: upper on top), pip (corner).',
    inputSchema: object(
      {
        mode: S.str('Framing', ['fill', 'fit', 'blurred_background', 'split_screen', 'pip']),
        event_ids: S.ids('Video events (default: all video clips)'),
        corner: S.str('For pip', ['topRight', 'topLeft', 'bottomRight', 'bottomLeft']),
        size: S.num('For pip: width as a fraction of the frame (default 0.4)')
      },
      ['mode']
    ),
    run: (a) => {
      const mode = oneOf(a, 'mode', ['fill', 'fit', 'blurred_background', 'split_screen', 'pip'] as const, 'fill')
      const ids = eventIds(a, allVideo)
      if (mode === 'fill' || mode === 'fit') {
        A.selectEvents(ids, 'replace')
        A.reframeVideoEvents(mode)
      } else if (mode === 'blurred_background') A.blurredBackground(ids)
      else if (mode === 'split_screen') {
        if (!A.splitScreen(ids)) throw new ToolError(get().status)
      } else {
        const corner = oneOf(a, 'corner', ['topRight', 'topLeft', 'bottomRight', 'bottomLeft'] as const, 'topRight') as Corner
        A.pictureInPicture(ids, corner, num(a, 'size', { min: 0.1, max: 0.9, def: 0.4 }))
      }
      return get().status
    }
  },
  {
    name: 'auto_reframe',
    title: 'Follow the face',
    description: 'For vertical videos made from horizontal footage: finds the face (locally) and writes Pan/Crop keyframes that keep it in frame.',
    inputSchema: object({ event_ids: S.ids('Video events (default: all video clips)'), steady: S.num('0 = nervous, 1 = very steady (default 0.6)') }),
    run: async (a) => {
      const targets = framedVideo(eventIds(a, allVideo))
      const settings = get().project.settings
      const keys = new Map<string, ReturnType<typeof reframeKeys> & object>()
      let missing = 0
      for (const event of targets) {
        const media = mediaById(event.mediaId)!
        const samples = await analyzeFaces(event, media, () => undefined, () => false)
        const result = reframeKeys(samples, media, settings, { mode: 'follow', smoothness: num(a, 'steady', { min: 0, max: 1, def: 0.6 }), zoom: 1 })
        if (result) keys.set(event.id, result)
        else missing++
      }
      A.setPanCropForEvents(keys)
      return `Reframed ${keys.size} clip(s)${missing ? `, no face in ${missing}` : ''}`
    }
  },
  {
    name: 'auto_zoom',
    title: 'Punch-in zooms',
    description: 'Makes a talking head lively: cuts = every other clip zoomed in (best after cutting pauses), punch = quick zoom on loud moments, push = slow zoom on every clip.',
    inputSchema: object({
      mode: S.str('Style', ['cuts', 'punch', 'push']),
      amount: S.num('Zoom factor 1.05-1.5 (default 1.15)'),
      face: S.bool('Zoom toward the face (default true)'),
      event_ids: S.ids('Video events (default: all video clips)')
    }),
    run: async (a) => {
      const mode = oneOf(a, 'mode', ['cuts', 'punch', 'push'] as const, 'cuts') as ZoomMode
      const options = { mode, amount: num(a, 'amount', { min: 1.05, max: 1.5, def: 1.15 }), face: bool(a, 'face', true) }
      const targets = framedVideo(eventIds(a, allVideo)).sort((x, y) => x.start - y.start)
      const settings = get().project.settings
      const counters = new Map<string, number>()
      const keys = new Map<string, ReturnType<typeof zoomKeys>>()
      for (const event of targets) {
        const n = counters.get(event.trackId) ?? 0
        counters.set(event.trackId, n + 1)
        const zoomed = n % 2 === 1
        if (mode === 'cuts' && !zoomed) continue
        const media = mediaById(event.mediaId)!
        const middle = (event.offset + (event.length * event.rate) / 2) / F
        const face = options.face ? await faceAt(media, middle).catch(() => null) : null
        const moments = mode === 'punch' ? await loudMoments(event, media) : []
        if (mode === 'punch' && !moments.length) continue
        keys.set(event.id, zoomKeys(event, media, settings, options, zoomed, face, moments))
      }
      A.setPanCropForEvents(keys)
      return `Zoom applied to ${keys.size} clip(s)`
    }
  },
  {
    name: 'rotate',
    title: 'Rotate clips, images or text',
    description:
      'Turns video clips, images or text events clockwise on screen (negative degrees = counterclockwise). 90 or -90 fixes sideways phone footage: a clip that fitted or filled the frame still does. reset=true makes them upright again.',
    inputSchema: object({ event_ids: S.ids(), degrees: S.num('Clockwise degrees, e.g. 90, -90, 180, 12'), reset: S.bool('Upright again (degrees is ignored)') }, [
      'event_ids'
    ]),
    run: (a) => {
      const turn = bool(a, 'reset', false) ? 'reset' : num(a, 'degrees', { min: -3600, max: 3600 })
      if (!A.rotateEvents(eventIds(a), turn)) throw new ToolError(get().status)
      return get().status
    }
  },
  {
    name: 'set_mask',
    title: 'Mask or cut out an event',
    description:
      'Makes part of a video, image or text event transparent (lower tracks show through). shape "smart" cuts out the object under the include points with a local AI, minus what the exclude points touch; points are fractions of the frame as get_frame shows it at `time`, and track follows the object through a video clip. "ellipse" and "rectangle" use cx, cy, w, h (fractions of the frame). "none" removes the mask.',
    inputSchema: object(
      {
        event_id: S.str('Event id'),
        shape: S.str('Mask shape', ['smart', 'ellipse', 'rectangle', 'none']),
        include: S.points('Smart: points on the object to keep'),
        exclude: S.points('Smart: points on parts to leave out'),
        time: S.num('Smart: seconds on the timeline where the points were picked (default: the cursor)'),
        track: S.bool('Smart: follow the object through the clip (default true for video)'),
        cx: S.num('Ellipse/rectangle center, 0-1'),
        cy: S.num('Ellipse/rectangle center, 0-1'),
        w: S.num('Ellipse/rectangle width, fraction of the frame'),
        h: S.num('Ellipse/rectangle height, fraction of the frame'),
        feather: S.num('Edge softness in px at 1080p (default 40, smart 6)'),
        invert: S.bool('Keep the outside instead (default false)')
      },
      ['event_id', 'shape']
    ),
    run: async (a) => {
      const id = str(a, 'event_id')
      const event = get().project.events.find((e) => e.id === id)
      if (!event) throw new ToolError(`Unknown event ${id}`)
      if (event.kind !== 'video') throw new ToolError('Masks apply to video, image and text events')
      const shape = oneOf(a, 'shape', ['smart', 'ellipse', 'rectangle', 'none'] as const, 'smart')
      if (shape === 'none') {
        A.replaceMask(id, null)
        return 'Mask removed'
      }
      const base: EventMask = { ...DEFAULT_MASK, ...event.mask, invert: bool(a, 'invert', event.mask?.invert ?? false) }
      if (shape !== 'smart') {
        A.replaceMask(id, {
          ...base,
          shape,
          cx: num(a, 'cx', { min: -1, max: 2, def: base.cx }),
          cy: num(a, 'cy', { min: -1, max: 2, def: base.cy }),
          w: num(a, 'w', { min: 0.01, max: 3, def: base.w }),
          h: num(a, 'h', { min: 0.01, max: 3, def: base.h }),
          feather: num(a, 'feather', { min: 0, max: 400, def: base.feather })
        })
        return `${shape} mask set`
      }
      const media = mediaById(event.mediaId)
      if (event.text || !media?.width || !media.height) throw new ToolError('Smart masks work on video and image events')
      const t = a.time === undefined ? get().cursor : secondsToFlicks(num(a, 'time', { min: 0 }))
      if (t < event.start || t >= eventEnd(event)) throw new ToolError('`time` must be inside the event')
      const srcTime = sourceTime(event, t)
      // Frame fractions as the agent sees them, to fractions of the source picture.
      const { width, height } = get().project.settings
      const { inverse } = sourceToOutput(panCropAt(event.panCrop, srcTime), media.width, media.height, width, height)
      const toSource = ([x, y]: MaskPoint): MaskPoint => {
        const [sx, sy] = inverse(x * width, y * height)
        return [sx / media.width, sy / media.height]
      }
      const include = framePoints(a, 'include').map(toSource)
      const exclude = framePoints(a, 'exclude').map(toSource)
      if (include.length === 0) throw new ToolError('Smart masks need at least one include point on the object')
      const seeds = { time: srcTime, include, exclude }
      const feather = num(a, 'feather', { min: 0, max: 400, def: 6 })
      if (media.kind === 'video' && bool(a, 'track', true)) {
        const path = await trackOutline(event, media, seeds, () => undefined, () => false)
        if (path.length === 0) throw new ToolError('Nothing found under the include points')
        A.replaceMask(id, { ...base, shape: 'custom', feather, path, smart: seeds })
        return `Object cut out and tracked: ${path.length} keyframe(s)`
      }
      const points = await smartOutline(media, seeds)
      if (!points) throw new ToolError('Nothing found under the include points')
      A.replaceMask(id, { ...base, shape: 'custom', feather, path: [{ time: srcTime, points }], smart: seeds })
      return 'Object cut out'
    }
  },
  {
    name: 'set_speed',
    title: 'Change the speed',
    description: 'Playback rate of clips (0.25-4): the same part of the media plays faster or slower, so the clip gets shorter or longer.',
    inputSchema: object({ event_ids: S.ids(), rate: S.num('Rate, e.g. 1.25 or 0.5') }, ['event_ids', 'rate']),
    run: (a) => `Speed set on ${A.setPlaybackRate(eventIds(a), num(a, 'rate', { min: 0.25, max: 4 }))} event(s)`
  },
  {
    name: 'set_fades',
    title: 'Fade in/out',
    description: 'Sets the fade in and/or fade out of events (seconds; 0 removes it). Works for video (opacity) and audio (volume).',
    inputSchema: object({ event_ids: S.ids(), fade_in: S.num('Seconds'), fade_out: S.num('Seconds') }, ['event_ids']),
    run: (a) => {
      const ids = new Set(eventIds(a))
      const fadeIn = a.fade_in === undefined ? null : secondsToFlicks(num(a, 'fade_in', { min: 0, max: 60 }))
      const fadeOut = a.fade_out === undefined ? null : secondsToFlicks(num(a, 'fade_out', { min: 0, max: 60 }))
      A.commit((d) => {
        for (const e of d.events) {
          if (!ids.has(e.id)) continue
          if (fadeIn !== null) e.fadeIn = Math.min(fadeIn, e.length)
          if (fadeOut !== null) e.fadeOut = Math.min(fadeOut, e.length - e.fadeIn)
        }
      })
      return `Fades set on ${ids.size} event(s)`
    }
  },
  {
    name: 'add_fx',
    title: 'Add an effect',
    description: `Adds an effect to events. Video: ${VIDEO_FX.map((f) => f.type).join(', ')}. Audio: ${AUDIO_FX.map((f) => f.type).join(', ')}.`,
    inputSchema: object({ event_ids: S.ids(), fx: S.str('Effect type') }, ['event_ids', 'fx']),
    run: (a) => {
      const type = str(a, 'fx')
      if (![...VIDEO_FX, ...AUDIO_FX].some((f) => f.type === type)) throw new ToolError(`Unknown effect "${type}"`)
      A.addFx(eventIds(a), type)
      return get().status
    }
  },
  {
    name: 'delete_events',
    title: 'Delete events',
    description: 'Deletes events (with their grouped audio/video). ripple=true closes the gaps.',
    inputSchema: object({ event_ids: S.ids(), ripple: S.bool('Close the gaps (default false)') }, ['event_ids']),
    run: (a) => {
      A.clearTimeSelection()
      A.selectEvents(eventIds(a), 'replace')
      A.deleteCommand(bool(a, 'ripple', false))
      return get().status
    }
  },
  {
    name: 'move_event',
    title: 'Move an event',
    description: 'Moves an event (and its group) to a new start time and/or to another track of the same kind.',
    inputSchema: object({ event_id: S.str('Event id'), start: S.num('New start, seconds'), track: S.int('Track number') }, ['event_id']),
    run: (a) => {
      const id = str(a, 'event_id')
      const event = get().project.events.find((e) => e.id === id)
      if (!event) throw new ToolError(`Unknown event ${id}`)
      const target = trackId(a)
      if (target && get().project.tracks.find((t) => t.id === target)?.kind !== event.kind) throw new ToolError('The track must be of the same kind (video or audio)')
      const delta = a.start === undefined ? 0 : secondsToFlicks(num(a, 'start', { min: 0 })) - event.start
      A.commit((d) => {
        for (const e of d.events) {
          if (e.id !== id && !(event.groupId && e.groupId === event.groupId)) continue
          e.start = Math.max(0, e.start + delta)
          if (e.id === id && target) e.trackId = target
        }
      })
      return 'Moved'
    }
  },
  {
    name: 'add_marker',
    title: 'Add a marker',
    description: 'Adds a named marker on the timeline (chapters, notes for the user).',
    inputSchema: object({ time: S.num('Seconds'), label: S.str('Name') }, ['time']),
    run: (a) => {
      const time = secondsToFlicks(num(a, 'time', { min: 0 }))
      A.addMarkerAt(time)
      const label = str(a, 'label', '')
      if (label) {
        A.commit((d) => {
          const m = [...d.markers].reverse().find((x) => Math.abs(x.time - time) < F / 100)
          if (m) m.label = label
        })
      }
      return 'Marker added'
    }
  },
  {
    name: 'undo',
    title: 'Undo',
    description: 'Undoes the last edit (yours or the user\'s).',
    inputSchema: object({}),
    run: () => {
      A.undo()
      return 'Undone'
    }
  },
  {
    name: 'redo',
    title: 'Redo',
    description: 'Redoes the last undone edit.',
    inputSchema: object({}),
    run: () => {
      A.redo()
      return 'Redone'
    }
  },
  {
    name: 'propose_shorts',
    title: 'Propose Shorts',
    description:
      'Long video → Shorts: lists the moments you picked in the Shorts tab for the user to preview and make. Each Short has a title, a hook (opening line shown at the top, *key words* highlighted) and one or more timeline ranges played in order (whole sentences, a hook in the first seconds, 15-60 s in total). Replaces earlier proposals.',
    inputSchema: object(
      {
        shorts: {
          type: 'array',
          description: 'The Shorts, best first',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              hook: { type: 'string', description: 'Short punchy opening line, *key words* highlighted' },
              reason: { type: 'string', description: 'Why this moment works, for the user' },
              ranges: S.ranges('Timeline ranges in seconds, in playback order')
            },
            required: ['title', 'ranges']
          }
        }
      },
      ['shorts']
    ),
    readOnly: true,
    run: (a) => {
      if (get().longVideo) throw new ToolError('A Short is open: call back_to_long_video first')
      const list = a.shorts
      if (!Array.isArray(list) || list.length === 0) throw new ToolError('"shorts" must be a non-empty array')
      const end = projectEnd(get().project)
      const shorts = list.map((item, i) => {
        const s = item as Args
        const r = ranges(s, 'ranges')
          .map((x) => ({ start: Math.min(x.start, end), end: Math.min(x.end, end) }))
          .filter((x) => x.end > x.start)
        if (!r.length) throw new ToolError(`shorts[${i}]: the ranges are outside the video (it lasts ${sec(end)} s)`)
        return {
          id: uid(),
          title: str(s, 'title').slice(0, 80),
          hook: str(s, 'hook', '').slice(0, 120),
          reason: str(s, 'reason', '').slice(0, 300),
          ranges: r,
          source: 'AI agent'
        }
      })
      A.setShorts(shorts)
      A.setDockTab('shorts')
      return `Proposed ${shorts.length} Shorts in the Shorts tab: ${shorts.map((s, i) => `${i + 1}. ${s.title} (${sec(shortDuration(s))} s)`).join('; ')}. The user can preview them; call make_short to build one.`
    }
  },
  {
    name: 'find_highlights',
    title: 'Find highlights (local)',
    description:
      'Local finder without AI: proposes moments of whole sentences with a strong opening, from the transcript. Usually worse than your own judgment: prefer reading the transcript and calling propose_shorts.',
    inputSchema: object({ count: S.int('How many (default 4)'), min_seconds: S.num('Default 20'), max_seconds: S.num('Default 60') }),
    readOnly: true,
    run: (a) => {
      const id = speechTrack(a)
      const { words } = trackWords(id)
      if (!words.length) throw new ToolError('No transcript: call transcribe first')
      const found = findHighlights(
        words,
        Math.round(num(a, 'count', { min: 1, max: 10, def: 4 })),
        num(a, 'min_seconds', { min: 5, max: 120, def: 20 }),
        num(a, 'max_seconds', { min: 10, max: 180, def: 60 })
      )
      A.setShorts(found.map((c) => ({ ...c, id: uid() })))
      A.setDockTab('shorts')
      return { found: found.map((c) => ({ title: c.title, start: sec(c.ranges[0].start), end: sec(c.ranges[0].end) })) }
    }
  },
  {
    name: 'make_short',
    title: 'Make a Short',
    description:
      'Builds one proposed Short (number from propose_shorts) in place: keeps its ranges, 9:16, framing, captions with highlighted key words, hook title. The long video is saved (if it has a file) and kept: back_to_long_video returns to it for the next Short.',
    inputSchema: object(
      {
        number: S.int('Short number, from 1'),
        framing: S.str('Horizontal footage in the vertical frame', ['reframe', 'blurred', 'fill']),
        captions: S.str('Caption style, or none', [...CAPTION_STYLES.map((s) => s.id), 'none']),
        hook: S.bool('Hook title at the top (default true)'),
        progress_bar: S.bool('Progress bar (default false)')
      },
      ['number']
    ),
    run: async (a) => {
      const shorts = get().shorts
      const n = Math.round(num(a, 'number', { min: 1, max: Math.max(1, shorts.length) }))
      const candidate = shorts[n - 1]
      if (!candidate) throw new ToolError('No such Short: call propose_shorts first')
      const captions = oneOf(a, 'captions', [...CAPTION_STYLES.map((s) => s.id), 'none'], DEFAULT_SHORT_OPTIONS.captions ?? 'none')
      return makeShort(candidate, {
        framing: oneOf(a, 'framing', ['reframe', 'blurred', 'fill'] as const, 'reframe') as ShortFraming,
        captions: captions === 'none' ? null : captions,
        hook: bool(a, 'hook', true),
        progressBar: bool(a, 'progress_bar', false)
      })
    }
  },
  {
    name: 'back_to_long_video',
    title: 'Back to the long video',
    description:
      'Leaves the current Short and returns to the long video it was made from (with its Shorts list). An unsaved Short is discarded: pass discard=true once the user has rendered or saved it.',
    inputSchema: object({ discard: S.bool('Discard the unsaved Short') }),
    run: (a) => {
      if (!get().longVideo) throw new ToolError('No Short is open')
      if (isDirty() && !bool(a, 'discard', false)) {
        throw new ToolError('The Short has unsaved changes: ask the user to render or save it, then call again with discard=true')
      }
      backToLongVideo()
      return 'Back to the long video'
    }
  },
  {
    name: 'save_project',
    title: 'Save the project',
    description: 'Saves the project to its file. A project that was never saved must be saved by the user first (File › Save).',
    inputSchema: object({}),
    run: async () => {
      if (!get().projectPath || !bridge) throw new ToolError('The project has no file yet: ask the user to save it once (File › Save)')
      if (!(await saveProject(false))) throw new ToolError('Save failed')
      return `Saved ${get().projectPath}`
    }
  }
]

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))

/** Tool list for MCP tools/list. */
export function listTools(): object[] {
  return TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: { title: t.title, readOnlyHint: !!t.readOnly, destructiveHint: !t.readOnly, openWorldHint: false }
  }))
}

export const isReadOnly = (name: string): boolean => !!BY_NAME.get(name)?.readOnly

/** Runs a tool; failures come back as results with isError, so the agent can read them. */
export async function callTool(name: string, args: unknown): Promise<ToolResult> {
  const tool = BY_NAME.get(name)
  if (!tool) return { content: [{ type: 'text', text: `Unknown tool "${name}"` }], isError: true }
  try {
    const out = await tool.run(args && typeof args === 'object' ? (args as Args) : {})
    if (typeof out === 'string') return { content: [{ type: 'text', text: out }] }
    if (out && typeof out === 'object' && 'content' in out && Array.isArray((out as ToolResult).content)) return out as ToolResult
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 1) }] }
  } catch (err) {
    return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true }
  }
}

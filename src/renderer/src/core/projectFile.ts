import type { MediaItem, MediaKind, Project, ReverseLink, TimelineEvent } from './types'
import type { MediaTranscript } from './transcript'
import type { ShortCandidate } from './shorts'
import { emptyProject } from './store'
import { normalizeText } from './text'
import { normalizeMask } from './mask'
import { DEFAULT_FADE_CURVE, clampRate, isFadeCurve } from './fades'

/** On-disk format of a .boar project. Media are referenced by absolute path. */
export interface ProjectFileV1 {
  app: 'Boar'
  version: 1
  savedAt: string
  project: Project
  media: SavedMedia[]
  /** Word-level transcripts by media id (Transcript tab). */
  transcripts?: Record<string, MediaTranscript>
  /** Short-form candidates (Shorts tab). */
  shorts?: ShortCandidate[]
}

export interface SavedMedia {
  id: string
  name: string
  kind: MediaKind
  path: string
  size: number
  /** Reversed copy of another media file (Reverse). */
  reverseOf?: ReverseLink
}

const isReverseLink = (r: unknown): r is ReverseLink => {
  const l = r as ReverseLink | null
  return !!l && typeof l.mediaId === 'string' && Number.isFinite(l.start) && Number.isFinite(l.end) && l.end > l.start
}

export function serializeProject(
  project: Project,
  media: readonly MediaItem[],
  transcripts: Record<string, MediaTranscript> = {},
  shorts: ShortCandidate[] = []
): string {
  const used = new Set(project.events.map((e) => e.mediaId))
  const saved = media.filter((m) => m.status !== 'error' || used.has(m.id))
  const file: ProjectFileV1 = {
    app: 'Boar',
    version: 1,
    savedAt: new Date().toISOString(),
    project,
    // Keep everything in Project Media, used or not.
    media: saved.map((m) => ({ id: m.id, name: m.name, kind: m.kind, path: m.path, size: m.size, ...(m.reverseOf ? { reverseOf: m.reverseOf } : {}) })),
    transcripts: Object.fromEntries(saved.filter((m) => transcripts[m.id]).map((m) => [m.id, transcripts[m.id]])),
    shorts
  }
  return JSON.stringify(file, null, 1)
}

/** Parses and normalizes a project file, filling fields added after it was saved. */
export function parseProject(json: string): {
  project: Project
  media: SavedMedia[]
  transcripts: Record<string, MediaTranscript>
  shorts: ShortCandidate[]
} {
  let data: Partial<ProjectFileV1>
  try {
    data = JSON.parse(json) as Partial<ProjectFileV1>
  } catch {
    throw new Error('not a valid project file')
  }
  // Projects are recognized by their layout.
  if (!data.project || !Array.isArray(data.project.tracks)) throw new Error('not a Boar project')
  if ((data.version ?? 0) > 1) throw new Error('project saved by a newer Boar')
  const base = emptyProject()
  const p = data.project
  const project: Project = {
    settings: { ...base.settings, ...p.settings, frameRate: { ...base.settings.frameRate, ...p.settings?.frameRate } },
    tracks: (p.tracks ?? []).map((t) => ({ ...t })),
    events: (p.events ?? []).map(
      (e): TimelineEvent => ({
        ...e,
        fadeIn: e.fadeIn ?? 0,
        fadeOut: e.fadeOut ?? 0,
        fadeInCurve: isFadeCurve(e.fadeInCurve) ? e.fadeInCurve : DEFAULT_FADE_CURVE,
        fadeOutCurve: isFadeCurve(e.fadeOutCurve) ? e.fadeOutCurve : DEFAULT_FADE_CURVE,
        rate: typeof e.rate === 'number' && e.rate > 0 && !e.text ? clampRate(e.rate) : 1,
        gain: e.gain ?? 1,
        groupId: e.groupId ?? null,
        panCrop: e.panCrop ?? [],
        text: e.text ? normalizeText(e.text) : null,
        mask: e.mask ? normalizeMask(e.mask) : null,
        fx: Array.isArray(e.fx) ? e.fx : [],
        envelope: Array.isArray(e.envelope) ? e.envelope : [],
        transition: e.transition ?? null,
        transitionOut: e.transitionOut ?? null
      })
    ),
    markers: (p.markers ?? []).map((m) => ({ ...m }))
  }
  const transcripts: Record<string, MediaTranscript> = {}
  for (const [id, t] of Object.entries(data.transcripts ?? {})) {
    if (!t || !Array.isArray(t.words)) continue
    const words = t.words.filter((w) => w && typeof w.text === 'string' && Number.isFinite(w.start) && Number.isFinite(w.end))
    transcripts[id] = { language: String(t.language ?? ''), model: String(t.model ?? ''), words }
  }
  const shorts = (Array.isArray(data.shorts) ? data.shorts : []).filter(
    (c) => c && typeof c.id === 'string' && Array.isArray(c.ranges) && c.ranges.every((r) => Number.isFinite(r?.start) && Number.isFinite(r?.end))
  )
  const media = (data.media ?? [])
    .filter((m) => m && m.id && m.name)
    .map(({ reverseOf, ...m }) => (isReverseLink(reverseOf) ? { ...m, reverseOf } : m))
  return { project, media, transcripts, shorts }
}

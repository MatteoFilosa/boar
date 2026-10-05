import * as A from '../core/actions'
import { emptyProject, mediaById, useEditor } from '../core/store'
import { CAPTION_STYLES, chunkWords } from '../core/captions'
import { FLICKS_PER_SECOND, secondsToFlicks } from '../core/time'
import { projectEnd } from '../core/timeline'
import { defaultSpeechTrack, hasSpeech, speechTracks, timedWord, wordsOnTimeline } from '../core/transcript'
import { type ShortCandidate, shortDuration } from '../core/shorts'
import type { PanCropKey } from '../core/pancrop'
import { isDirty, projectName, saveProject } from '../core/session'
import { bridge } from '../platform'
import { analyzeFaces, reframeKeys } from './reframe'

// Builds a Short in place from one candidate. The long project is kept in
// store.longVideo (same media) so backToLongVideo can restore it.

export type ShortFraming = 'reframe' | 'blurred' | 'fill'

export interface MakeShortOptions {
  framing: ShortFraming
  /** Caption style id, or null for no captions. */
  captions: string | null
  hook: boolean
  progressBar: boolean
}

export const DEFAULT_SHORT_OPTIONS: MakeShortOptions = { framing: 'reframe', captions: 'cap-highlight', hook: true, progressBar: false }

const get = useEditor.getState

export async function makeShort(candidate: ShortCandidate, o: MakeShortOptions, onStep: (text: string) => void = () => undefined): Promise<string> {
  const start = get()
  if (start.longVideo) throw new Error('This is already a Short: go back to the long video first')
  if (candidate.ranges.length === 0 || shortDuration(candidate) <= 0) throw new Error('The candidate has no time range')
  // The long edit is saved to its file first, when it has one.
  if (bridge && start.projectPath && isDirty()) {
    onStep('Saving the long video…')
    await saveProject(false)
  }
  const s = get()
  const longVideo = {
    name: projectName(s.projectPath),
    project: s.project,
    savedProject: s.savedProject,
    past: s.past,
    future: s.future,
    projectPath: s.projectPath,
    transcripts: s.transcripts,
    savedTranscripts: s.savedTranscripts,
    shorts: s.shorts,
    savedShorts: s.savedShorts
  }
  onStep('Cutting…')
  A.keepRanges(candidate.ranges)
  const { width, height } = get().project.settings
  if (height <= width) A.setFrameSize(1080, 1920)
  A.closeDialog()

  const clips = A.foregroundVideoEvents().filter((e) => mediaById(e.mediaId)?.status === 'ready')
  if (o.framing === 'blurred') A.blurredBackground(clips.map((e) => e.id))
  else if (o.framing === 'fill' || o.framing === 'reframe') {
    A.selectEvents(clips.map((e) => e.id), 'replace')
    A.reframeVideoEvents('fill')
    if (o.framing === 'reframe') {
      const keys = new Map<string, PanCropKey[]>()
      for (const [i, event] of clips.entries()) {
        onStep(`Following the face… ${i + 1}/${clips.length}`)
        const media = mediaById(event.mediaId)
        if (!media) continue
        const samples = await analyzeFaces(event, media, () => undefined, () => false).catch(() => [])
        const result = reframeKeys(samples, media, get().project.settings, { mode: 'follow', smoothness: 0.6, zoom: 1 })
        if (result) keys.set(event.id, result)
      }
      if (keys.size) A.setPanCropForEvents(keys)
    }
  }

  let captions = 0
  if (o.captions) {
    const project = get().project
    const track = defaultSpeechTrack(project, [], speechTracks(project))
    if (track) {
      const words = wordsOnTimeline(project.events.filter((e) => e.trackId === track && hasSpeech(e)), get().transcripts)
      const look = CAPTION_STYLES.find((c) => c.id === o.captions) ?? CAPTION_STYLES[0]
      const timed = words.map(timedWord)
      captions = A.addCaptionEvents(chunkWords(timed, { maxChars: look.maxChars, maxWords: look.maxWords, maxGap: 0.6 }), 0, look.id)
      if (captions) {
        A.clearSelection()
        A.enhanceCaptions('emphasis')
      }
    }
  }

  const textEvent = (preset: string, text: string | null, length: number): void => {
    const id = A.addTextEvent(preset, 0, 'new')
    A.closeDialog()
    if (!id) return
    if (text !== null) A.updateText(id, { text })
    A.commit((d) => {
      const e = d.events.find((x) => x.id === id)
      if (e) e.length = Math.max(FLICKS_PER_SECOND / 2, length)
    })
  }
  if (o.hook && candidate.hook.trim()) textEvent('hook', candidate.hook.trim(), Math.min(secondsToFlicks(3.5), projectEnd(get().project)))
  if (o.progressBar) textEvent('progress', null, projectEnd(get().project))

  // The Short is a new, unsaved project; Undo can still step back into the long video.
  useEditor.setState({
    projectPath: null,
    savedProject: emptyProject(),
    transcripts: get().transcripts,
    savedTranscripts: {},
    shorts: [],
    savedShorts: [],
    longVideo,
    selection: [],
    cursor: 0,
    dockTab: 'shorts'
  })
  const seconds = Math.round(projectEnd(get().project) / FLICKS_PER_SECOND)
  const summary = `Short “${candidate.title}” ready: ${seconds} s, 9:16${captions ? `, ${captions} captions` : ''}. Render it with Render As; save it to keep it.`
  A.setStatus(summary)
  return summary
}

/** Returns to the long video the current Short was made from (the Short is discarded unless saved). */
export function backToLongVideo(): boolean {
  const s = get()
  const long = s.longVideo
  if (!long) return false
  useEditor.setState({
    project: long.project,
    savedProject: long.savedProject,
    past: long.past,
    future: long.future,
    projectPath: long.projectPath,
    transcripts: long.transcripts,
    savedTranscripts: long.savedTranscripts,
    shorts: long.shorts,
    savedShorts: long.savedShorts,
    longVideo: null,
    selection: [],
    timeSelection: null,
    cursor: 0,
    dialog: null
  })
  A.setStatus(`Back to ${long.name}`)
  return true
}

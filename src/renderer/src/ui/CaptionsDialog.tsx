import { useEffect, useState } from 'react'
import { Download, X } from 'lucide-react'
import * as A from '../core/actions'
import { mediaById, useEditor } from '../core/store'
import { CAPTION_STYLES, alignWords, chunkWords } from '../core/captions'
import { defaultSpeechTrack, hasSpeech, speechTracks, wordsOnTimeline } from '../core/transcript'
import { FLICKS_PER_SECOND } from '../core/time'
import { PresetThumb } from './TextEditor'
import { presetById } from '../core/text'
import { formatDuration, formatTimecode } from '../core/time'
import type { Project, TimelineEvent } from '../core/types'
import type { TimeRange } from '../core/store'
import { type CaptionProgress, type CaptionStatus, bridge } from '../platform'
import { BoarProgress } from './BoarProgress'
import { transcribeMedia } from '../engine/transcribe'

const LANGUAGES = [
  ['auto', 'Detect automatically'],
  ['it', 'Italian'],
  ['en', 'English'],
  ['es', 'Spanish'],
  ['fr', 'French'],
  ['de', 'German'],
  ['pt', 'Portuguese']
] as const

/** What gets captions: every clip of the speech track, the selected clips, or the time selection. */
type Scope = 'all' | 'selected' | 'range'

/** One event per clip: the audio of a video file grouped with its picture, not both. */
function onePerClip(list: TimelineEvent[]): TimelineEvent[] {
  const audio = list.filter((e) => e.kind === 'audio')
  const groups = new Set(audio.map((e) => e.groupId).filter(Boolean))
  return [...audio, ...list.filter((e) => e.kind !== 'audio' && !(e.groupId && groups.has(e.groupId)))]
}

/** The clips whose speech becomes captions. */
function scopeEvents(project: Project, selection: string[], scope: Scope, range: TimeRange | null): TimelineEvent[] {
  const speech = project.events.filter(hasSpeech)
  if (scope === 'selected') return onePerClip(speech.filter((e) => selection.includes(e.id)))
  const track = defaultSpeechTrack(project, selection, speechTracks(project))
  const onTrack = speech.filter((e) => e.trackId === track)
  return scope === 'range' && range ? onTrack.filter((e) => e.start < range.end && e.start + e.length > range.start) : onTrack
}

const totalLength = (list: TimelineEvent[]): number => list.reduce((sum, e) => sum + e.length, 0)

export function CaptionsDialog(): React.JSX.Element {
  const project = useEditor((s) => s.project)
  const selection = useEditor((s) => s.selection)
  const range = useEditor((s) => s.timeSelection)
  const rate = project.settings.frameRate
  const [status, setStatus] = useState<CaptionStatus | null>(null)
  const [model, setModel] = useState('base')
  const [language, setLanguage] = useState('auto')
  const [style, setStyle] = useState(CAPTION_STYLES[0].id)
  const [busy, setBusy] = useState<CaptionProgress | null>(null)
  const [error, setError] = useState('')
  const selectedClips = scopeEvents(project, selection, 'selected', range)
  // Selected clips first, then the time selection, else the whole timeline.
  const [scope, setScope] = useState<Scope>(() => (selectedClips.length > 0 ? 'selected' : range ? 'range' : 'all'))
  const [again, setAgain] = useState(false)

  useEffect(() => {
    if (!bridge) return
    void bridge.captionsStatus().then(setStatus)
    return bridge.onCaptionProgress(setBusy)
  }, [])

  const clips = scopeEvents(project, selection, scope, range)
  const mediaIds = [...new Set(clips.map((e) => e.mediaId))]
  const transcripts = useEditor((s) => s.transcripts)
  // Transcripts from the Transcript tab (or an earlier run) are reused: no second Whisper pass.
  const missing = mediaIds.filter((id) => again || !transcripts[id])
  const anyKnown = mediaIds.some((id) => transcripts[id])
  const known = mediaIds.length > 0 && missing.length === 0
  const chosen = status?.models.find((m) => m.id === model)

  const downloadModel = async (): Promise<void> => {
    if (!bridge || !chosen) return
    setError('')
    setBusy({ phase: 'download', progress: 0 })
    try {
      await bridge.downloadModel(chosen.id)
      setStatus(await bridge.captionsStatus())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const generate = async (): Promise<void> => {
    if (clips.length === 0) return
    if (!known && !bridge) return
    setError('')
    setBusy({ phase: 'prepare', progress: 0 })
    try {
      const look = CAPTION_STYLES.find((s) => s.id === style) ?? CAPTION_STYLES[0]
      // Each file is transcribed whole, once: the words then follow every cut,
      // and the Transcript tab and later captions reuse them.
      for (const id of missing) {
        const media = mediaById(id)
        if (!media) continue
        const transcript = await transcribeMedia(media, 0, media.duration / FLICKS_PER_SECOND, model, language, setBusy)
        A.setTranscript(id, { language, model, words: alignWords(transcript) })
      }
      const span = scope === 'range' ? range : null
      const words = wordsOnTimeline(clips, useEditor.getState().transcripts)
        .filter((w) => !span || ((w.start + w.end) / 2 >= span.start && (w.start + w.end) / 2 < span.end))
        .map((w) => ({ text: w.text, start: w.start / FLICKS_PER_SECOND, end: w.end / FLICKS_PER_SECOND }))
      const captions = chunkWords(words, { maxChars: look.maxChars, maxWords: look.maxWords, maxGap: 0.6 })
      if (captions.length === 0) {
        setError('No speech found in these clips.')
        return
      }
      A.addCaptionEvents(captions, 0, style)
      A.closeDialog()
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err))
    } finally {
      setBusy(null)
    }
  }

  let blocker = ''
  if (clips.length === 0) blocker = scope === 'selected' ? 'None of the selected clips has sound.' : 'No clip with sound on the timeline.'
  else if (known) blocker = ''
  else if (!bridge) blocker = 'Captions run in the desktop app (npm run dev), not in the browser preview.'
  else if (status && !status.engine) blocker = 'The speech engine is missing from this build of Boar.'

  const allClips = scopeEvents(project, selection, 'all', range)
  const rangeClips = range ? scopeEvents(project, selection, 'range', range) : []
  const describe = (list: TimelineEvent[]): string => `${list.length} clip${list.length === 1 ? '' : 's'}, ${formatDuration(totalLength(list))}`
  const scopes: { id: Scope; label: string; detail: string; disabled: boolean }[] = [
    { id: 'all', label: 'The whole timeline', detail: describe(allClips), disabled: allClips.length === 0 },
    {
      id: 'selected',
      label: 'Selected clips',
      detail: selectedClips.length ? describe(selectedClips) : 'select clips on the timeline first (Ctrl+click, or the selection tool)',
      disabled: selectedClips.length === 0
    },
    {
      id: 'range',
      label: 'Time selection',
      detail: range ? `${formatTimecode(range.start, rate)} to ${formatTimecode(range.end, rate)}` : 'drag on the ruler first',
      disabled: rangeClips.length === 0
    }
  ]

  return (
    <div className="modal-backdrop">
      <div className="modal" style={{ width: 640 }} role="dialog" aria-label="Generate captions">
        <div className="modal-title">
          <span>Generate Captions (Whisper, local)</span>
          <button className="tool-btn" title="Close (Esc)" disabled={busy !== null} onClick={A.closeDialog}>
            <X size={14} />
          </button>
        </div>
        <div className="modal-body">
          <p className="dim">
            Speech is transcribed on this PC with Whisper, on the graphics card when it can; nothing is uploaded.
            Captions become editable text events on a new "Captions" track.
          </p>
          <div className="form">
            <label>Captions for</label>
            <div className="caption-scope">
              {scopes.map((s) => (
                <label key={s.id} className={`te-check${s.disabled ? ' dim' : ''}`}>
                  <input type="radio" name="caption-scope" checked={scope === s.id} disabled={s.disabled} onChange={() => setScope(s.id)} />
                  {s.label}
                  <span className="dim"> · {s.detail}</span>
                </label>
              ))}
              {anyKnown && (
                <label className="te-check" title="Transcripts made with Boar 0.7.0 to 0.7.2 can have word timings that drift: transcribing again fixes them">
                  <input type="checkbox" checked={again} onChange={(e) => setAgain(e.target.checked)} />
                  Transcribe again (otherwise the saved transcript is reused)
                </label>
              )}
            </div>
            <label>Language</label>
            <select className="select" value={language} onChange={(e) => setLanguage(e.target.value)}>
              {LANGUAGES.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
            <label>Style</label>
            <div className="caption-styles">
              {CAPTION_STYLES.map((s) => {
                const preset = presetById(s.id)
                return (
                  <button key={s.id} className={`caption-style${style === s.id ? ' active' : ''}`} title={s.label} onClick={() => setStyle(s.id)}>
                    {preset && <PresetThumb preset={preset} />}
                    <span>{s.label}</span>
                  </button>
                )
              })}
            </div>
            <label>Model</label>
            <div className="caption-models">
              {(status?.models ?? []).map((m) => (
                <label key={m.id} className="te-check">
                  <input type="radio" name="model" checked={model === m.id} onChange={() => setModel(m.id)} />
                  {m.id} · {m.sizeMB >= 1000 ? `${(m.sizeMB / 1024).toFixed(1)} GB` : `${m.sizeMB} MB`} · {m.note}
                  {m.installed ? <span className="badge ok">installed</span> : <span className="badge">not downloaded</span>}
                </label>
              ))}
              {!status && bridge && <span className="dim">Checking the speech engine…</span>}
            </div>
          </div>

          {busy && (
            <BoarProgress value={busy.progress}>
              {busy.phase === 'download' ? 'Downloading model' : busy.phase === 'prepare' ? 'Reading the sound' : 'Transcribing'}{' '}
              {Math.round(busy.progress * 100)}%
            </BoarProgress>
          )}
          {(blocker || error) && <div className="render-result error">{error || blocker}</div>}

          <div className="modal-actions">
            <button className="btn" disabled={busy !== null} onClick={A.closeDialog}>
              Close
            </button>
            {chosen && !chosen.installed && !known ? (
              <button className="btn primary" disabled={busy !== null || !!blocker} onClick={() => void downloadModel()}>
                <Download size={13} /> Download {chosen.id} ({chosen.sizeMB} MB)
              </button>
            ) : (
              <button className="btn primary" disabled={busy !== null || !!blocker || (!chosen && !known)} onClick={() => void generate()}>
                {known ? 'Generate captions from the transcript' : 'Generate captions'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

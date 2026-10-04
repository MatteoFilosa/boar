import { useEffect, useState } from 'react'
import { Download, X } from 'lucide-react'
import * as A from '../core/actions'
import { mediaById, useEditor } from '../core/store'
import { CAPTION_STYLES, alignWords, chunkWords } from '../core/captions'
import { wordsOnTimeline } from '../core/transcript'
import { FLICKS_PER_SECOND } from '../core/time'
import { PresetThumb } from './TextEditor'
import { presetById } from '../core/text'
import { flicksToSeconds, formatTimecode } from '../core/time'
import { sourceLength } from '../core/timeline'
import type { TimelineEvent } from '../core/types'
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

/** The event whose sound gets transcribed: selected audio first, else a selected video's file. */
function sourceEvent(events: TimelineEvent[], selection: string[]): TimelineEvent | undefined {
  const selected = events.filter((e) => selection.includes(e.id) && !e.text)
  return (
    selected.find((e) => e.kind === 'audio') ??
    selected.find((e) => mediaById(e.mediaId)?.hasAudio) ??
    events.find((e) => e.kind === 'audio' && mediaById(e.mediaId)?.hasAudio)
  )
}

export function CaptionsDialog(): React.JSX.Element {
  const events = useEditor((s) => s.project.events)
  const selection = useEditor((s) => s.selection)
  const rate = useEditor((s) => s.project.settings.frameRate)
  const [status, setStatus] = useState<CaptionStatus | null>(null)
  const [model, setModel] = useState('base')
  const [language, setLanguage] = useState('auto')
  const [style, setStyle] = useState(CAPTION_STYLES[0].id)
  const [busy, setBusy] = useState<CaptionProgress | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!bridge) return
    void bridge.captionsStatus().then(setStatus)
    return bridge.onCaptionProgress(setBusy)
  }, [])

  const event = sourceEvent(events, selection)
  const media = event ? mediaById(event.mediaId) : undefined
  const transcripts = useEditor((s) => s.transcripts)
  // A transcript from the Transcript tab is reused: no second Whisper pass.
  const known = event && media && transcripts[media.id] ? wordsOnTimeline([event], { [media.id]: transcripts[media.id] }) : null
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
    if (!event || !media) return
    if (!known && !bridge) return
    setError('')
    setBusy({ phase: 'prepare', progress: 0 })
    try {
      const look = CAPTION_STYLES.find((s) => s.id === style) ?? CAPTION_STYLES[0]
      let words
      if (known) {
        words = known.map((w) => ({ text: w.text, start: (w.start - event.start) / FLICKS_PER_SECOND, end: (w.end - event.start) / FLICKS_PER_SECOND }))
      } else {
        const transcript = await transcribeMedia(media, flicksToSeconds(event.offset), flicksToSeconds(sourceLength(event)), model, language, setBusy)
        // Source seconds to event seconds (sped-up or slowed-down events).
        const r = event.rate
        words = alignWords(transcript).map((w) => ({ ...w, start: w.start / r, end: w.end / r }))
      }
      const captions = chunkWords(words, { maxChars: look.maxChars, maxWords: look.maxWords, maxGap: 0.6 })
      if (captions.length === 0) {
        setError('No speech found in this event.')
        return
      }
      A.addCaptionEvents(captions, event.start, style)
      A.closeDialog()
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err))
    } finally {
      setBusy(null)
    }
  }

  let blocker = ''
  if (known) blocker = ''
  else if (!bridge) blocker = 'Captions run in the desktop app (npm run dev), not in the browser preview.'
  else if (status && !status.engine) blocker = 'The speech engine is missing from this build of Boar.'
  else if (!event) blocker = 'Select an event with sound on the timeline.'

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
            <label>Source</label>
            <span>
              {event && media
                ? `${media.name} (${formatTimecode(event.start, rate)}, ${flicksToSeconds(event.length).toFixed(1)} s)`
                : '—'}
            </span>
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

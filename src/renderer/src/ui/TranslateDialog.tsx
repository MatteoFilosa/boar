import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import * as A from '../core/actions'
import { useEditor } from '../core/store'
import { TRANSLATE_LANGUAGES, languageLabel } from '../core/translation'
import { type TranslateProgress, captionLanguage, captionTracks, downloadNeeded, translateCaptionTrack } from '../engine/translate'
import { bridge } from '../platform'
import { BoarProgress, celebrate } from './BoarProgress'

/** 'mul': a language without its own model, translated into English first. */
const OTHER = 'mul'

/**
 * Translate Captions: a caption track becomes a copy in another language on
 * a track of its own, translated on this computer with Opus-MT models.
 */
export function TranslateDialog({ trackId }: { trackId?: string }): React.JSX.Element {
  const project = useEditor((s) => s.project)
  const tracks = useMemo(() => captionTracks(), [project])
  const selected = useEditor((s) => s.project.events.find((e) => s.selection.includes(e.id) && e.text)?.trackId)
  const [track, setTrack] = useState(() => {
    const preferred = trackId ?? selected
    return tracks.find((t) => t.id === preferred)?.id ?? tracks.find((t) => t.name === 'Captions')?.id ?? tracks[0]?.id ?? ''
  })
  const detected = track ? captionLanguage(track) : null
  const [from, setFrom] = useState(detected ?? 'it')
  const to = useEditor((s) => s.options.translateTo)
  const [busy, setBusy] = useState<TranslateProgress | null>(null)
  const [error, setError] = useState('')
  const [downloadMB, setDownloadMB] = useState<number | null>(0)
  const abort = useRef<AbortController | null>(null)

  // A newly chosen track brings its own spoken language.
  useEffect(() => {
    const language = track ? captionLanguage(track) : null
    if (language) setFrom(language)
  }, [track])

  useEffect(() => {
    let live = true
    void downloadNeeded(from, to).then((mb) => live && setDownloadMB(mb))
    return () => {
      live = false
    }
  }, [from, to])

  useEffect(() => () => abort.current?.abort(), [])

  const fromOptions = [...TRANSLATE_LANGUAGES, { code: OTHER, label: 'Another language' }]
  if (detected && !fromOptions.some((l) => l.code === detected)) fromOptions.unshift({ code: detected, label: detected.toUpperCase() })
  const blocker = !bridge
    ? 'Translation runs in the desktop app.'
    : tracks.length === 0
      ? 'There are no captions to translate: make them with Generate Captions first.'
      : from === to
        ? 'Pick a language other than the one spoken.'
        : downloadMB === null
          ? `There is no model to translate ${languageLabel(from)} into ${languageLabel(to)}.`
          : ''

  const translate = async (): Promise<void> => {
    setError('')
    const controller = new AbortController()
    abort.current = controller
    setBusy({ label: 'Starting', progress: 0 })
    try {
      const count = await translateCaptionTrack(track, from, to, setBusy, controller.signal)
      celebrate(`${count} captions in ${languageLabel(to)}`)
      A.closeDialog()
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err))
      setBusy(null)
    } finally {
      abort.current = null
    }
  }

  const close = (): void => {
    if (busy) abort.current?.abort()
    A.closeDialog()
  }

  const name = tracks.find((t) => t.id === track)?.name ?? 'Captions'
  return (
    <div className="modal-backdrop">
      <div className="modal" style={{ width: 560 }} role="dialog" aria-label="Translate captions">
        <div className="modal-title">
          <span>Translate Captions (local)</span>
          <button className="tool-btn" title="Close (Esc)" onClick={close}>
            <X size={14} />
          </button>
        </div>
        <div className="modal-body">
          <p className="dim">
            The captions are translated on this computer and go on a new track, "{name.replace(/ \([A-Z]{2,3}\)$/, '')} (
            {to.toUpperCase()})", with the same style and timing. The other caption tracks are muted: unmute a track to
            switch language. An AI agent connected to Boar (Options › AI Agents) can translate them too, often better.
          </p>
          <div className="form">
            <label>Captions</label>
            <select className="select" value={track} disabled={!!busy} onChange={(e) => setTrack(e.target.value)}>
              {tracks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} · {t.count} caption{t.count === 1 ? '' : 's'}
                </option>
              ))}
            </select>
            <label>Spoken in</label>
            <select className="select" value={from} disabled={!!busy} onChange={(e) => setFrom(e.target.value)}>
              {fromOptions.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                  {l.code === detected ? ' (heard by Whisper)' : ''}
                </option>
              ))}
            </select>
            <label>Translate into</label>
            <select className="select" value={to} disabled={!!busy} onChange={(e) => A.setOption('translateTo', e.target.value)}>
              {TRANSLATE_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>
          {!!downloadMB && !busy && (
            <p className="dim">The first time, {downloadMB} MB of translation models are downloaded (Opus-MT, then kept for later).</p>
          )}
          {busy && (
            <BoarProgress value={busy.progress}>
              {busy.label}… {Math.round(busy.progress * 100)}%
            </BoarProgress>
          )}
          {(blocker || error) && <div className="render-result error">{error || blocker}</div>}
          <div className="modal-actions">
            <button className="btn" onClick={close}>
              {busy ? 'Cancel' : 'Close'}
            </button>
            <button className="btn primary" disabled={!!busy || !!blocker} onClick={() => void translate()}>
              Translate
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { FolderOpen, X } from 'lucide-react'
import * as A from '../core/actions'
import { useEditor } from '../core/store'
import { formatTimecode, rateLabel } from '../core/time'
import { projectEnd } from '../core/timeline'
import {
  CODEC_LABELS,
  ExportCancelled,
  type ExportCodec,
  type ExportProgress,
  type ExportQuality,
  exportProject,
  supportedCodecs
} from '../engine/export'
import { chooseDestination } from '../engine/targets'
import { LOUDNESS_TARGETS, type LoudnessResult, formatLufs } from '../engine/loudness'

type RenderState =
  | { kind: 'idle' }
  | { kind: 'running'; progress: ExportProgress; started: number }
  | { kind: 'done'; label: string; seconds: number; reveal?: () => void; loudness: LoudnessResult | null }
  | { kind: 'error'; message: string }

const PHASES: Record<ExportProgress['phase'], string> = {
  audio: 'Mixing audio',
  video: 'Rendering video',
  finalizing: 'Finalizing file'
}

export function RenderDialog(): React.JSX.Element {
  const project = useEditor((s) => s.project)
  const options = useEditor((s) => s.options)
  const selection = useEditor((s) => s.timeSelection)
  const [selectionOnly, setSelectionOnly] = useState(selection !== null)
  const { width, height, frameRate } = project.settings
  const range = selectionOnly && selection ? selection : { start: 0, end: projectEnd(project) }
  const end = range.end - range.start
  const [codecs, setCodecs] = useState<ExportCodec[] | null>(null)
  const [codec, setCodec] = useState<ExportCodec>('avc')
  const [quality, setQuality] = useState<ExportQuality>('high')
  const [includeAudio, setIncludeAudio] = useState(true)
  const [name, setName] = useState('Boar render.mp4')
  const [state, setState] = useState<RenderState>({ kind: 'idle' })
  const cancelled = useRef(false)

  useEffect(() => {
    let alive = true
    void supportedCodecs(width, height).then((list) => {
      if (!alive) return
      setCodecs(list)
      if (list.length && !list.includes('avc')) setCodec(list[0])
    })
    return () => {
      alive = false
    }
  }, [width, height])

  const running = state.kind === 'running'

  const start = async (): Promise<void> => {
    const fileName = name.toLowerCase().endsWith('.mp4') ? name : `${name}.mp4`
    const destination = await chooseDestination(fileName)
    if (!destination) return
    cancelled.current = false
    useEditor.setState({ playing: false, exporting: true })
    const started = performance.now()
    setState({ kind: 'running', progress: { phase: 'audio', progress: 0 }, started })
    try {
      const result = await exportProject(
        project,
        destination.target,
        {
          codec,
          quality,
          includeAudio,
          masterDb: options.masterDb,
          autoCrossfade: options.autoCrossfade,
          loudness: options.renderLoudness
        },
        (progress) => setState((s) => (s.kind === 'running' ? { ...s, progress } : s)),
        () => cancelled.current,
        range
      )
      await destination.finish()
      const seconds = (performance.now() - started) / 1000
      setState({ kind: 'done', label: destination.label, seconds, reveal: destination.reveal, loudness: result.loudness })
      A.setStatus(`Rendered ${destination.label} in ${seconds.toFixed(1)} s`)
    } catch (err) {
      await destination.discard().catch(() => undefined)
      if (err instanceof ExportCancelled) {
        setState({ kind: 'idle' })
        A.setStatus('Render cancelled')
      } else {
        const message = err instanceof Error ? err.message : String(err)
        setState({ kind: 'error', message })
        A.setStatus(`Render failed: ${message}`)
      }
    } finally {
      useEditor.setState({ exporting: false })
    }
  }

  const percent = running ? Math.round(state.progress.progress * 100) : 0
  const elapsed = running ? (performance.now() - state.started) / 1000 : 0
  const eta =
    running && state.progress.phase === 'video' && state.progress.progress > 0.02
      ? elapsed / state.progress.progress - elapsed
      : null

  return (
    <div className="modal-backdrop">
      <div className="modal" style={{ width: 520 }} role="dialog" aria-label="Render As">
        <div className="modal-title">
          <span>Render As</span>
          <button className="tool-btn" title="Close (Esc)" disabled={running} onClick={A.closeDialog}>
            <X size={14} />
          </button>
        </div>
        <div className="modal-body">
          <div className="form">
            <label>File name</label>
            <input className="input" value={name} disabled={running} onChange={(e) => setName(e.target.value)} />
            <label>Format</label>
            <select
              className="select"
              value={codec}
              disabled={running || !codecs}
              onChange={(e) => setCodec(e.target.value as ExportCodec)}
            >
              {(['avc', 'hevc', 'av1', 'vp9'] as const).map((c) => (
                <option key={c} value={c} disabled={codecs ? !codecs.includes(c) : true}>
                  MP4 · {CODEC_LABELS[c]}
                  {codecs && !codecs.includes(c) ? ' — not available' : ''}
                </option>
              ))}
            </select>
            <label>Quality</label>
            <select
              className="select"
              value={quality}
              disabled={running}
              onChange={(e) => setQuality(e.target.value as ExportQuality)}
            >
              <option value="medium">Medium (smaller file)</option>
              <option value="high">High</option>
              <option value="veryHigh">Very high (larger file)</option>
            </select>
            <label>Audio</label>
            <label className="te-check">
              <input
                type="checkbox"
                checked={includeAudio}
                disabled={running}
                onChange={(e) => setIncludeAudio(e.target.checked)}
              />
              Include audio (AAC)
            </label>
            <label>Loudness</label>
            <select
              className="select"
              value={options.renderLoudness === null ? 'off' : String(options.renderLoudness)}
              disabled={running || !includeAudio}
              title="Integrated loudness of the rendered audio, with true peaks limited to −1 dBTP"
              onChange={(e) => A.setOption('renderLoudness', e.target.value === 'off' ? null : Number(e.target.value))}
            >
              {LOUDNESS_TARGETS.map((t) => (
                <option key={t.lufs} value={String(t.lufs)}>
                  Normalize to {t.label}
                </option>
              ))}
              <option value="off">Off (keep the mix level)</option>
            </select>
            <label>Range</label>
            <label className="te-check" title={selection ? '' : 'Drag on the ruler to make a time selection'}>
              <input
                type="checkbox"
                checked={selectionOnly && selection !== null}
                disabled={running || !selection}
                onChange={(e) => setSelectionOnly(e.target.checked)}
              />
              Render loop region only
              {selection ? ` (${formatTimecode(selection.start, frameRate)} – ${formatTimecode(selection.end, frameRate)})` : ''}
            </label>
            <label>Output</label>
            <span className="dim">
              {width}x{height}, {rateLabel(frameRate)} fps, length {formatTimecode(end, frameRate)}
            </span>
          </div>

          {running && (
            <div className="render-progress">
              <div className="render-bar">
                <div style={{ width: `${percent}%` }} />
              </div>
              <div className="dim">
                {PHASES[state.progress.phase]} {percent}%
                {state.progress.frames ? ` · frame ${state.progress.frame} / ${state.progress.frames}` : ''}
                {eta !== null ? ` · about ${Math.ceil(eta)} s left` : ''}
              </div>
            </div>
          )}
          {state.kind === 'done' && (
            <div className="render-result ok">
              Rendered in {state.seconds.toFixed(1)} s: <b>{state.label}</b>
              {state.loudness && (
                <div className="dim">
                  Loudness {formatLufs(state.loudness.before)} → {formatLufs(state.loudness.after)}, peak{' '}
                  {state.loudness.peak.toFixed(1)} dBTP
                </div>
              )}
              {state.reveal && (
                <button className="btn small" onClick={state.reveal}>
                  <FolderOpen size={13} /> Show in folder
                </button>
              )}
            </div>
          )}
          {state.kind === 'error' && <div className="render-result error">Render failed: {state.message}</div>}

          <div className="modal-actions">
            {running ? (
              <button className="btn" onClick={() => (cancelled.current = true)}>
                Cancel render
              </button>
            ) : (
              <>
                <button className="btn" onClick={A.closeDialog}>
                  Close
                </button>
                <button className="btn primary" disabled={end <= 0 || !codecs?.length} onClick={() => void start()}>
                  Render...
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { FolderOpen, X } from 'lucide-react'
import * as A from '../core/actions'
import { useEditor } from '../core/store'
import { formatTimecode, rateLabel } from '../core/time'
import { projectEnd } from '../core/timeline'
import {
  CODEC_LABELS,
  type EncoderSupport,
  ExportCancelled,
  type ExportAudioCodec,
  type ExportCodec,
  type ExportProgress,
  type ExportQuality,
  audioSupport,
  encoderSupport,
  exportProject
} from '../engine/export'
import { chooseDestination } from '../engine/targets'
import { LOUDNESS_TARGETS, type LoudnessResult, formatLufs } from '../engine/loudness'
import { BoarProgress } from './BoarProgress'

type RenderState =
  | { kind: 'idle' }
  | { kind: 'running'; progress: ExportProgress; started: number; withAudio: boolean }
  | { kind: 'done'; label: string; seconds: number; reveal?: () => void; loudness: LoudnessResult | null }
  | { kind: 'error'; message: string }

const PHASES: Record<ExportProgress['phase'], string> = {
  audio: 'Mixing audio',
  video: 'Rendering video',
  finalizing: 'Finalizing file'
}

/** The graphics card's name and its video encoder technology, from the WebGL renderer string. */
function graphicsCard(): { name: string; encoder: string } | null {
  try {
    const gl = document.createElement('canvas').getContext('webgl')
    const info = gl?.getExtension('WEBGL_debug_renderer_info')
    const renderer = gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)).replace(/\((R|TM)\)/g, '') : ''
    if (!renderer) return null
    // e.g. "ANGLE (Intel, Intel Arc A750 Graphics (0x000056A1) Direct3D11 vs_5_0 ps_5_0, D3D11)"
    const angle = /^ANGLE \(([^,]+), (.+?)(?: \(0x[0-9a-f]+\))?(?: Direct3D| OpenGL| Vulkan|, |\)$)/i.exec(renderer)
    const name = (angle ? angle[2] : renderer).replace(/^ANGLE Metal Renderer: /, '').replace(/\s+/g, ' ').trim()
    const vendor = `${angle?.[1] ?? ''} ${name}`.toLowerCase()
    const encoder = /nvidia/.test(vendor)
      ? 'NVENC'
      : /intel/.test(vendor)
        ? 'Quick Sync'
        : /amd|ati|radeon/.test(vendor)
          ? 'AMF'
          : /apple/.test(vendor)
            ? 'VideoToolbox'
            : 'hardware encoder'
    return { name, encoder }
  } catch {
    return null
  }
}

/** The phases as one run: mixing audio (when there is audio) is the first tenth. */
function overallProgress({ phase, progress }: ExportProgress, withAudio: boolean): number {
  if (phase === 'audio') return progress * 0.1
  if (phase === 'finalizing') return 0.99
  return withAudio ? 0.1 + progress * 0.89 : progress * 0.99
}

export function RenderDialog(): React.JSX.Element {
  const project = useEditor((s) => s.project)
  const options = useEditor((s) => s.options)
  const selection = useEditor((s) => s.timeSelection)
  const [selectionOnly, setSelectionOnly] = useState(selection !== null)
  const { width, height, frameRate } = project.settings
  const range = selectionOnly && selection ? selection : { start: 0, end: projectEnd(project) }
  const end = range.end - range.start
  const [support, setSupport] = useState<Record<ExportCodec, EncoderSupport> | null>(null)
  const [audioCodecs, setAudioCodecs] = useState<Record<ExportAudioCodec, boolean> | null>(null)
  const [card] = useState(graphicsCard)
  const [quality, setQuality] = useState<ExportQuality>('high')
  const [name, setName] = useState('Boar render.mp4')
  const [state, setState] = useState<RenderState>({ kind: 'idle' })
  const cancelled = useRef(false)
  const codec = options.renderCodec
  const encoder = options.renderEncoder
  const audio = options.renderAudio
  const available = (c: ExportCodec): boolean => !!support && (support[c].gpu || support[c].cpu)

  useEffect(() => {
    let alive = true
    void Promise.all([encoderSupport(width, height), audioSupport()]).then(([video, sound]) => {
      if (!alive) return
      setSupport(video)
      setAudioCodecs(sound)
      // A remembered choice this machine cannot do falls back to what it can.
      const s = useEditor.getState().options
      const codecOk = video[s.renderCodec].gpu || video[s.renderCodec].cpu
      const next = codecOk ? s.renderCodec : ((['avc', 'hevc', 'av1', 'vp9'] as const).find((c) => video[c].gpu || video[c].cpu) ?? 'avc')
      if (next !== s.renderCodec) A.setOption('renderCodec', next)
      if ((s.renderEncoder === 'gpu' && !video[next].gpu) || (s.renderEncoder === 'cpu' && !video[next].cpu)) A.setOption('renderEncoder', 'auto')
      if (s.renderAudio !== 'none' && !sound[s.renderAudio]) A.setOption('renderAudio', sound.aac ? 'aac' : sound.opus ? 'opus' : 'none')
    })
    return () => {
      alive = false
    }
  }, [width, height])

  const chooseCodec = (c: ExportCodec): void => {
    A.setOption('renderCodec', c)
    if (support && ((encoder === 'gpu' && !support[c].gpu) || (encoder === 'cpu' && !support[c].cpu))) A.setOption('renderEncoder', 'auto')
  }
  /** What actually encodes: the graphics card when chosen or (automatic) when it can. */
  const usesGpu = !!support && (encoder === 'gpu' || (encoder === 'auto' && support[codec].gpu))

  const running = state.kind === 'running'

  const start = async (): Promise<void> => {
    const fileName = name.toLowerCase().endsWith('.mp4') ? name : `${name}.mp4`
    const destination = await chooseDestination(fileName)
    if (!destination) return
    cancelled.current = false
    useEditor.setState({ playing: false, exporting: true })
    const started = performance.now()
    setState({ kind: 'running', progress: { phase: 'audio', progress: 0 }, started, withAudio: false })
    try {
      const result = await exportProject(
        project,
        destination.target,
        {
          codec,
          quality,
          encoder,
          includeAudio: audio !== 'none',
          audioCodec: audio === 'opus' ? 'opus' : 'aac',
          masterDb: options.masterDb,
          autoCrossfade: options.autoCrossfade,
          loudness: options.renderLoudness
        },
        (progress) =>
          setState((s) =>
            s.kind === 'running' ? { ...s, progress, withAudio: s.withAudio || progress.phase === 'audio' } : s
          ),
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

  const overall = running ? overallProgress(state.progress, state.withAudio) : 0
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
              disabled={running || !support}
              onChange={(e) => chooseCodec(e.target.value as ExportCodec)}
            >
              {(['avc', 'hevc', 'av1', 'vp9'] as const).map((c) => (
                <option key={c} value={c} disabled={!available(c)}>
                  MP4 · {CODEC_LABELS[c]}
                  {support ? (support[c].gpu ? ' · graphics card' : support[c].cpu ? ' · processor only (slower)' : ' · not available') : ''}
                </option>
              ))}
            </select>
            <label>Encoder</label>
            <select
              className="select"
              value={encoder}
              disabled={running || !support}
              title="The graphics card encodes much faster; the processor works everywhere but is slower"
              onChange={(e) => A.setOption('renderEncoder', e.target.value as 'auto' | 'gpu' | 'cpu')}
            >
              <option value="auto">Automatic (graphics card when it can)</option>
              <option value="gpu" disabled={!support?.[codec].gpu}>
                Graphics card{card ? `: ${card.name} (${card.encoder})` : ''}
                {support && !support[codec].gpu ? ' · not for this format' : ''}
              </option>
              <option value="cpu" disabled={!support?.[codec].cpu}>
                Processor (software, slower){support && !support[codec].cpu ? ' · not for this format' : ''}
              </option>
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
            <select
              className="select"
              value={audio}
              disabled={running}
              onChange={(e) => A.setOption('renderAudio', e.target.value as 'aac' | 'opus' | 'none')}
            >
              <option value="aac" disabled={audioCodecs ? !audioCodecs.aac : false}>
                AAC (most compatible){audioCodecs && !audioCodecs.aac ? ' · not available here' : ''}
              </option>
              <option value="opus" disabled={audioCodecs ? !audioCodecs.opus : false}>
                Opus (better at small sizes; some players skip it in MP4)
              </option>
              <option value="none">No audio</option>
            </select>
            <label>Loudness</label>
            <select
              className="select"
              value={options.renderLoudness === null ? 'off' : String(options.renderLoudness)}
              disabled={running || audio === 'none'}
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
              {support && (usesGpu ? ' · encoded by the graphics card' : ' · encoded by the processor')}
            </span>
          </div>

          {/* One bar for the run and its end, so the boar runs the last stretch to the flag. */}
          {(state.kind === 'running' || state.kind === 'done') && (
            <BoarProgress value={state.kind === 'running' ? overall : 1} done={state.kind === 'done'}>
              {state.kind === 'running' && (
                <>
                  {PHASES[state.progress.phase]} · {Math.round(overall * 100)}%
                  {state.progress.frames ? ` · frame ${state.progress.frame} / ${state.progress.frames}` : ''}
                  {eta !== null ? ` · about ${Math.ceil(eta)} s left` : ''}
                </>
              )}
            </BoarProgress>
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
                <button className="btn primary" disabled={end <= 0 || !support || !available(codec)} onClick={() => void start()}>
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

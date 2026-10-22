import { useEffect, useRef, useState } from 'react'
import { FileText, FolderOpen, X } from 'lucide-react'
import * as A from '../core/actions'
import { useEditor } from '../core/store'
import { flicksToSeconds, formatTimecode, fps, rateLabel } from '../core/time'
import { mixedTracks, projectEnd } from '../core/timeline'
import {
  CODEC_LABELS,
  type EncoderSupport,
  ExportCancelled,
  type ExportAudioCodec,
  type ExportCodec,
  type ExportProgress,
  type ExportQuality,
  audioSupport,
  encoderSupport
} from '../engine/export'
import { chooseDestination, withExtension } from '../engine/targets'
import { LOUDNESS_TARGETS, type LoudnessResult, formatLufs } from '../engine/loudness'
import { SOUND_FORMATS, SOUND_FORMAT_INFO, type SoundFormat, hasSound, soundQuality } from '../engine/exportSound'
import { GIF_QUALITIES, GIF_RATES, GIF_WIDTHS, gifFormat } from '../engine/gif'
import { type RenderKind, renderFileType, renderProject } from '../engine/render'
import { BoarProgress } from './BoarProgress'

/** GIFs longer than this get a hint: they grow large fast. */
const LONG_GIF_SECONDS = 15

type RenderState =
  | { kind: 'idle' }
  | { kind: 'running'; progress: ExportProgress; started: number; withAudio: boolean; render: RenderKind; note: string | null }
  | { kind: 'done'; label: string; seconds: number; reveal?: () => void; loudness: LoudnessResult | null; note: string | null; movedToProcessor: boolean }
  | { kind: 'error'; message: string }

const PHASES: Record<ExportProgress['phase'], string> = {
  audio: 'Mixing audio',
  video: 'Rendering video',
  finalizing: 'Finalizing file'
}

const KIND_PHASES: Record<RenderKind, Partial<Record<ExportProgress['phase'], string>>> = {
  video: {},
  gif: { video: 'Rendering frames' },
  sound: { audio: 'Mixing and encoding sound' }
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

/** The phases as one run: mixing audio (when there is audio) is the first tenth of a video render. */
function overallProgress({ phase, progress }: ExportProgress, withAudio: boolean, kind: RenderKind): number {
  if (kind === 'sound') return phase === 'finalizing' ? 0.99 : progress * 0.99
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
  const [state, setState] = useState<RenderState>({ kind: 'idle' })
  const cancelled = useRef(false)
  const kind = options.renderKind
  const codec = options.renderCodec
  const encoder = options.renderEncoder
  const audio = options.renderAudio
  const sound = options.renderSound
  const fileType = renderFileType(options)
  const [name, setName] = useState(() => withExtension('Boar render', fileType.extension))
  /** Sound only: one audio track, or '' for every track that is heard. */
  const [soundTrack, setSoundTrack] = useState('')
  const [gifLoop, setGifLoop] = useState(true)
  const audioTracks = project.tracks.filter((t) => t.kind === 'audio')
  const heard = new Set(mixedTracks(project).map((t) => t.id))
  const chosenTracks = soundTrack && audioTracks.some((t) => t.id === soundTrack) ? [soundTrack] : undefined
  const gif = gifFormat(project, { width: options.gifWidth, fps: options.gifFps })
  const gifWidths = [...new Set([...GIF_WIDTHS.filter((w) => w < width), width])]
  const soundInRange = kind !== 'sound' || hasSound(project, chosenTracks, range)
  const gifRates = [...new Set([...GIF_RATES.filter((r) => r <= fps(frameRate)), gif.fps])].toSorted((a, b) => a - b)
  const available = (c: ExportCodec): boolean => !!support && (support[c].gpu || support[c].cpu)
  const soundAvailable = (f: SoundFormat): boolean =>
    f === 'm4a' ? !audioCodecs || audioCodecs.aac : f === 'ogg' ? !audioCodecs || audioCodecs.opus : true

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
      if ((s.renderSound === 'm4a' && !sound.aac) || (s.renderSound === 'ogg' && !sound.opus)) A.setOption('renderSound', 'mp3')
    })
    return () => {
      alive = false
    }
  }, [width, height])

  const chooseCodec = (c: ExportCodec): void => {
    A.setOption('renderCodec', c)
    if (support && ((encoder === 'gpu' && !support[c].gpu) || (encoder === 'cpu' && !support[c].cpu))) A.setOption('renderEncoder', 'auto')
  }
  /** Format menu values: "video:avc", "gif", "sound:mp3". */
  const chooseFormat = (value: string): void => {
    const [k, sub] = value.split(':') as [RenderKind, string | undefined]
    A.setOption('renderKind', k)
    if (k === 'video') chooseCodec(sub as ExportCodec)
    if (k === 'sound') A.setOption('renderSound', sub as SoundFormat)
    const extension = k === 'gif' ? 'gif' : k === 'sound' ? SOUND_FORMAT_INFO[sub as SoundFormat].extension : 'mp4'
    setName((n) => withExtension(n, extension))
  }
  const formatValue = kind === 'video' ? `video:${codec}` : kind === 'sound' ? `sound:${sound}` : 'gif'
  /** What actually encodes: the graphics card when chosen or (automatic) when it can. */
  const usesGpu = !!support && (encoder === 'gpu' || (encoder === 'auto' && support[codec].gpu))

  const running = state.kind === 'running'

  const start = async (): Promise<void> => {
    const fileName = withExtension(name, fileType.extension)
    const destination = await chooseDestination(fileName, fileType)
    if (!destination) return
    cancelled.current = false
    useEditor.setState({ playing: false, exporting: true })
    const started = performance.now()
    const render = kind
    setState({ kind: 'running', progress: { phase: render === 'gif' ? 'video' : 'audio', progress: 0 }, started, withAudio: false, render, note: null })
    const onProgress = (progress: ExportProgress): void =>
      setState((s) =>
        s.kind === 'running' ? { ...s, progress, withAudio: s.withAudio || progress.phase === 'audio', note: progress.note ?? s.note } : s
      )
    const isCancelled = (): boolean => cancelled.current
    try {
      const job = { quality, range, tracks: chosenTracks, once: !gifLoop }
      const result = await renderProject(project, destination, options, job, onProgress, isCancelled)
      await destination.finish()
      const seconds = (performance.now() - started) / 1000
      // The graphics card's encoder stalled: the next renders go straight to the processor (the Encoder menu shows it).
      if (result.movedToProcessor) A.setOption('renderEncoder', 'cpu')
      setState({ kind: 'done', label: destination.label, seconds, reveal: destination.reveal, loudness: result.loudness, note: result.note, movedToProcessor: result.movedToProcessor })
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

  const overall = running ? overallProgress(state.progress, state.withAudio, state.render) : 0
  const elapsed = running ? (performance.now() - state.started) / 1000 : 0
  const eta =
    running && state.render !== 'sound' && state.progress.phase === 'video' && state.progress.progress > 0.02
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
              value={formatValue}
              disabled={running || !support}
              onChange={(e) => chooseFormat(e.target.value)}
            >
              <optgroup label="Video">
                {(['avc', 'hevc', 'av1', 'vp9'] as const).map((c) => (
                  <option key={c} value={`video:${c}`} disabled={!available(c)}>
                    MP4 · {CODEC_LABELS[c]}
                    {support ? (support[c].gpu ? ' · graphics card' : support[c].cpu ? ' · processor only (slower)' : ' · not available') : ''}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Animated picture">
                <option value="gif">GIF (no sound, loops)</option>
              </optgroup>
              <optgroup label="Sound only">
                {SOUND_FORMATS.map((f) => (
                  <option key={f} value={`sound:${f}`} disabled={!soundAvailable(f)}>
                    {SOUND_FORMAT_INFO[f].label}
                    {soundAvailable(f) ? '' : ' · not available here'}
                  </option>
                ))}
              </optgroup>
            </select>
            {kind === 'video' && (
              <>
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
              </>
            )}
            {kind === 'sound' && (
              <>
                <label>Tracks</label>
                <select
                  className="select"
                  value={chosenTracks ? soundTrack : ''}
                  disabled={running}
                  title="Render the whole mix, or the sound of one audio track alone (whatever its mute and solo)"
                  onChange={(e) => setSoundTrack(e.target.value)}
                >
                  <option value="">All the tracks you hear (mute and solo as set)</option>
                  {audioTracks.map((t) => (
                    <option key={t.id} value={t.id}>
                      Only track {project.tracks.indexOf(t) + 1}: {t.name || 'Audio'}
                      {heard.has(t.id) ? '' : ' (not heard now)'}
                    </option>
                  ))}
                </select>
              </>
            )}
            {kind === 'gif' && (
              <>
                <label>Size</label>
                <select
                  className="select"
                  value={String(gif.width)}
                  disabled={running}
                  onChange={(e) => A.setOption('gifWidth', Number(e.target.value))}
                >
                  {gifWidths.map((w) => (
                    <option key={w} value={String(w)}>
                      {w} x {gifFormat(project, { width: w, fps: options.gifFps }).height}
                      {w === width ? ' (project size)' : ''}
                    </option>
                  ))}
                </select>
                <label>Frame rate</label>
                <select
                  className="select"
                  value={String(gif.fps)}
                  disabled={running}
                  onChange={(e) => A.setOption('gifFps', Number(e.target.value))}
                >
                  {gifRates.map((r) => (
                    <option key={r} value={String(r)}>
                      {r} fps
                    </option>
                  ))}
                </select>
              </>
            )}
            <label>Quality</label>
            <select
              className="select"
              value={kind === 'sound' ? soundQuality(sound, quality) : quality}
              disabled={running}
              onChange={(e) => setQuality(e.target.value as ExportQuality)}
            >
              {kind === 'gif'
                ? (['medium', 'high', 'veryHigh'] as const).map((q) => (
                    <option key={q} value={q}>
                      {GIF_QUALITIES[q].label}
                    </option>
                  ))
                : kind === 'sound'
                  ? (['medium', 'high', 'veryHigh'] as const)
                      .filter((q) => SOUND_FORMAT_INFO[sound].qualities[q])
                      .map((q) => (
                        <option key={q} value={q}>
                          {SOUND_FORMAT_INFO[sound].qualities[q]}
                        </option>
                      ))
                  : [
                      <option key="medium" value="medium">
                        Medium (smaller file)
                      </option>,
                      <option key="high" value="high">
                        High
                      </option>,
                      <option key="veryHigh" value="veryHigh">
                        Very high (larger file)
                      </option>
                    ]}
            </select>
            {kind === 'video' && (
              <>
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
              </>
            )}
            {kind !== 'gif' && (
              <>
                <label>Loudness</label>
                <select
                  className="select"
                  value={options.renderLoudness === null ? 'off' : String(options.renderLoudness)}
                  disabled={running || (kind === 'video' && audio === 'none')}
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
              </>
            )}
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
            {kind === 'gif' && (
              <>
                <label>Playback</label>
                <label className="te-check">
                  <input type="checkbox" checked={gifLoop} disabled={running} onChange={(e) => setGifLoop(e.target.checked)} />
                  Loop forever
                </label>
              </>
            )}
            <label>Output</label>
            <span className="dim">
              {kind === 'video' && (
                <>
                  {width}x{height}, {rateLabel(frameRate)} fps, length {formatTimecode(end, frameRate)}
                  {support && (usesGpu ? ' · encoded by the graphics card' : ' · encoded by the processor')}
                </>
              )}
              {kind === 'gif' && (
                <>
                  {gif.width}x{gif.height}, {gif.fps} fps, no sound, length {formatTimecode(end, frameRate)}
                  {flicksToSeconds(end) > LONG_GIF_SECONDS && ' · long GIFs get large: a time selection makes a short loop'}
                </>
              )}
              {kind === 'sound' && (
                <>
                  Sound only, {project.settings.sampleRate / 1000} kHz stereo, length {formatTimecode(end, frameRate)}
                  {!soundInRange && ' · there is no sound on the chosen tracks here'}
                </>
              )}
            </span>
          </div>

          {/* One bar for the run and its end, so the boar runs the last stretch to the flag. */}
          {(state.kind === 'running' || state.kind === 'done') && (
            <BoarProgress value={state.kind === 'running' ? overall : 1} done={state.kind === 'done'}>
              {state.kind === 'running' && (
                <>
                  {KIND_PHASES[state.render][state.progress.phase] ?? PHASES[state.progress.phase]} · {Math.round(overall * 100)}%
                  {state.progress.frames ? ` · frame ${state.progress.frame} / ${state.progress.frames}` : ''}
                  {eta !== null ? ` · about ${Math.ceil(eta)} s left` : ''}
                </>
              )}
            </BoarProgress>
          )}
          {state.kind === 'running' && state.note && <div className="render-result note">{state.note}</div>}
          {state.kind === 'done' && (
            <div className="render-result ok">
              Rendered in {state.seconds.toFixed(1)} s: <b>{state.label}</b>
              {state.loudness && (
                <div className="dim">
                  Loudness {formatLufs(state.loudness.before)} → {formatLufs(state.loudness.after)}, peak{' '}
                  {state.loudness.peak.toFixed(1)} dBTP
                </div>
              )}
              {state.note && (
                <div className="dim">
                  {state.note}
                  {state.movedToProcessor ? ' Encoder is now set to Processor.' : ''}
                </div>
              )}
              {state.reveal && (
                <button className="btn small" onClick={state.reveal}>
                  <FolderOpen size={13} /> Show in folder
                </button>
              )}
            </div>
          )}
          {state.kind === 'error' && (
            <div className="render-result error">
              Render failed: {state.message}
              <button className="btn small" title="What Boar wrote down about the render, to copy into a problem report" onClick={() => A.openDialog({ kind: 'log' })}>
                <FileText size={13} /> Problem Log
              </button>
            </div>
          )}

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
                <button
                  className="btn primary"
                  disabled={
                    end <= 0 ||
                    !support ||
                    (kind === 'video' && !available(codec)) ||
                    (kind === 'sound' && (!soundAvailable(sound) || !soundInRange))
                  }
                  onClick={() => void start()}
                >
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

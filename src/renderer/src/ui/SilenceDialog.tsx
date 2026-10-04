import { useEffect, useMemo, useRef, useState } from 'react'
import { Scissors, Wand } from 'lucide-react'
import * as A from '../core/actions'
import { mediaById, useEditor } from '../core/store'
import { FLICKS_PER_SECOND, formatDuration, secondsToFlicks } from '../core/time'
import type { TimelineEvent } from '../core/types'
import { HOP, type Interval, autoThreshold, eventLevels, findSilences, mediaLevels } from '../engine/analysis'
import { BoarProgress } from './BoarProgress'
import { FloatingWindow } from './FloatingWindow'
import { themeColor } from './themes'

/** The audio events that decide where the pauses are: selected audio, or the sound of selected videos. */
function detectorEvents(events: TimelineEvent[], selection: string[]): TimelineEvent[] {
  const selected = events.filter((e) => selection.includes(e.id))
  const out = new Map<string, TimelineEvent>()
  for (const e of selected) {
    const audio = e.kind === 'audio' ? e : e.groupId ? events.find((o) => o.groupId === e.groupId && o.kind === 'audio') : undefined
    if (audio && mediaById(audio.mediaId)?.hasAudio) out.set(audio.id, audio)
  }
  return [...out.values()].sort((a, b) => a.start - b.start)
}

interface Analysis {
  event: TimelineEvent
  levels: Float32Array
}

function LevelGraph({ analysis, threshold, silences }: { analysis: Analysis; threshold: number; silences: Interval[] }): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = themeColor('sunken')
    ctx.fillRect(0, 0, w, h)
    const { levels } = analysis
    const total = levels.length * HOP
    const y = (db: number): number => h - ((Math.max(-70, Math.min(0, db)) + 70) / 70) * h
    ctx.fillStyle = 'rgba(255, 97, 97, 0.28)'
    for (const s of silences) ctx.fillRect((s.start / total) * w, 0, ((s.end - s.start) / total) * w, h)
    ctx.fillStyle = '#5fb36f'
    const per = Math.max(1, Math.floor(levels.length / w))
    for (let x = 0; x < w; x++) {
      let max = -120
      const from = Math.floor((x / w) * levels.length)
      for (let i = from; i < Math.min(levels.length, from + per); i++) if (levels[i] > max) max = levels[i]
      const top = y(max)
      ctx.fillRect(x, top, 1, h - top)
    }
    ctx.strokeStyle = '#ffcf3f'
    ctx.setLineDash([4, 3])
    ctx.beginPath()
    ctx.moveTo(0, y(threshold) + 0.5)
    ctx.lineTo(w, y(threshold) + 0.5)
    ctx.stroke()
  }, [analysis, threshold, silences])
  return <canvas ref={ref} className="silence-graph" />
}

/** Tools › Remove Silences: jump cuts on talking clips. */
export function SilenceDialog(): React.JSX.Element {
  const events = useEditor((s) => s.project.events)
  const selection = useEditor((s) => s.selection)
  const detectors = useMemo(() => detectorEvents(events, selection), [])
  const [analyses, setAnalyses] = useState<Analysis[] | null>(null)
  const [error, setError] = useState('')
  const [threshold, setThreshold] = useState(-40)
  const [minSilence, setMinSilence] = useState(0.4)
  const [padding, setPadding] = useState(0.1)
  const [mode, setMode] = useState<'remove' | 'split'>('remove')

  useEffect(() => {
    if (detectors.length === 0) return
    let cancelled = false
    Promise.all(
      detectors.map(async (event) => {
        const media = mediaById(event.mediaId)
        if (!media) throw new Error('Media missing')
        const levels = eventLevels(await mediaLevels(media), event.offset / FLICKS_PER_SECOND, event.length / FLICKS_PER_SECOND, event.rate)
        return { event, levels }
      })
    ).then(
      (list) => {
        if (cancelled) return
        setAnalyses(list)
        const all = new Float32Array(list.reduce((n, a) => n + a.levels.length, 0))
        let at = 0
        for (const a of list) {
          all.set(a.levels, at)
          at += a.levels.length
        }
        setThreshold(autoThreshold(all))
      },
      (err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err))
    )
    return () => {
      cancelled = true
    }
  }, [detectors])

  const silences = useMemo(
    () => (analyses ?? []).map((a) => findSilences(a.levels, threshold, minSilence, padding)),
    [analyses, threshold, minSilence, padding]
  )
  const ranges = useMemo(
    () =>
      (analyses ?? []).flatMap((a, i) =>
        silences[i].map((s) => ({ start: a.event.start + secondsToFlicks(s.start), end: a.event.start + secondsToFlicks(s.end) }))
      ),
    [analyses, silences]
  )

  // The pauses show in red on the timeline while the settings change.
  useEffect(() => {
    if (!analyses) return
    const project = useEditor.getState().project
    const trackIds = new Set<string>()
    for (const { event } of analyses) {
      for (const e of project.events) if (e.id === event.id || (event.groupId && e.groupId === event.groupId)) trackIds.add(e.trackId)
    }
    useEditor.setState({ cutPreview: { trackIds: [...trackIds], ranges } })
  }, [analyses, ranges])
  useEffect(() => () => useEditor.setState({ cutPreview: null }), [])

  const removed = silences.reduce((n, list) => n + list.reduce((k, s) => k + s.end - s.start, 0), 0)
  const duration = (analyses ?? []).reduce((n, a) => n + a.levels.length * HOP, 0)
  const count = silences.reduce((n, list) => n + list.length, 0)

  const apply = (): void => {
    if (!analyses) return
    // The timeline stays editable while the window is open: the clip must still be where it was analysed.
    const current = useEditor.getState().project.events
    const moved = analyses.some(({ event }) => {
      const now = current.find((e) => e.id === event.id)
      return !now || now.start !== event.start || now.length !== event.length || now.offset !== event.offset || now.rate !== event.rate
    })
    if (moved) {
      A.setStatus('The clip changed while Remove Silences was open: open it again')
      A.closeDialog()
      return
    }
    const cuts = A.cutRanges(
      analyses.map((a) => a.event.id),
      ranges,
      mode
    )
    A.setStatus(mode === 'remove' ? `Removed ${cuts} pauses (${removed.toFixed(1)} s)` : `Split at ${cuts} pauses: the pauses are selected`)
    A.closeDialog()
  }

  return (
    <FloatingWindow id="silence" className="silence-window" title="Remove Silences (jump cuts)">
      <div className="modal-body">
        {detectors.length === 0 ? (
          <div className="render-result error">Select the talking clip (its video or its audio event) first.</div>
        ) : !analyses ? (
          error ? <p className="dim">{error}</p> : <BoarProgress value={null}>Analyzing the sound…</BoarProgress>
        ) : (
          <>
            <p className="dim">
              Pauses (red, here and on the timeline) are cut from the selected clip and the following events on the same tracks move left. Other
              tracks are not touched: remove the silences before generating captions.
            </p>
            {analyses.map((a, i) => (
              <LevelGraph key={a.event.id} analysis={a} threshold={threshold} silences={silences[i]} />
            ))}
            <div className="form">
              <label>Silence below</label>
              <div className="te-control">
                <input type="range" min={-70} max={-10} step={1} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
                <span className="te-val">{threshold} dB</span>
                <button
                  className="btn small"
                  title="Pick a threshold from the noise floor and the voice level"
                  onClick={() => setThreshold(autoThreshold(analyses.length === 1 ? analyses[0].levels : new Float32Array(analyses.flatMap((a) => Array.from(a.levels)))))}
                >
                  <Wand size={12} /> Auto
                </button>
              </div>
              <label>Shortest pause</label>
              <div className="te-control">
                <input type="range" min={0.1} max={2} step={0.05} value={minSilence} onChange={(e) => setMinSilence(Number(e.target.value))} />
                <span className="te-val">{minSilence.toFixed(2)} s</span>
              </div>
              <label>Keep around words</label>
              <div className="te-control">
                <input type="range" min={0} max={0.4} step={0.01} value={padding} onChange={(e) => setPadding(Number(e.target.value))} />
                <span className="te-val">{padding.toFixed(2)} s</span>
              </div>
              <label>Action</label>
              <div className="te-control">
                <label className="te-check">
                  <input type="radio" name="silence-mode" checked={mode === 'remove'} onChange={() => setMode('remove')} />
                  Cut and close the gaps
                </label>
                <label className="te-check">
                  <input type="radio" name="silence-mode" checked={mode === 'split'} onChange={() => setMode('split')} />
                  Only split (review the pauses)
                </label>
              </div>
            </div>
            <div className="render-result">
              {count} pause{count === 1 ? '' : 's'} · −{removed.toFixed(1)} s ({formatDuration(secondsToFlicks(duration))} →{' '}
              {formatDuration(secondsToFlicks(Math.max(0, duration - removed)))})
            </div>
          </>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={A.closeDialog}>
            Cancel
          </button>
          <button className="btn primary" disabled={!analyses || count === 0} onClick={apply}>
            <Scissors size={13} /> {mode === 'remove' ? 'Remove pauses' : 'Split'}
          </button>
        </div>
      </div>
    </FloatingWindow>
  )
}

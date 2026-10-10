import { useRef, useState } from 'react'
import { X, ZoomIn } from 'lucide-react'
import * as A from '../core/actions'
import { mediaById, useEditor } from '../core/store'
import type { PanCropKey } from '../core/pancrop'
import { FLICKS_PER_SECOND } from '../core/time'
import type { TimelineEvent } from '../core/types'
import { type AutoZoomOptions, ZOOM_MODES, faceAt, loudMoments, zoomKeys } from '../engine/autoZoom'
import { BoarProgress, celebrate } from './BoarProgress'

/** Selected video clips, or every video clip when none is selected. */
function targets(events: TimelineEvent[], selection: string[]): TimelineEvent[] {
  const video = events.filter((e) => e.kind === 'video' && !e.text && mediaById(e.mediaId)?.status === 'ready')
  const selected = video.filter((e) => selection.includes(e.id))
  const foreground = new Set(A.foregroundVideoEvents().map((e) => e.id))
  return (selected.length ? selected : video.filter((e) => foreground.has(e.id))).sort((a, b) => a.start - b.start)
}

/** Tools › Auto Zoom: punch-ins for talking heads, written as Event Pan/Crop keyframes. */
export function AutoZoomDialog(): React.JSX.Element {
  const events = useEditor((s) => s.project.events)
  const selection = useEditor((s) => s.selection)
  const list = targets(events, selection)
  const [options, setOptions] = useState<AutoZoomOptions>({ mode: 'cuts', amount: 1.15, face: true })
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState('')
  const cancelled = useRef(false)

  const run = async (): Promise<void> => {
    setError('')
    setProgress(0)
    cancelled.current = false
    try {
      const settings = useEditor.getState().project.settings
      const keys = new Map<string, PanCropKey[]>()
      // Jump-cut zoom alternates along each track.
      const position = new Map<string, number>()
      const counters = new Map<string, number>()
      for (const e of list) {
        const n = counters.get(e.trackId) ?? 0
        position.set(e.id, n)
        counters.set(e.trackId, n + 1)
      }
      let punches = 0
      for (let i = 0; i < list.length; i++) {
        if (cancelled.current) throw new Error('cancelled')
        const event = list[i]
        const media = mediaById(event.mediaId)
        if (!media) continue
        const zoomed = (position.get(event.id) ?? 0) % 2 === 1
        if (options.mode === 'cuts' && !zoomed) continue
        const middle = (event.offset + (event.length * event.rate) / 2) / FLICKS_PER_SECOND
        const face = options.face ? await faceAt(media, middle).catch(() => null) : null
        const moments = options.mode === 'punch' ? await loudMoments(event, media) : []
        punches += moments.length
        if (options.mode === 'punch' && moments.length === 0) continue
        keys.set(event.id, zoomKeys(event, media, settings, options, zoomed, face, moments))
        setProgress((i + 1) / list.length)
      }
      A.setPanCropForEvents(keys)
      A.setStatus(
        options.mode === 'punch'
          ? `Auto Zoom: ${punches} punch-in${punches === 1 ? '' : 's'} on ${keys.size} clip${keys.size === 1 ? '' : 's'}`
          : `Auto Zoom on ${keys.size} clip${keys.size === 1 ? '' : 's'}`
      )
      if (keys.size > 0) celebrate(useEditor.getState().status)
      A.closeDialog()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message !== 'cancelled') setError(message)
    } finally {
      setProgress(null)
    }
  }

  const busy = progress !== null
  return (
    <div className="modal-backdrop">
      <div className="modal" style={{ width: 520 }} role="dialog" aria-label="Auto zoom">
        <div className="modal-title">
          <span>Auto Zoom (punch-in)</span>
          <button className="tool-btn" title="Close (Esc)" disabled={busy} onClick={A.closeDialog}>
            <X size={14} />
          </button>
        </div>
        <div className="modal-body">
          <p className="dim">
            Zooms in on {list.length} clip{list.length === 1 ? '' : 's'} to keep a talking head lively. Works best after
            Remove Silences or the Transcript cuts. The zoom is written as Event Pan/Crop keyframes on top of the current
            framing, so you can fine-tune it.
          </p>
          <div className="form">
            <label>Style</label>
            <div className="te-control">
              {ZOOM_MODES.map((m) => (
                <label key={m.id} className="te-check">
                  <input type="radio" name="zoom-mode" checked={options.mode === m.id} onChange={() => setOptions({ ...options, mode: m.id })} />
                  {m.label}
                </label>
              ))}
            </div>
            <label>Zoom</label>
            <div className="te-control">
              <input
                type="range"
                min={1.05}
                max={1.5}
                step={0.01}
                value={options.amount}
                onChange={(e) => setOptions({ ...options, amount: Number(e.target.value) })}
              />
              <span className="te-val">{Math.round(options.amount * 100)}%</span>
            </div>
            <label>Center</label>
            <label className="te-check">
              <input type="checkbox" checked={options.face} onChange={(e) => setOptions({ ...options, face: e.target.checked })} />
              Zoom toward the face (found on this PC)
            </label>
          </div>
          {busy && (
            <BoarProgress value={progress}>Analyzing… {Math.round((progress ?? 0) * 100)}%</BoarProgress>
          )}
          {(error || list.length === 0) && <div className="render-result error">{error || 'Add a video clip to the timeline first.'}</div>}
          <div className="modal-actions">
            <button className="btn" onClick={() => (busy ? (cancelled.current = true) : A.closeDialog())}>
              Cancel
            </button>
            <button className="btn primary" disabled={busy || list.length === 0} onClick={() => void run()}>
              <ZoomIn size={13} /> Apply
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

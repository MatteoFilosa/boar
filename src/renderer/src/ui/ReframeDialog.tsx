import { useRef, useState } from 'react'
import { ScanFace, X } from 'lucide-react'
import * as A from '../core/actions'
import { mediaById, useEditor } from '../core/store'
import type { PanCropKey } from '../core/pancrop'
import type { TimelineEvent } from '../core/types'
import { type ReframeOptions, analyzeFaces, reframeKeys } from '../engine/reframe'

/** Selected video clips (or every video clip when none is selected). */
function targets(events: TimelineEvent[], selection: string[]): TimelineEvent[] {
  const video = events.filter((e) => e.kind === 'video' && !e.text && mediaById(e.mediaId)?.status === 'ready')
  const selected = video.filter((e) => selection.includes(e.id))
  const foreground = new Set(A.foregroundVideoEvents().map((e) => e.id))
  return selected.length ? selected : video.filter((e) => foreground.has(e.id))
}

/** Tools › Auto Reframe: Pan/Crop keyframes that follow the face (16:9 footage in a 9:16 Reel). */
export function ReframeDialog(): React.JSX.Element {
  const events = useEditor((s) => s.project.events)
  const selection = useEditor((s) => s.selection)
  const settings = useEditor((s) => s.project.settings)
  const list = targets(events, selection)
  const [vertical, setVertical] = useState(settings.width > settings.height)
  const [options, setOptions] = useState<ReframeOptions>({ mode: 'follow', smoothness: 0.6, zoom: 1 })
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState('')
  const cancelled = useRef(false)

  const run = async (): Promise<void> => {
    setError('')
    setProgress(0)
    cancelled.current = false
    try {
      if (vertical) A.setFrameSize(1080, 1920)
      const project = useEditor.getState().project
      const keys = new Map<string, PanCropKey[]>()
      let missing = 0
      for (let i = 0; i < list.length; i++) {
        const event = list[i]
        const media = mediaById(event.mediaId)
        if (!media) continue
        const samples = await analyzeFaces(event, media, (f) => setProgress((i + f) / list.length), () => cancelled.current)
        const result = reframeKeys(samples, media, project.settings, options)
        if (result) keys.set(event.id, result)
        else missing++
      }
      A.setPanCropForEvents(keys)
      A.setStatus(`Reframed ${keys.size} clip${keys.size === 1 ? '' : 's'}${missing ? ` · no face found in ${missing}` : ''}`)
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
      <div className="modal" style={{ width: 520 }} role="dialog" aria-label="Auto reframe">
        <div className="modal-title">
          <span>Auto Reframe (follow the face)</span>
          <button className="tool-btn" title="Close (Esc)" disabled={busy} onClick={A.closeDialog}>
            <X size={14} />
          </button>
        </div>
        <div className="modal-body">
          <p className="dim">
            Finds the face in {list.length} clip{list.length === 1 ? '' : 's'} (on this PC, GPU accelerated) and writes
            Event Pan/Crop keyframes that keep it in frame. You can fine-tune them in Event Pan/Crop.
          </p>
          <div className="form">
            {settings.width > settings.height && (
              <>
                <label>Project</label>
                <label className="te-check">
                  <input type="checkbox" checked={vertical} onChange={(e) => setVertical(e.target.checked)} />
                  Switch to vertical 9:16 (1080x1920) first
                </label>
              </>
            )}
            <label>Camera</label>
            <div className="te-control">
              <label className="te-check">
                <input type="radio" name="reframe-mode" checked={options.mode === 'follow'} onChange={() => setOptions({ ...options, mode: 'follow' })} />
                Follow the face
              </label>
              <label className="te-check">
                <input type="radio" name="reframe-mode" checked={options.mode === 'static'} onChange={() => setOptions({ ...options, mode: 'static' })} />
                Frame it once (static)
              </label>
            </div>
            <label>Steadiness</label>
            <div className="te-control">
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                disabled={options.mode === 'static'}
                value={options.smoothness}
                onChange={(e) => setOptions({ ...options, smoothness: Number(e.target.value) })}
              />
              <span className="te-val">{Math.round(options.smoothness * 100)}%</span>
            </div>
            <label>Extra zoom</label>
            <div className="te-control">
              <input type="range" min={1} max={1.8} step={0.05} value={options.zoom} onChange={(e) => setOptions({ ...options, zoom: Number(e.target.value) })} />
              <span className="te-val">{options.zoom.toFixed(2)}×</span>
            </div>
          </div>
          {busy && (
            <div className="render-progress">
              <div className="render-bar">
                <div style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
              </div>
              <div className="dim">Looking for faces… {Math.round((progress ?? 0) * 100)}%</div>
            </div>
          )}
          {(error || list.length === 0) && <div className="render-result error">{error || 'Add a video clip to the timeline first.'}</div>}
          <div className="modal-actions">
            <button className="btn" onClick={() => (busy ? (cancelled.current = true) : A.closeDialog())}>
              Cancel
            </button>
            <button className="btn primary" disabled={busy || list.length === 0} onClick={() => void run()}>
              <ScanFace size={13} /> Reframe
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

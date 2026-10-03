import { useEffect, useRef } from 'react'
import { Trash } from 'lucide-react'
import * as A from '../core/actions'
import { useEditor } from '../core/store'
import { TRANSITIONS } from '../core/transitions'
import { FLICKS_PER_SECOND, secondsToFlicks } from '../core/time'
import { applyTransition } from '../engine/videoFx'
import { startMediaDrag } from './mediaDrag'
import { FloatingWindow } from './FloatingWindow'

const W = 192
const H = 108

function scene(colors: [string, string, string]): OffscreenCanvas {
  const c = new OffscreenCanvas(W, H)
  const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D
  const g = ctx.createLinearGradient(0, 0, W, H)
  g.addColorStop(0, colors[0])
  g.addColorStop(1, colors[1])
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = colors[2]
  ctx.font = '900 46px "Segoe UI", sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  return c
}

let scenes: [OffscreenCanvas, OffscreenCanvas] | null = null

function sampleScenes(): [OffscreenCanvas, OffscreenCanvas] {
  if (scenes) return scenes
  const a = scene(['#3d7fd6', '#7a4fd6', '#ffffff'])
  const b = scene(['#f2a65a', '#e8413c', '#ffffff'])
  ;(a.getContext('2d') as OffscreenCanvasRenderingContext2D).fillText('A', W / 2, H / 2)
  ;(b.getContext('2d') as OffscreenCanvasRenderingContext2D).fillText('B', W / 2, H / 2)
  scenes = [a, b]
  return scenes
}

/** A transition frozen near its middle, from a blue "A" to an orange "B". */
export function TransitionThumb({ type }: { type: string }): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    canvas.width = W
    canvas.height = H
    const [a, b] = sampleScenes()
    const out = applyTransition(a, b, type, 0.4, W, H)
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
    ctx.clearRect(0, 0, W, H)
    ctx.drawImage(out ?? a, 0, 0)
  }, [type])
  return <canvas ref={ref} className="fx-thumb" />
}

/** Dock tab: drag a transition onto the event it should lead into. */
export function TransitionBrowser(): React.JSX.Element {
  return (
    <div className="fx-browser">
      <div className="gen-title">
        Transitions — drag onto the clip after the cut, or double-click to add to the selected clips. Overlapping two clips
        still makes a plain crossfade.
      </div>
      <div className="gen-grid">
        {TRANSITIONS.map((t) => (
          <div
            key={t.type}
            className="gen-tile"
            title={`${t.description}\nDrag onto the clip after the cut, or double-click to add to the selected clips.`}
            onPointerDown={(e) => e.button === 0 && startMediaDrag(`tr:${t.type}`, e.clientX, e.clientY)}
            onDoubleClick={() => A.setTransition(useEditor.getState().selection, t.type)}
          >
            <TransitionThumb type={t.type} />
            <span>{t.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Floating window for the transition into one event: type and length. */
export function TransitionWindow({ eventId }: { eventId: string }): React.JSX.Element | null {
  const event = useEditor((s) => s.project.events.find((e) => e.id === eventId))
  useEffect(() => {
    if (!event) A.closeDialog()
  }, [event])
  if (!event) return null
  const current = event.transition
  const seconds = (current?.duration ?? secondsToFlicks(0.5)) / FLICKS_PER_SECOND
  return (
    <FloatingWindow id="transition" className="fx-window" title="Transition into this clip">
      <div className="te-body">
        <div className="gen-grid tr-grid">
          {TRANSITIONS.map((t) => (
            <button
              key={t.type}
              className={`caption-style${current?.type === t.type ? ' active' : ''}`}
              title={t.description}
              onClick={() => A.setTransition([event.id], t.type)}
            >
              <TransitionThumb type={t.type} />
              <span>{t.label}</span>
            </button>
          ))}
        </div>
        <label className="te-field">
          <span>Length</span>
          <div className="te-control">
            <input
              type="range"
              min={0.1}
              max={2}
              step={0.05}
              value={seconds}
              disabled={!current}
              onChange={(e) => current && A.setTransition([event.id], current.type, secondsToFlicks(Number(e.target.value)))}
            />
            <span className="te-val">{seconds.toFixed(2)} s</span>
            <button className="btn small" disabled={!current} onClick={() => A.setTransition([event.id], null)}>
              <Trash size={12} /> Remove
            </button>
          </div>
        </label>
        <p className="dim">On a cut the transition is centered on it (half before, half after), so the timing of the edit does not change.</p>
      </div>
    </FloatingWindow>
  )
}

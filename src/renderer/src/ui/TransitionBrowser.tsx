import { useEffect, useMemo, useRef } from 'react'
import { Trash } from 'lucide-react'
import * as A from '../core/actions'
import { mediaById, useEditor } from '../core/store'
import { DEFAULT_TRANSITION_LENGTH, TRANSITIONS, type TransitionMode, type TransitionSide } from '../core/transitions'
import { FLICKS_PER_SECOND, frameFlicks, secondsToFlicks } from '../core/time'
import type { TimelineEvent } from '../core/types'
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

/** Dock tab: drag a transition onto the start or end of an event, or onto two overlapping events. */
export function TransitionBrowser(): React.JSX.Element {
  return (
    <div className="fx-browser">
      <div className="gen-title">
        Transitions — drag onto the start or the end of a clip, or where two clips overlap: the whole overlap becomes the
        transition. Double-click adds one to the start of the selected clips; click its name on the timeline to change it.
      </div>
      <div className="gen-grid">
        {TRANSITIONS.map((t) => (
          <div
            key={t.type}
            className="gen-tile"
            title={`${t.description}\nDrag onto the start or the end of a clip, or onto two overlapping clips. Double-click: start of the selected clips.`}
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


const PLACE_TEXT: Record<TransitionMode, string> = {
  overlap: 'Where the two clips overlap: the whole overlap is the transition. Changing its length trims both clips around the middle of the overlap.',
  cut: 'On the cut: half before it, half after it, so the timing of the edit does not change.',
  in: 'At the start of the clip: the clip comes in with the effect.',
  out: 'At the end of the clip: the clip goes out with the effect.'
}

function eventName(e: TimelineEvent): string {
  if (e.text) return `Text "${e.text.text.replace(/\s+/g, ' ').slice(0, 24)}"`
  return mediaById(e.mediaId)?.name ?? 'Missing media'
}

/** Floating window for the transition at the start or end of one event: where, type and length. */
export function TransitionWindow({ eventId, side }: { eventId: string; side: TransitionSide }): React.JSX.Element | null {
  const project = useEditor((s) => s.project)
  const place = useMemo(() => A.transitionPlace(project, eventId, side), [project, eventId, side])
  useEffect(() => {
    if (!place) A.closeDialog()
  }, [place])
  if (!place) return null
  const { slot, current, span } = place
  const mode: TransitionMode = span?.mode ?? (slot.side === 'out' ? 'out' : 'in')
  const length = span ? span.end - span.start : (current?.duration ?? DEFAULT_TRANSITION_LENGTH)
  const seconds = Math.round((length / FLICKS_PER_SECOND) * 100) / 100
  const minSeconds = mode === 'overlap' ? Math.ceil((frameFlicks(project.settings.frameRate) / FLICKS_PER_SECOND) * 100) / 100 : 0.1
  const setLength = (value: number): void => {
    if (Number.isFinite(value) && value > 0) A.setTransitionLength(eventId, side, secondsToFlicks(value))
  }
  const where = slot.prev && slot.side === 'in' ? `${eventName(slot.prev)}  →  ${eventName(slot.event)}` : eventName(slot.event)
  return (
    <FloatingWindow id="transition" className="fx-window" title="Transition">
      <div className="te-body">
        <div className="te-control">
          <button className={`tool-btn labeled${side === 'in' ? ' active' : ''}`} onClick={() => A.openTransitionWindow(eventId, 'in')}>
            Start of the clip
          </button>
          <button className={`tool-btn labeled${side === 'out' ? ' active' : ''}`} onClick={() => A.openTransitionWindow(eventId, 'out')}>
            End of the clip
          </button>
        </div>
        <div className="tr-where" title={where}>
          {where}
        </div>
        <p className="dim">{PLACE_TEXT[mode]}</p>
        <div className="gen-grid tr-grid">
          {TRANSITIONS.map((t) => (
            <button
              key={t.type}
              className={`caption-style${current?.type === t.type ? ' active' : ''}`}
              title={t.description}
              onClick={() => A.setTransition([eventId], t.type, undefined, side)}
            >
              <TransitionThumb type={t.type} />
              <span>{t.label}</span>
            </button>
          ))}
        </div>
        <label className="te-field">
          <span>{mode === 'overlap' ? 'Overlap' : 'Length'}</span>
          <div className="te-control">
            <input
              type="range"
              min={minSeconds}
              max={5}
              step={0.05}
              value={seconds}
              disabled={!current}
              onChange={(e) => setLength(Number(e.target.value))}
            />
            <input
              className="input te-num"
              type="number"
              min={minSeconds}
              max={30}
              step={0.05}
              value={seconds}
              disabled={!current}
              title="Seconds"
              onChange={(e) => setLength(Number(e.target.value))}
            />
            <span className="te-dim">s</span>
            <button className="btn small" disabled={!current} onClick={() => A.setTransition([eventId], null, undefined, side)}>
              <Trash size={12} /> Remove
            </button>
          </div>
        </label>
        {!current && <p className="dim">Pick a transition above, or drag one from the Transitions tab onto the timeline.</p>}
      </div>
    </FloatingWindow>
  )
}

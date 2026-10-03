import { useEffect } from 'react'
import { Circle, Square } from 'lucide-react'
import { FloatingWindow } from './FloatingWindow'
import * as A from '../core/actions'
import { useEditor } from '../core/store'
import { DEFAULT_MASK, type EventMask } from '../core/mask'

function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  onChange: (v: number) => void
}): React.JSX.Element {
  return (
    <label className="te-field">
      <span>{label}</span>
      <div className="te-control">
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
        <span className="te-dim te-val">{format(value)}</span>
      </div>
    </label>
  )
}

const pct = (v: number): string => `${Math.round(v * 100)}%`

/** Floating window to edit an event's shape mask; the preview updates live. */
export function MaskDialog({ eventId }: { eventId: string }): React.JSX.Element | null {
  const event = useEditor((s) => s.project.events.find((e) => e.id === eventId))
  useEffect(() => {
    if (!event) A.closeDialog()
  }, [event])
  if (!event) return null
  const mask = event.mask
  const update = (patch: Partial<EventMask>, field: string): void =>
    A.setMask(event.id, { ...(mask ?? DEFAULT_MASK), ...patch }, field)

  return (
    <FloatingWindow id="mask" className="text-editor" title="Event Mask">
      <div className="te-body">
        <label className="te-check">
          <input
            type="checkbox"
            checked={mask !== null}
            onChange={(e) => A.setMask(event.id, e.target.checked ? { ...DEFAULT_MASK } : null, 'enable')}
          />
          Enable mask (outside the shape becomes transparent)
        </label>
        {mask && (
          <div className="te-grid">
            <label className="te-field">
              <span>Shape</span>
              <div className="te-control">
                <button
                  className={`tool-btn labeled${mask.shape === 'ellipse' ? ' active' : ''}`}
                  onClick={() => update({ shape: 'ellipse' }, 'shape')}
                >
                  <Circle size={13} /> Ellipse
                </button>
                <button
                  className={`tool-btn labeled${mask.shape === 'rectangle' ? ' active' : ''}`}
                  onClick={() => update({ shape: 'rectangle' }, 'shape')}
                >
                  <Square size={13} /> Rectangle
                </button>
                <label className="te-check">
                  <input type="checkbox" checked={mask.invert} onChange={(e) => update({ invert: e.target.checked }, 'invert')} />
                  Invert
                </label>
              </div>
            </label>
            <Slider label="Center X" value={mask.cx} min={0} max={1} step={0.005} format={pct} onChange={(cx) => update({ cx }, 'cx')} />
            <Slider label="Center Y" value={mask.cy} min={0} max={1} step={0.005} format={pct} onChange={(cy) => update({ cy }, 'cy')} />
            <Slider label="Width" value={mask.w} min={0.02} max={1.5} step={0.005} format={pct} onChange={(w) => update({ w }, 'w')} />
            <Slider label="Height" value={mask.h} min={0.02} max={1.5} step={0.005} format={pct} onChange={(h) => update({ h }, 'h')} />
            <Slider
              label="Feather"
              value={mask.feather}
              min={0}
              max={200}
              step={1}
              format={(v) => `${v}px`}
              onChange={(feather) => update({ feather }, 'feather')}
            />
          </div>
        )}
        <p className="dim">
          Tip: put the masked event on a track above another clip for a picture-in-picture or spotlight look. AI masks
          (background removal) are planned.
        </p>
      </div>
    </FloatingWindow>
  )
}

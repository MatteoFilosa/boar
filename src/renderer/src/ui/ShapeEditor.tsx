import { useEffect, useRef } from 'react'
import { Circle, MoveUpRight, RotateCcw, Square } from 'lucide-react'
import { FloatingWindow } from './FloatingWindow'
import * as A from '../core/actions'
import { useEditor } from '../core/store'
import {
  SHAPE_ANIM_IN,
  SHAPE_ANIM_OUT,
  type ShapeAnimIn,
  type ShapeAnimOut,
  type ShapeContent,
  type ShapeKind,
  drawShape,
  shapeForFrame
} from '../core/shapes'
import { normalizeAngle } from '../core/pancrop'
import { Field } from './TextEditor'

/** Draws a shape preset on a small canvas, used by Media Generators. */
export function ShapeThumb({ presetId }: { presetId: string }): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const w = 320
    const h = 180
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
    const g = ctx.createLinearGradient(0, 0, w, h)
    g.addColorStop(0, '#3b4a63')
    g.addColorStop(1, '#5d4a6b')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
    const shape = shapeForFrame(presetId, w, h)
    // Thicker than at full size, so the thumbnail reads.
    if (shape) drawShape(ctx, { ...shape, width: shape.width * 2, head: shape.head * 1.5 }, w, h, 1)
  }, [presetId])
  return <canvas ref={ref} className="preset-thumb" />
}

const KINDS: [ShapeKind, string, typeof Square][] = [
  ['rectangle', 'Rectangle', Square],
  ['ellipse', 'Ellipse', Circle],
  ['arrow', 'Arrow', MoveUpRight]
]

export function ShapeEditor({ eventId }: { eventId: string }): React.JSX.Element | null {
  const event = useEditor((s) => s.project.events.find((e) => e.id === eventId))
  useEffect(() => {
    if (!event?.shape) A.closeDialog()
  }, [event])
  if (!event?.shape) return null
  const s = event.shape
  const arrow = s.kind === 'arrow'
  const update = (patch: Partial<ShapeContent>, field: string): void => A.updateShape(event.id, patch, field)

  return (
    <FloatingWindow id="shape" className="text-editor" title="Shape">
      <div className="te-body">
        <div className="te-grid">
          <Field label="Shape">
            {KINDS.map(([kind, label, Icon]) => (
              <button
                key={kind}
                className={`tool-btn${s.kind === kind ? ' active' : ''}`}
                title={`${label} (keeps the place)`}
                onClick={() => A.setShapeKind(event.id, kind)}
              >
                <Icon size={14} />
              </button>
            ))}
          </Field>
          <Field label={arrow ? 'Arrow' : 'Outline'}>
            <input type="color" value={s.color} onChange={(e) => update({ color: e.target.value }, 'color')} />
            <input
              type="range"
              min={arrow ? 1 : 0}
              max={40}
              step={0.5}
              value={s.width}
              title={`Width: ${s.width} px at 1080p${arrow ? '' : ' (0 = no outline)'}`}
              onChange={(e) => update({ width: Number(e.target.value) }, 'width')}
            />
            <span className="te-dim te-val">{s.width} px</span>
          </Field>
          {arrow ? (
            <Field label="Head">
              <input
                type="range"
                min={10}
                max={200}
                step={1}
                value={s.head}
                title={`Head length: ${s.head} px at 1080p`}
                onChange={(e) => update({ head: Number(e.target.value) }, 'head')}
              />
              <span className="te-dim te-val">{s.head} px</span>
            </Field>
          ) : (
            <>
              <Field label="Fill">
                <input type="checkbox" checked={s.fill !== ''} onChange={(e) => update({ fill: e.target.checked ? s.color : '' }, 'fill')} />
                <input
                  type="color"
                  disabled={s.fill === ''}
                  value={s.fill || s.color}
                  onChange={(e) => update({ fill: e.target.value }, 'fillColor')}
                />
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  disabled={s.fill === ''}
                  value={s.fillOpacity}
                  title={`Fill opacity: ${Math.round(s.fillOpacity * 100)}%`}
                  onChange={(e) => update({ fillOpacity: Number(e.target.value) }, 'fillOpacity')}
                />
                <span className="te-dim te-val">{Math.round(s.fillOpacity * 100)}%</span>
              </Field>
              {s.kind === 'rectangle' && (
                <Field label="Corners">
                  <input
                    type="range"
                    min={0}
                    max={200}
                    step={1}
                    value={s.radius}
                    title={`Corner radius: ${s.radius} px at 1080p`}
                    onChange={(e) => update({ radius: Number(e.target.value) }, 'radius')}
                  />
                  <span className="te-dim te-val">{s.radius} px</span>
                </Field>
              )}
            </>
          )}
          <Field label="Effects">
            <label className="te-check">
              <input type="checkbox" checked={s.shadow} onChange={(e) => update({ shadow: e.target.checked }, 'shadow')} />
              Shadow
            </label>
          </Field>
          <Field label="Animation">
            <span className="te-dim">In</span>
            <select className="select" value={s.animIn} onChange={(e) => update({ animIn: e.target.value as ShapeAnimIn }, 'animIn')}>
              {SHAPE_ANIM_IN.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
            <span className="te-dim">Out</span>
            <select className="select" value={s.animOut} onChange={(e) => update({ animOut: e.target.value as ShapeAnimOut }, 'animOut')}>
              {SHAPE_ANIM_OUT.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
            <input
              type="range"
              min={0.1}
              max={2}
              step={0.05}
              value={s.animDuration}
              title={`Duration: ${s.animDuration.toFixed(2)} s`}
              onChange={(e) => update({ animDuration: Number(e.target.value) }, 'animDuration')}
            />
            <span className="te-dim te-val">{s.animDuration.toFixed(2)} s</span>
          </Field>
          {!arrow && (
            <Field label="Rotation">
              <input
                type="range"
                min={-180}
                max={180}
                step={1}
                value={s.rotation}
                title={`Rotation: ${s.rotation.toFixed(1)}°`}
                onChange={(e) => update({ rotation: Number(e.target.value) }, 'rotation')}
              />
              <input
                className="input te-num"
                type="number"
                min={-180}
                max={180}
                step={1}
                value={Math.round(s.rotation * 10) / 10}
                title="Degrees, clockwise"
                onChange={(e) => update({ rotation: normalizeAngle(Number(e.target.value) || 0) }, 'rotation')}
              />
              <button className="tool-btn" title="Upright (0°)" disabled={s.rotation === 0} onClick={() => update({ rotation: 0 }, 'rotationReset')}>
                <RotateCcw size={13} />
              </button>
            </Field>
          )}
        </div>
        <p className="te-hint">
          {arrow
            ? 'In the preview: drag the arrow to move it, drag its ends to point it (Shift: 15° steps).'
            : 'In the preview: drag to move, sides and corners to resize (Shift on a corner keeps the proportions), just outside a corner to rotate.'}
        </p>
      </div>
    </FloatingWindow>
  )
}

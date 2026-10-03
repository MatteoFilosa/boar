import { useEffect, useRef } from 'react'
import { AlignCenter, AlignLeft, AlignRight, Bold, CaseUpper, Italic } from 'lucide-react'
import { FloatingWindow } from './FloatingWindow'
import * as A from '../core/actions'
import { useEditor } from '../core/store'
import {
  ANIM_IN,
  ANIM_OUT,
  TEXT_PRESETS,
  type TextAnimIn,
  type TextAnimOut,
  type TextContent,
  type TextPreset,
  WORD_STYLES,
  type WordStyle,
  drawText
} from '../core/text'
import { loadFont } from '../core/fonts'
import { FontPicker } from './FontPicker'

/** Draws a text preset on a small canvas (redrawn once its font is loaded). */
function drawPresetThumb(canvas: HTMLCanvasElement, preset: TextPreset): void {
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
  drawText(ctx, preset.content, w, h, 1)
}

/** Small rendering of a preset, used by Media Generators. */
export function PresetThumb({ preset }: { preset: TextPreset }): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    let cancelled = false
    if (ref.current) drawPresetThumb(ref.current, preset)
    void loadFont(preset.content.font).then(() => {
      if (!cancelled && ref.current) drawPresetThumb(ref.current, preset)
    })
    return () => {
      cancelled = true
    }
  }, [preset])
  return <canvas ref={ref} className="preset-thumb" />
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <label className="te-field">
      <span>{label}</span>
      <div className="te-control">{children}</div>
    </label>
  )
}

export function TextEditor({ eventId }: { eventId: string }): React.JSX.Element | null {
  const event = useEditor((s) => s.project.events.find((e) => e.id === eventId))
  useEffect(() => {
    if (!event?.text) A.closeDialog()
  }, [event])
  if (!event?.text) return null
  const t = event.text
  const update = (patch: Partial<TextContent>, field: string): void => A.updateText(event.id, patch, field)
  const siblings = useEditor.getState().project.events.filter((e) => e.trackId === event.trackId && e.text && e.id !== event.id).length

  return (
    <FloatingWindow id="text" className="text-editor" title="Text">
      <div className="te-body">
        <div className="te-presets">
          <select
            className="select"
            value=""
            title="Apply a preset look (keeps the text and the word timings)"
            onChange={(e) => {
              const p = TEXT_PRESETS.find((x) => x.id === e.target.value)
              if (p) update({ ...p.content, text: t.text, words: t.words }, 'preset')
            }}
          >
            <option value="">Apply a preset look…</option>
            {TEXT_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label} — {p.description}
              </option>
            ))}
          </select>
          {siblings > 0 && (
            <button className="btn small" title="Copy this look to the other text events on the same track (e.g. all captions)" onClick={() => A.applyTextStyleToTrack(event.id)}>
              Apply look to track ({siblings})
            </button>
          )}
        </div>
        <textarea
          className="te-text"
          value={t.text}
          rows={3}
          spellCheck={false}
          autoFocus
          onChange={(e) => update({ text: e.target.value }, 'text')}
        />
        <div className="te-hint">
          Write <b>*word*</b> to highlight a word in
          <input type="color" value={t.emphasisColor} onChange={(e) => update({ emphasisColor: e.target.value }, 'emphasisColor')} />
        </div>
        <div className="te-grid">
          <Field label="Font">
            <FontPicker value={t.font} onChange={(font) => update({ font }, 'font')} />
            <input
              className="input te-num"
              type="number"
              min={8}
              max={600}
              value={t.size}
              title="Size (px at 1080p)"
              onChange={(e) => update({ size: Math.max(8, Number(e.target.value) || 8) }, 'size')}
            />
            <button className={`tool-btn${t.bold ? ' active' : ''}`} title="Bold" onClick={() => update({ bold: !t.bold }, 'bold')}>
              <Bold size={14} />
            </button>
            <button
              className={`tool-btn${t.italic ? ' active' : ''}`}
              title="Italic"
              onClick={() => update({ italic: !t.italic }, 'italic')}
            >
              <Italic size={14} />
            </button>
            <button
              className={`tool-btn${t.uppercase ? ' active' : ''}`}
              title="All caps"
              onClick={() => update({ uppercase: !t.uppercase }, 'uppercase')}
            >
              <CaseUpper size={15} />
            </button>
          </Field>
          <Field label="Animation">
            <span className="te-dim">In</span>
            <select className="select" value={t.animIn} onChange={(e) => update({ animIn: e.target.value as TextAnimIn }, 'animIn')}>
              {ANIM_IN.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
            <span className="te-dim">Out</span>
            <select className="select" value={t.animOut} onChange={(e) => update({ animOut: e.target.value as TextAnimOut }, 'animOut')}>
              {ANIM_OUT.map((a) => (
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
              value={t.animDuration}
              title={`Duration: ${t.animDuration.toFixed(2)} s`}
              onChange={(e) => update({ animDuration: Number(e.target.value) }, 'animDuration')}
            />
            <span className="te-dim te-val">{t.animDuration.toFixed(2)} s</span>
          </Field>
          {t.words && (
            <Field label="Words">
              <select className="select" value={t.wordStyle} onChange={(e) => update({ wordStyle: e.target.value as WordStyle }, 'wordStyle')}>
                {WORD_STYLES.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.label}
                  </option>
                ))}
              </select>
              <span className="te-dim">Highlight</span>
              <input type="color" value={t.highlightColor} onChange={(e) => update({ highlightColor: e.target.value }, 'highlightColor')} />
              <span className="te-dim">{t.words.length} timed words</span>
            </Field>
          )}
          <Field label="Color">
            <input type="color" value={t.color} onChange={(e) => update({ color: e.target.value }, 'color')} />
            <span className="te-dim">Outline</span>
            <input type="color" value={t.strokeColor} onChange={(e) => update({ strokeColor: e.target.value }, 'strokeColor')} />
            <input
              type="range"
              min={0}
              max={24}
              step={0.5}
              value={t.strokeWidth}
              title={`Outline width: ${t.strokeWidth}`}
              onChange={(e) => update({ strokeWidth: Number(e.target.value) }, 'strokeWidth')}
            />
          </Field>
          <Field label="Box">
            <input
              type="checkbox"
              checked={t.boxColor !== ''}
              onChange={(e) => update({ boxColor: e.target.checked ? '#000000' : '' }, 'box')}
            />
            <input
              type="color"
              disabled={t.boxColor === ''}
              value={t.boxColor || '#000000'}
              onChange={(e) => update({ boxColor: e.target.value }, 'boxColor')}
            />
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              disabled={t.boxColor === ''}
              value={t.boxOpacity}
              title={`Box opacity: ${Math.round(t.boxOpacity * 100)}%`}
              onChange={(e) => update({ boxOpacity: Number(e.target.value) }, 'boxOpacity')}
            />
            <select
              className="select"
              disabled={t.boxColor === ''}
              value={t.boxStyle}
              title="Box shape"
              onChange={(e) => update({ boxStyle: e.target.value as TextContent['boxStyle'] }, 'boxStyle')}
            >
              <option value="block">One box</option>
              <option value="lines">Rounded, per line</option>
            </select>
          </Field>
          <Field label="Effects">
            <label className="te-check">
              <input type="checkbox" checked={t.shadow} onChange={(e) => update({ shadow: e.target.checked }, 'shadow')} />
              Shadow
            </label>
            <label className="te-check">
              <input
                type="checkbox"
                checked={t.glow !== ''}
                onChange={(e) => update({ glow: e.target.checked ? '#ff3dd8' : '' }, 'glow')}
              />
              Neon glow
            </label>
            <input
              type="color"
              disabled={t.glow === ''}
              value={t.glow || '#ff3dd8'}
              onChange={(e) => update({ glow: e.target.value }, 'glowColor')}
            />
          </Field>
          <Field label="Align">
            {(
              [
                ['left', AlignLeft],
                ['center', AlignCenter],
                ['right', AlignRight]
              ] as const
            ).map(([align, Icon]) => (
              <button
                key={align}
                className={`tool-btn${t.align === align ? ' active' : ''}`}
                title={`Align ${align}`}
                onClick={() => update({ align, x: align === 'left' ? 0.07 : align === 'right' ? 0.93 : 0.5 }, 'align')}
              >
                <Icon size={14} />
              </button>
            ))}
            <span className="te-dim">Wrap</span>
            <input
              type="range"
              min={0.2}
              max={1}
              step={0.01}
              value={t.maxWidth}
              title={`Wrap width: ${Math.round(t.maxWidth * 100)}%`}
              onChange={(e) => update({ maxWidth: Number(e.target.value) }, 'maxWidth')}
            />
          </Field>
          <Field label="Position">
            <span className="te-dim">X</span>
            <input type="range" min={0} max={1} step={0.005} value={t.x} onChange={(e) => update({ x: Number(e.target.value) }, 'x')} />
            <span className="te-dim">Y</span>
            <input type="range" min={0} max={1} step={0.005} value={t.y} onChange={(e) => update({ y: Number(e.target.value) }, 'y')} />
            <span className="te-dim" title="You can also drag the text in the preview">(or drag in the preview)</span>
          </Field>
        </div>
      </div>
    </FloatingWindow>
  )
}

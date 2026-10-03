import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, Plus, Power, RotateCcw, X } from 'lucide-react'
import { FloatingWindow } from './FloatingWindow'
import { type MenuEntry, openContextMenu } from './ContextMenu'
import * as A from '../core/actions'
import { mediaById, useEditor } from '../core/store'
import { AUDIO_FX, EQ_BANDS, type EventFx, type FxDef, type FxParam, VIDEO_FX, formatParam, fxDef, fxParam } from '../core/fx'
import { FxThumb } from './FxBrowser'

/** Add-effect menu grouped by category. */
export function fxMenuEntries(library: FxDef[], add: (type: string) => void): MenuEntry[] {
  const entries: MenuEntry[] = []
  for (const category of [...new Set(library.map((d) => d.category))]) {
    entries.push({ header: category })
    for (const def of library.filter((d) => d.category === category)) entries.push({ label: def.label, run: () => add(def.type) })
  }
  return entries
}

function ParamControl({ p, value, onChange }: { p: FxParam; value: number; onChange: (v: number) => void }): React.JSX.Element {
  if (p.options) {
    return (
      <label className="te-field">
        <span>{p.label}</span>
        <div className="te-control">
          <select className="select" value={Math.round(value)} onChange={(e) => onChange(Number(e.target.value))}>
            {p.options.map((label, i) => (
              <option key={label} value={i}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </label>
    )
  }
  return (
    <label className="te-field" onDoubleClick={() => onChange(p.default)} title="Double-click to reset">
      <span>{p.label}</span>
      <div className="te-control">
        <input type="range" min={p.min} max={p.max} step={p.step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
        <span className="te-dim te-val fx-val">{formatParam(p, value)}</span>
      </div>
    </label>
  )
}

/** Ten vertical band sliders, like a hardware graphic equalizer. */
function GraphicEq({
  fx,
  def,
  onChange,
  onPreset
}: {
  fx: EventFx
  def: FxDef
  onChange: (key: string, v: number) => void
  onPreset: (params: Record<string, number>) => void
}): React.JSX.Element {
  const output = def.params.find((p) => p.key === 'output') as FxParam
  return (
    <div className="fx-eq-wrap">
      <div className="fx-eq">
        {EQ_BANDS.map((f) => {
          const p = def.params.find((x) => x.key === `b${f}`) as FxParam
          const v = fxParam(fx, p.key)
          return (
            <label key={f} className="fx-eq-band" onDoubleClick={() => onChange(p.key, 0)} title="Double-click to reset">
              <span className="fx-eq-db">{v > 0 ? '+' : ''}{v.toFixed(1)}</span>
              <input type="range" min={p.min} max={p.max} step={p.step} value={v} onChange={(e) => onChange(p.key, Number(e.target.value))} />
              <span className="fx-eq-hz">{p.label}</span>
            </label>
          )
        })}
      </div>
      <div className="fx-eq-presets">
        {(
          [
            ['Flat', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
            ['Voice clarity', [-6, -4, -2, -1, 0, 1, 3, 4, 2, 0]],
            ['Bass boost', [6, 5, 4, 2, 0, 0, 0, 0, 0, 0]],
            ['Warm', [2, 3, 2, 1, 0, -1, -1, -2, -2, -3]],
            ['Bright', [0, 0, 0, 0, 0, 1, 2, 3, 4, 4]],
            ['De-mud', [0, 0, -1, -4, -3, 0, 1, 1, 0, 0]]
          ] as const
        ).map(([label, gains]) => (
          <button
            key={label}
            className="btn small"
            onClick={() => onPreset(Object.fromEntries(EQ_BANDS.map((f, i) => [`b${f}`, gains[i]])))}
          >
            {label}
          </button>
        ))}
      </div>
      <ParamControl p={output} value={fxParam(fx, 'output')} onChange={(v) => onChange('output', v)} />
    </div>
  )
}

/** Floating window with an event's Video FX or Audio FX chain. */
export function FxWindow({ eventId, focus }: { eventId: string; focus?: string }): React.JSX.Element | null {
  const event = useEditor((s) => s.project.events.find((e) => e.id === eventId))
  const others = useEditor((s) => s.selection.filter((id) => id !== eventId).length)
  const [selected, setSelected] = useState<string | null>(focus ?? null)
  useEffect(() => {
    if (focus) setSelected(focus)
  }, [focus])
  useEffect(() => {
    if (!event) A.closeDialog()
  }, [event])
  if (!event) return null

  const kind = event.kind
  const library = kind === 'video' ? VIDEO_FX : AUDIO_FX
  const chain = event.fx.filter((f) => fxDef(f.type)?.kind === kind)
  const current = chain.find((f) => f.id === selected) ?? chain[0]
  const def = current ? fxDef(current.type) : undefined
  const name = event.text ? `Text "${event.text.text.split('\n')[0].slice(0, 24)}"` : (mediaById(event.mediaId)?.name ?? 'Event')

  const openAdd = (e: React.MouseEvent<HTMLButtonElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    openContextMenu(
      r.left,
      r.bottom + 2,
      fxMenuEntries(library, (type) => {
        const id = A.addFx([event.id], type)
        if (id) setSelected(id)
      })
    )
  }

  return (
    <FloatingWindow id={`fx-${kind}`} className="fx-window" title={`${kind === 'video' ? 'Video FX' : 'Audio FX'} — ${name}`}>
      <div className="fx-body">
        <div className="fx-chain">
          <button className="btn small fx-add" onClick={openAdd}>
            <Plus size={13} /> Add effect
          </button>
          {chain.length === 0 && <p className="dim fx-empty">No effects yet. Add one, or drag one from the {kind === 'video' ? 'Video FX' : 'Audio FX'} tab onto the event.</p>}
          {chain.map((fx, i) => {
            const d = fxDef(fx.type)
            return (
              <div
                key={fx.id}
                className={`fx-item${fx.id === current?.id ? ' active' : ''}${fx.enabled ? '' : ' off'}`}
                onClick={() => setSelected(fx.id)}
              >
                <button
                  className={`fx-power${fx.enabled ? ' on' : ''}`}
                  title={fx.enabled ? 'Bypass' : 'Enable'}
                  onClick={(e) => {
                    e.stopPropagation()
                    A.setFxEnabled(event.id, fx.id, !fx.enabled)
                  }}
                >
                  <Power size={12} />
                </button>
                <span className="fx-name">{d?.label ?? fx.type}</span>
                <button className="fx-mini" title="Move up" disabled={i === 0} onClick={(e) => (e.stopPropagation(), A.moveFx(event.id, fx.id, -1))}>
                  <ChevronUp size={12} />
                </button>
                <button
                  className="fx-mini"
                  title="Move down"
                  disabled={i === chain.length - 1}
                  onClick={(e) => (e.stopPropagation(), A.moveFx(event.id, fx.id, 1))}
                >
                  <ChevronDown size={12} />
                </button>
                <button className="fx-mini danger" title="Remove" onClick={(e) => (e.stopPropagation(), A.removeFx(event.id, fx.id))}>
                  <X size={12} />
                </button>
              </div>
            )
          })}
          {others > 0 && chain.length > 0 && (
            <button className="btn small fx-apply" onClick={() => A.applyFxToSelection(event.id)} title="Replace their effects with this chain">
              Apply chain to {others} selected
            </button>
          )}
        </div>
        <div className="fx-params">
          {current && def ? (
            <>
              <div className="fx-params-head">
                {kind === 'video' && <FxThumb type={def.type} params={current.params} />}
                <div>
                  <div className="fx-title">{def.label}</div>
                  <div className="dim">{def.description}</div>
                </div>
                <button className="tool-btn" title="Reset parameters" onClick={() => A.resetFx(event.id, current.id)}>
                  <RotateCcw size={13} />
                </button>
              </div>
              <div className="te-grid">
                {def.type === 'graphicEq' ? (
                  <GraphicEq
                    fx={current}
                    def={def}
                    onChange={(key, v) => A.setFxParam(event.id, current.id, key, v)}
                    onPreset={(params) => A.setFxParams(event.id, current.id, params)}
                  />
                ) : (
                  def.params.map((p) => (
                    <ParamControl key={p.key} p={p} value={fxParam(current, p.key)} onChange={(v) => A.setFxParam(event.id, current.id, p.key, v)} />
                  ))
                )}
              </div>
              {kind === 'audio' && <p className="dim fx-tip">Press Space to play: changes are heard live. Effects are rendered in the export too.</p>}
            </>
          ) : (
            <p className="dim">Select an effect to edit it.</p>
          )}
        </div>
      </div>
    </FloatingWindow>
  )
}

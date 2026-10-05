import { useEffect, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { ALT, MOD, isMac } from '../platform'
import type { CommandId } from './commands'
import { FloatingWindow } from './FloatingWindow'
import { BINDINGS, type Binding, bindingKey, bindingLabel } from './shortcuts'

// Help › Keyboard Shortcuts (F1): every key binding, grouped and searchable,
// on a keyboard you can explore. It stays open while you edit, and the keys
// you press light up, so it also works as a live legend.

const GROUPS: { name: string; commands: CommandId[] }[] = [
  {
    name: 'Playback and navigation',
    commands: [
      'playStop', 'playPause', 'play', 'pause', 'backOneSecond', 'forwardOneSecond', 'previousFrame', 'nextFrame',
      'previousEditPoint', 'nextEditPoint', 'goToStart', 'goToEnd', 'toggleLoop'
    ]
  },
  {
    name: 'Editing',
    commands: [
      'split', 'deleteSelection', 'rippleDelete', 'trimToSelection', 'clearTimeSelection', 'copy', 'cut', 'paste',
      'pasteAttributes', 'undo', 'redo', 'selectAll', 'cycleEditTool', 'group', 'ungroup', 'addMarker', 'rotateClockwise',
      'rotateCounterclockwise'
    ]
  },
  {
    name: 'Timeline',
    commands: ['zoomIn', 'zoomOut', 'tallerTracks', 'shorterTracks', 'toggleSnapping', 'toggleQuantize', 'toggleCrossfades', 'toggleRipple', 'addVideoTrack', 'addAudioTrack']
  },
  {
    name: 'Project',
    commands: ['newProject', 'openProject', 'saveProject', 'saveProjectAs', 'importMedia', 'render', 'properties']
  },
  { name: 'View and help', commands: ['fullScreenPreview', 'interfaceBigger', 'interfaceSmaller', 'interfaceReset', 'searchCommands', 'shortcuts'] }
]

const DESCRIPTIONS: Partial<Record<CommandId, string>> = {
  playStop: 'Play / pause (Options can make it return to the start)',
  playPause: 'Play / pause',
  play: 'Play',
  pause: 'Pause',
  backOneSecond: 'Back one second',
  split: 'Split events at the cursor',
  deleteSelection: 'Delete selected events (or the selected track)',
  rippleDelete: 'Delete and close the gap (ripple)',
  trimToSelection: 'Trim events to the time selection',
  clearTimeSelection: 'Clear the time selection',
  copy: 'Copy events',
  cut: 'Cut events',
  paste: 'Paste events at the cursor',
  pasteAttributes: 'Paste Event Attributes: the FX, Pan/Crop, mask, level and text style of the copied event onto the selected events',
  cycleEditTool: 'Switch between the normal edit tool and the selection tool (drag a rectangle anywhere)',
  openProject: 'Open project',
  saveProject: 'Save project',
  saveProjectAs: 'Save project as',
  render: 'Render As',
  undo: 'Undo',
  redo: 'Redo',
  selectAll: 'Select all events',
  group: 'Group selected events',
  ungroup: 'Remove selected events from their group',
  addMarker: 'Insert marker',
  toggleLoop: 'Loop playback',
  toggleSnapping: 'Snapping on / off',
  toggleQuantize: 'Quantize to frames on / off',
  toggleCrossfades: 'Automatic crossfades on / off',
  toggleRipple: 'Auto Ripple on / off',
  addVideoTrack: 'Insert video track',
  addAudioTrack: 'Insert audio track',
  importMedia: 'Import media',
  newProject: 'New project',
  properties: 'Project properties',
  goToStart: 'Go to start',
  goToEnd: 'Go to end',
  previousFrame: 'Previous frame (while playing: back 5 seconds)',
  nextFrame: 'Next frame (while playing: forward 5 seconds)',
  forwardOneSecond: 'Forward one second',
  previousEditPoint: 'Previous edit point',
  nextEditPoint: 'Next edit point',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  tallerTracks: 'Taller tracks',
  shorterTracks: 'Shorter tracks',
  interfaceBigger: 'Bigger interface (menus, panels, timeline)',
  interfaceSmaller: 'Smaller interface',
  interfaceReset: 'Interface back to 100%',
  fullScreenPreview: 'Full screen preview (Esc to exit)',
  rotateClockwise: 'Rotate selected video, image or text 90° clockwise',
  rotateCounterclockwise: 'Rotate selected video, image or text 90° counterclockwise',
  searchCommands: 'Search every command, option and effect',
  shortcuts: 'Show or hide this window'
}

export const describeCommand = (command: CommandId): string => DESCRIPTIONS[command] ?? command

const MOUSE: [string, string][] = [
  ['Wheel', 'Zoom the timeline around the cursor (at the mouse when the cursor is out of view)'],
  [`${MOD}+Wheel`, 'Scroll left / right'],
  ['Shift+Wheel', 'Scroll tracks up / down'],
  ['Drag event', 'Move (also to another track of the same kind); with Auto Ripple what follows moves too'],
  ['Drag near the left or right edge', 'The timeline scrolls (events, media from Project Media, files)'],
  [`${ALT} while dragging`, 'Ignore snapping'],
  ['Drag event edge', 'Trim (with Auto Ripple the later events follow)'],
  [`${MOD}+drag event edge`, 'Change speed'],
  ['Drag event top corner', 'Fade in / fade out'],
  ['Overlap two events', 'Automatic crossfade'],
  ['Drag on empty area', 'Select events in a rectangle'],
  ['Drag on the ruler', 'Time selection (loop region)'],
  ['Preview: drag a handle', 'Move or resize the selected video, image or text'],
  ['Preview: drag just outside a corner', 'Rotate (Shift: 15° steps)'],
  ['Right-click / Alt+click marker', 'Delete marker'],
  [`Keyframe bar: click / ${MOD}+click / Shift+click`, `Select keyframes (Pan/Crop, Mask); drag moves them, Del deletes, ${MOD}+C / ${MOD}+V copy and paste at the cursor`]
]

// Keyboard map. Key ids are KeyboardEvent.key values (letters lowercase); w = width in key units.

interface MapKey {
  id: string
  label: string
  w?: number
}

const k = (ids: string): MapKey[] => [...ids].map((c) => ({ id: c, label: c.toUpperCase() }))
const fn = (from: number, to: number): MapKey[] =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ id: `F${from + i}`, label: `F${from + i}` }))
const gap = (w: number): MapKey => ({ id: '', label: '', w })

const MAIN_ROWS: MapKey[][] = [
  [{ id: 'Escape', label: 'Esc' }, gap(0.6), ...fn(1, 4), gap(0.4), ...fn(5, 8), gap(0.4), ...fn(9, 12)],
  [...k('`1234567890-='), { id: 'Backspace', label: '⌫', w: 2 }],
  [{ id: 'Tab', label: 'Tab', w: 1.5 }, ...k('qwertyuiop[]'), { id: '\\', label: '\\', w: 1.5 }],
  [{ id: 'CapsLock', label: 'Caps', w: 1.75 }, ...k("asdfghjkl;'"), { id: 'Enter', label: 'Enter', w: 2.25 }],
  [{ id: 'Shift', label: 'Shift', w: 2.25 }, ...k('zxcvbnm,./'), { id: 'Shift', label: 'Shift', w: 2.75 }],
  isMac
    ? [
        { id: 'Control', label: 'Ctrl', w: 1.25 },
        { id: 'Alt', label: '⌥', w: 1.25 },
        { id: 'Meta', label: '⌘', w: 1.5 },
        { id: ' ', label: 'Space', w: 6 },
        { id: 'Meta', label: '⌘', w: 1.5 },
        { id: 'Alt', label: '⌥', w: 1.25 },
        gap(2.25)
      ]
    : [
        { id: 'Control', label: 'Ctrl', w: 1.5 },
        { id: 'Meta', label: 'Win', w: 1.25 },
        { id: 'Alt', label: 'Alt', w: 1.25 },
        { id: ' ', label: 'Space', w: 6.25 },
        { id: 'Alt', label: 'Alt', w: 1.25 },
        gap(1.25),
        { id: 'Control', label: 'Ctrl', w: 1.5 }
      ]
]

const NAV_ROWS: MapKey[][] = [
  [gap(3)],
  [{ id: 'Insert', label: 'Ins' }, { id: 'Home', label: 'Home' }, { id: 'PageUp', label: 'PgUp' }],
  [{ id: 'Delete', label: 'Del' }, { id: 'End', label: 'End' }, { id: 'PageDown', label: 'PgDn' }],
  [gap(3)],
  [gap(1), { id: 'ArrowUp', label: '↑' }, gap(1)],
  [{ id: 'ArrowLeft', label: '←' }, { id: 'ArrowDown', label: '↓' }, { id: 'ArrowRight', label: '→' }]
]

/** The modifier key that is Ctrl in bindings (Cmd on a Mac). */
const CTRL_ID = isMac ? 'Meta' : 'Control'

interface Layer {
  ctrl: boolean
  shift: boolean
  alt: boolean
}

const NO_LAYER: Layer = { ctrl: false, shift: false, alt: false }
const sameLayer = (b: Binding, l: Layer): boolean => !!b.ctrl === l.ctrl && !!b.shift === l.shift && !!b.alt === l.alt
const layerOf = (b: Binding): Layer => ({ ctrl: !!b.ctrl, shift: !!b.shift, alt: !!b.alt })

function Keyboard({
  layer,
  pressed,
  focus,
  onHover
}: {
  layer: Layer
  pressed: string | null
  focus: CommandId | null
  onHover: (id: string | null) => void
}): React.JSX.Element {
  const inLayer = new Map(BINDINGS.filter((b) => sameLayer(b, layer)).map((b) => [b.key, b.command]))
  const held = (id: string): boolean => (id === CTRL_ID && layer.ctrl) || (id === 'Shift' && layer.shift) || (id === 'Alt' && layer.alt)
  const renderRow = (row: MapKey[], i: number): React.JSX.Element => (
    <div key={i} className="kb-row">
      {row.map((key, j) => {
        if (!key.id) return <span key={j} className="kb-gap" style={{ flexGrow: key.w ?? 1 }} />
        const command = inLayer.get(key.id)
        const classes = ['kb-key']
        if (command) classes.push('bound')
        if (command && command === focus) classes.push('focus')
        if (held(key.id)) classes.push('held')
        if (pressed === key.id) classes.push('pressed')
        return (
          <span
            key={j}
            className={classes.join(' ')}
            style={{ flexGrow: key.w ?? 1 }}
            onMouseEnter={() => onHover(key.id)}
            onMouseLeave={() => onHover(null)}
          >
            {key.label}
          </span>
        )
      })}
    </div>
  )
  return (
    <div className="kb">
      <div className="kb-main">{MAIN_ROWS.map(renderRow)}</div>
      <div className="kb-nav">{NAV_ROWS.map(renderRow)}</div>
    </div>
  )
}

/** Help › Keyboard Shortcuts (F1). */
export function ShortcutsWindow(): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<Layer>(NO_LAYER)
  const [heldLayer, setHeldLayer] = useState<Layer>(NO_LAYER)
  // The key that just went down (lit for a moment) and the last shortcut pressed (kept in the info line).
  const [flash, setFlash] = useState<string | null>(null)
  const [last, setLast] = useState<Binding | undefined>(undefined)
  const [hoverKey, setHoverKey] = useState<string | null>(null)
  const [hoverRow, setHoverRow] = useState<Binding | null>(null)

  // Holding Ctrl, Shift or Alt shows that layer; pressed keys light up.
  useEffect(() => {
    let timer = 0
    const sync = (e: KeyboardEvent): void => setHeldLayer({ ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey, alt: e.altKey })
    const down = (e: KeyboardEvent): void => {
      sync(e)
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return
      const key = bindingKey(e)
      const ctrl = e.ctrlKey || e.metaKey
      setFlash(key)
      setLast(BINDINGS.find((b) => b.key === key && !!b.ctrl === ctrl && !!b.shift === e.shiftKey && !!b.alt === e.altKey))
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setFlash(null), 500)
    }
    const up = (e: KeyboardEvent): void => sync(e)
    const blur = (): void => setHeldLayer(NO_LAYER)
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    window.addEventListener('blur', blur)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
      window.removeEventListener('blur', blur)
    }
  }, [])

  const holding = heldLayer.ctrl || heldLayer.shift || heldLayer.alt
  const layer = hoverRow ? layerOf(hoverRow) : holding ? heldLayer : chosen
  const keyBinding = (id: string | null): Binding | undefined => (id ? BINDINGS.find((b) => b.key === id && sameLayer(b, layer)) : undefined)
  // What the info line talks about: a hovered row, a hovered key, or the last key pressed.
  const shown = hoverRow ?? keyBinding(hoverKey) ?? last
  const focus = shown?.command ?? null

  // A key pointed at or pressed brings its row into view.
  const listRef = useRef<HTMLDivElement>(null)
  const scrollTo = (hoverKey ? keyBinding(hoverKey) : last)?.command
  useEffect(() => {
    if (scrollTo) listRef.current?.querySelector(`[data-command="${scrollTo}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [scrollTo, last])

  const groups = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return GROUPS.map((g) => ({
      name: g.name,
      rows: g.commands
        .map((command) => ({ command, bindings: BINDINGS.filter((b) => b.command === command) }))
        .filter((r) => r.bindings.length > 0)
        .filter((r) => {
          const text = `${describeCommand(r.command)} ${r.bindings.map(bindingLabel).join(' ')} ${g.name}`.toLowerCase()
          return words.every((w) => text.includes(w))
        })
    })).filter((g) => g.rows.length > 0)
  }, [query])

  const toggle = (key: keyof Layer): void => setChosen((l) => ({ ...l, [key]: !l[key] }))

  return (
    <FloatingWindow id="shortcuts" className="shortcuts-window" title="Keyboard Shortcuts">
      <div className="modal-body">
        <div className="kb-layers">
          <span className="dim">Show keys with</span>
          {(
            [
              ['ctrl', MOD],
              ['shift', isMac ? '⇧ Shift' : 'Shift'],
              ['alt', ALT]
            ] as const
          ).map(([key, label]) => (
            <button key={key} className={`btn small${layer[key] ? ' active' : ''}`} onClick={() => toggle(key)}>
              {label}
            </button>
          ))}
          <span className="dim kb-tip">or hold them down</span>
        </div>
        <Keyboard layer={layer} pressed={flash} focus={focus} onHover={setHoverKey} />
        <div className="kb-info">
          {shown ? (
            <>
              <span className="kbd-chip">{bindingLabel(shown)}</span> {describeCommand(shown.command)}
            </>
          ) : (
            <span className="dim">Point at a highlighted key, or press any shortcut: it lights up here while it works in the editor.</span>
          )}
        </div>
        <div className="shortcuts-search">
          <Search size={13} className="dim" />
          <input
            className="input"
            placeholder="Search shortcuts"
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && query && (e.stopPropagation(), setQuery(''))}
          />
        </div>
        <div className="shortcuts-list" ref={listRef}>
          {groups.map((g) => (
            <section key={g.name}>
              <h4>{g.name}</h4>
              {g.rows.map((r) => (
                <div
                  key={r.command}
                  data-command={r.command}
                  className={`shortcut-row${focus === r.command ? ' focus' : ''}`}
                  onMouseEnter={() => setHoverRow(r.bindings[0])}
                  onMouseLeave={() => setHoverRow(null)}
                >
                  <span className="shortcut-keys">
                    {r.bindings.map((b) => (
                      <span key={bindingLabel(b)} className="kbd-chip">
                        {bindingLabel(b)}
                      </span>
                    ))}
                  </span>
                  <span>{describeCommand(r.command)}</span>
                </div>
              ))}
            </section>
          ))}
          {groups.length === 0 && <p className="dim">No shortcut matches. {MOD}+F searches every command, with or without a shortcut.</p>}
          {!query && (
            <section>
              <h4>Mouse</h4>
              {MOUSE.map(([keys, text]) => (
                <div key={keys} className="shortcut-row">
                  <span className="shortcut-keys">
                    <span className="kbd-chip">{keys}</span>
                  </span>
                  <span>{text}</span>
                </div>
              ))}
            </section>
          )}
        </div>
        <p className="dim shortcuts-foot">
          Commands without a shortcut are in the menus and in the command search ({MOD}+F).
        </p>
      </div>
    </FloatingWindow>
  )
}

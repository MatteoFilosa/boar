import { useEffect, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import * as A from '../core/actions'
import { AUDIO_FX, VIDEO_FX } from '../core/fx'
import { useEditor } from '../core/store'
import { TEXT_PRESETS } from '../core/text'
import { type CommandId, commands } from './commands'
import { MenuIcon } from './ContextMenu'
import { DOCK_TABS } from './Dock'
import type { Item, Menu } from './MenuBar'
import { shortcutLabel } from './shortcuts'

interface Entry {
  item: Item
  /** Menu, panel or effect category the command belongs to. */
  path: string
  /** Lowercase words searched besides the label and the path. */
  keywords: string
}

/** Other words people may type for a command. */
const KEYWORDS: Partial<Record<CommandId, string>> = {
  render: 'export encode save video mp4 output',
  importMedia: 'add files open video audio image photo',
  properties: 'settings resolution size frame rate fps sample rate',
  split: 'cut razor blade',
  deleteSelection: 'remove erase',
  rippleDelete: 'remove gap close',
  panCrop: 'zoom crop position scale move rotate keyframes',
  editText: 'title font caption',
  insertText: 'title font caption',
  mask: 'shape matte cut out rotoscope track object smart select ai points',
  captions: 'subtitles transcribe transcription speech whisper words',
  removeSilences: 'jump cuts pauses',
  autoDucking: 'music volume lower voice',
  autoReframe: 'vertical portrait shorts crop face 9:16',
  autoZoom: 'punch in face talking head',
  removeBackground: 'green screen cutout person segmentation',
  saveSoundEffect: 'sfx library',
  youtube: 'download link url video',
  aiAgents: 'mcp agent assistant automation',
  fullScreenPreview: 'fullscreen',
  toggleSafeAreas: 'guides overlay',
  toggleLoop: 'repeat',
  toggleSnapping: 'magnet',
  toggleRipple: 'gap',
  shortcuts: 'keys keyboard hotkeys help',
  pasteAttributes: 'copy effects fx pan crop mask style same look apply to all',
  pasteAttributesSelective: 'copy effects fx pan crop mask style same look choose',
  selectionTool: 'select rectangle marquee lasso box drag multiple events',
  normalTool: 'move trim pointer arrow',
  cycleEditTool: 'tool switch select rectangle normal',
  checkForUpdates: 'version update new',
  blurredBackground: 'vertical layout',
  splitScreen: 'layout two',
  pictureInPicture: 'pip layout overlay corner',
  rotateClockwise: 'turn right sideways portrait landscape phone orientation',
  rotateCounterclockwise: 'turn left sideways portrait landscape phone orientation',
  resetRotation: 'turn upright straighten',
  toggleProxies: 'proxy preview scrubbing slow seek optimized media smooth',
  toggleSpaceReturns: 'space bar pause stop playback start position',
  themes: 'theme colors appearance look dark light galaxy skin palette mode white black'
}

/** Commands that have a shortcut or a button but no menu item. */
const EXTRA: { command: CommandId; label: string; path: string; keywords?: string }[] = [
  { command: 'playPause', label: 'Play / Pause', path: 'Transport' },
  { command: 'stop', label: 'Stop', path: 'Transport' },
  { command: 'playFromStart', label: 'Play from Start', path: 'Transport' },
  { command: 'playSelection', label: 'Play Time Selection', path: 'Transport', keywords: 'loop region' },
  { command: 'goToStart', label: 'Go to Start', path: 'Transport' },
  { command: 'goToEnd', label: 'Go to End', path: 'Transport' },
  { command: 'previousFrame', label: 'Previous Frame', path: 'Transport' },
  { command: 'nextFrame', label: 'Next Frame', path: 'Transport' },
  { command: 'previousEditPoint', label: 'Previous Edit Point', path: 'Transport' },
  { command: 'nextEditPoint', label: 'Next Edit Point', path: 'Transport' },
  { command: 'removeFades', label: 'Remove Fades', path: 'Edit', keywords: 'fade in out' }
]

/** Every menu item, plus transport commands, panels, effects and text presets. */
function useEntries(menus: Menu[]): Entry[] {
  return useMemo(() => {
    const entries: Entry[] = []
    const add = (item: Item, path: string, keywords = ''): void => {
      entries.push({ item, path, keywords: `${keywords} ${item.command ? (KEYWORDS[item.command] ?? '') : ''}`.toLowerCase() })
    }
    for (const menu of menus) {
      let parent = ''
      for (const entry of menu.entries) {
        if (entry === 'separator') continue
        // Indented items are the options of the item above them (Auto Ripple modes).
        const nested = entry.label.startsWith(' ')
        if (!nested) parent = entry.label
        add({ ...entry, label: entry.label.trim() }, nested ? `${menu.label} › ${parent}` : menu.label)
      }
    }
    for (const extra of EXTRA) add({ label: extra.label, command: extra.command }, extra.path, extra.keywords)
    for (const tab of DOCK_TABS) add({ label: `${tab.label} Panel`, run: () => A.setDockTab(tab.id) }, 'Window', tab.title)
    // Without a suitable selected event addFx says what to select.
    for (const def of [...VIDEO_FX, ...AUDIO_FX]) {
      add(
        { label: def.label, hint: def.description, run: () => void A.addFx(useEditor.getState().selection, def.type) },
        `${def.kind === 'video' ? 'Video FX' : 'Audio FX'} › ${def.category}`,
        `${def.description} effect filter`
      )
    }
    for (const preset of TEXT_PRESETS) {
      add(
        { label: preset.label, run: () => void A.addTextEvent(preset.id, useEditor.getState().cursor) },
        'Generators › Titles & Text',
        `${preset.description} text title insert`
      )
    }
    return entries
  }, [menus])
}

/** 0 = label starts with the query, 1 = a label word does, 2 = label contains it, 3 = path or keywords; null = no match. */
function rank(entry: Entry, query: string, words: string[]): number | null {
  const label = entry.item.label.toLowerCase()
  const text = `${label} ${entry.path.toLowerCase()} ${entry.keywords}`
  if (!words.every((w) => text.includes(w))) return null
  if (label.startsWith(query)) return 0
  if (!words.every((w) => label.includes(w))) return 3
  return label.split(/[^a-z0-9]+/).some((part) => part.startsWith(words[0])) ? 1 : 2
}

function search(entries: Entry[], query: string): Entry[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const words = q.split(/\s+/)
  return entries
    .map((entry, index) => ({ entry, index, rank: rank(entry, q, words) }))
    .filter((r): r is { entry: Entry; index: number; rank: number } => r.rank !== null)
    .sort((a, b) => a.rank - b.rank || Number(!!a.entry.item.disabled) - Number(!!b.entry.item.disabled) || a.index - b.index)
    .slice(0, 60)
    .map((r) => r.entry)
}

/** Search box in the menu bar: finds and runs any command, option, panel or effect. */
export function CommandSearch({ menus }: { menus: Menu[] }): React.JSX.Element {
  const entries = useEntries(menus)
  const [query, setQuery] = useState('')
  const [focused, setFocused] = useState(false)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const results = useMemo(() => search(entries, query), [entries, query])

  useEffect(() => setActive(0), [query])
  useEffect(() => {
    listRef.current?.querySelector('.menu-item.active')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const run = (entry: Entry | undefined): void => {
    if (!entry || entry.item.disabled) return
    setQuery('')
    inputRef.current?.blur()
    if (entry.item.run) entry.item.run()
    else if (entry.item.command) commands[entry.item.command]()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((a) => (results.length ? (a + step + results.length) % results.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(results[active])
    } else if (e.key === 'Escape') {
      // Not for the window shortcuts: Esc here must not close a floating tool window.
      e.stopPropagation()
      if (query) setQuery('')
      else inputRef.current?.blur()
    }
  }

  const shortcut = shortcutLabel('searchCommands')
  return (
    <div className="command-search">
      <Search size={13} className="command-search-icon" />
      <input
        id="command-search"
        ref={inputRef}
        value={query}
        placeholder={`Search commands and effects${shortcut ? ` (${shortcut})` : ''}`}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={onKeyDown}
      />
      {focused && query.trim() && (
        <div className="menu-popup command-results" ref={listRef} role="listbox">
          {results.length === 0 && <div className="command-empty">No command matches “{query.trim()}”</div>}
          {results.map((entry, i) => (
            <button
              key={`${entry.path}/${entry.item.label}`}
              className={`menu-item${i === active ? ' active' : ''}`}
              disabled={entry.item.disabled}
              title={entry.item.hint}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => i !== active && setActive(i)}
              onClick={() => run(entry)}
            >
              <MenuIcon item={entry.item} />
              <span className="menu-label">{entry.item.label}</span>
              <span className="command-path">{entry.path}</span>
              <span className="menu-shortcut">{entry.item.command ? shortcutLabel(entry.item.command) : ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

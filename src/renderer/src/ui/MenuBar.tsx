import { useEffect, useRef, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { RIPPLE_LABELS, setOption, setRippleMode } from '../core/actions'
import { useEditor, type PreviewQuality } from '../core/store'
import { type CommandId, commands } from './commands'
import { shortcutLabel } from './shortcuts'
import logo from '../assets/logo.png'
import { MenuIcon } from './ContextMenu'
import { CommandSearch } from './CommandSearch'
import { interfaceScaleLabel } from './interfaceScale'

export interface Item {
  label: string
  command?: CommandId
  run?: () => void
  checked?: boolean
  disabled?: boolean
  hint?: string
  icon?: LucideIcon
}

type Entry = Item | 'separator'

export interface Menu {
  label: string
  entries: Entry[]
}

function useMenus(): Menu[] {
  const options = useEditor((s) => s.options)
  const editTool = useEditor((s) => s.editTool)
  const canUndo = useEditor((s) => s.past.length > 0)
  const canRedo = useEditor((s) => s.future.length > 0)
  const hasSelection = useEditor((s) => s.selection.length > 0)
  const hasTimeSelection = useEditor((s) => s.timeSelection !== null)
  const quality = (q: PreviewQuality, label: string): Item => ({
    label,
    checked: options.previewQuality === q,
    run: () => setOption('previewQuality', q)
  })
  return [
    {
      label: 'File',
      entries: [
        { label: 'New', command: 'newProject' },
        { label: 'Open...', command: 'openProject' },
        { label: 'Save', command: 'saveProject' },
        { label: 'Save As...', command: 'saveProjectAs' },
        'separator',
        { label: 'Import Media...', command: 'importMedia' },
        ...(options.linkDownloads ? [{ label: 'Download from Link...', command: 'youtube' } as Item] : []),
        { label: 'Render As...', command: 'render' },
        'separator',
        { label: 'Properties...', command: 'properties' }
      ]
    },
    {
      label: 'Edit',
      entries: [
        { label: 'Undo', command: 'undo', disabled: !canUndo },
        { label: 'Redo', command: 'redo', disabled: !canRedo },
        'separator',
        { label: 'Cut', command: 'cut', disabled: !hasSelection },
        { label: 'Copy', command: 'copy', disabled: !hasSelection },
        { label: 'Paste', command: 'paste' },
        { label: 'Paste Event Attributes', command: 'pasteAttributes', disabled: !hasSelection },
        { label: 'Selectively Paste Event Attributes...', command: 'pasteAttributesSelective', disabled: !hasSelection },
        'separator',
        { label: 'Normal Edit Tool', command: 'normalTool', checked: editTool === 'normal' },
        { label: 'Selection Edit Tool', command: 'selectionTool', checked: editTool === 'select' },
        'separator',
        { label: 'Split', command: 'split' },
        { label: 'Delete', command: 'deleteSelection', disabled: !hasSelection && !hasTimeSelection },
        { label: 'Ripple Delete', command: 'rippleDelete', disabled: !hasSelection && !hasTimeSelection },
        { label: 'Trim to Time Selection', command: 'trimToSelection', disabled: !hasTimeSelection },
        { label: 'Select Events in Time Selection', command: 'selectInTimeSelection', disabled: !hasTimeSelection },
        { label: 'Clear Time Selection', command: 'clearTimeSelection', disabled: !hasTimeSelection },
        { label: 'Select All', command: 'selectAll' },
        'separator',
        { label: 'Group Selected Events', command: 'group', disabled: !hasSelection },
        { label: 'Remove from Group', command: 'ungroup', disabled: !hasSelection }
      ]
    },
    {
      label: 'View',
      entries: [
        { label: 'Zoom In', command: 'zoomIn' },
        { label: 'Zoom Out', command: 'zoomOut' },
        { label: 'Zoom to Fit Project', command: 'zoomFit' },
        { label: 'Zoom to Time Selection', command: 'zoomToSelection', disabled: !hasTimeSelection },
        { label: 'Taller Tracks', command: 'tallerTracks' },
        { label: 'Shorter Tracks', command: 'shorterTracks' },
        'separator',
        { label: 'Bigger Interface', command: 'interfaceBigger' },
        { label: 'Smaller Interface', command: 'interfaceSmaller' },
        {
          label: options.uiScale === 1 ? 'Reset Interface Size' : `Reset Interface Size (${interfaceScaleLabel(options.uiScale)})`,
          command: 'interfaceReset'
        },
        'separator',
        quality('draft', 'Preview Quality: Draft (1/4)'),
        quality('preview', 'Preview Quality: Preview (1/2)'),
        quality('good', 'Preview Quality: Good (Full)'),
        quality('best', 'Preview Quality: Best (Full)'),
        'separator',
        { label: 'Safe Areas Overlay', command: 'toggleSafeAreas', checked: options.safeAreas },
        { label: 'Full Screen Preview', command: 'fullScreenPreview' }
      ]
    },
    {
      label: 'Insert',
      entries: [
        { label: 'Video Track', command: 'addVideoTrack' },
        { label: 'Audio Track', command: 'addAudioTrack' },
        'separator',
        { label: 'Marker', command: 'addMarker' },
        { label: 'Text Media', command: 'insertText' }
      ]
    },
    {
      label: 'Tools',
      entries: [
        { label: 'Event Pan/Crop...', command: 'panCrop', disabled: !hasSelection },
        { label: 'Edit Text...', command: 'editText', disabled: !hasSelection },
        { label: 'Event Mask...', command: 'mask', disabled: !hasSelection },
        { label: 'Video FX...', command: 'videoFx', disabled: !hasSelection },
        { label: 'Audio FX...', command: 'audioFx', disabled: !hasSelection },
        { label: 'Fill Frame (crop to project aspect)', command: 'fillFrame' },
        { label: 'Fit Frame (show whole source)', command: 'fitFrame' },
        { label: 'Rotate 90° Clockwise', command: 'rotateClockwise', disabled: !hasSelection },
        { label: 'Rotate 90° Counterclockwise', command: 'rotateCounterclockwise', disabled: !hasSelection },
        { label: 'Reset Rotation', command: 'resetRotation', disabled: !hasSelection },
        { label: 'Reverse (play backwards)', command: 'reverse', disabled: !hasSelection },
        { label: 'Layout: Blurred Background', command: 'blurredBackground', disabled: !hasSelection },
        { label: 'Layout: Split Screen (top/bottom)', command: 'splitScreen', disabled: !hasSelection },
        { label: 'Layout: Picture in Picture', command: 'pictureInPicture', disabled: !hasSelection },
        'separator',
        { label: 'Save as Sound Effect...', command: 'saveSoundEffect', disabled: !hasSelection },
        { label: 'Remove Silences (jump cuts)...', command: 'removeSilences', disabled: !hasSelection },
        { label: 'Auto Ducking (music under voice)...', command: 'autoDucking' },
        { label: 'Generate Captions (Whisper)...', command: 'captions' },
        { label: 'Highlight Key Words in Captions', command: 'highlightKeywords' },
        { label: 'Add Emoji to Captions', command: 'addEmoji' },
        { label: 'Auto Reframe 9:16 (follow the face)...', command: 'autoReframe' },
        { label: 'Auto Zoom (punch-in on talking heads)...', command: 'autoZoom' },
        { label: 'Remove Background (AI)', command: 'removeBackground', disabled: !hasSelection }
      ]
    },
    {
      label: 'Options',
      entries: [
        { label: 'Enable Snapping', command: 'toggleSnapping', checked: options.snapping },
        { label: 'Automatic Crossfades', command: 'toggleCrossfades', checked: options.autoCrossfade },
        { label: 'Quantize to Frames', command: 'toggleQuantize', checked: options.quantize },
        { label: 'Loop Playback', command: 'toggleLoop', checked: options.loop },
        { label: 'Space Returns to the Start Position', command: 'toggleSpaceReturns', checked: options.spaceReturns },
        { label: 'Captions Follow Clip Edits', command: 'toggleLinkedCaptions', checked: options.linkedCaptions },
        'separator',
        { label: 'AI Agents (MCP)...', command: 'aiAgents' },
        { label: 'Download from Link (yt-dlp, optional)', command: 'toggleLinkDownloads', checked: options.linkDownloads },
        { label: 'Check for Updates at Startup', command: 'toggleUpdateCheck', checked: options.checkUpdates },
        { label: 'Proxies for Videos Slow to Seek', command: 'toggleProxies', checked: options.proxies },
        { label: 'Themes...', command: 'themes' },
        { label: 'Celebrate Finished Tasks', command: 'toggleCelebrations', checked: options.celebrations },
        'separator',
        { label: 'Auto Ripple', command: 'toggleRipple', checked: options.autoRipple },
        ...(['tracks', 'tracksMarkers', 'all'] as const).map(
          (mode): Item => ({
            label: `   ${RIPPLE_LABELS[mode]}`,
            checked: options.autoRipple && options.rippleMode === mode,
            run: () => setRippleMode(mode)
          })
        )
      ]
    },
    {
      label: 'Help',
      entries: [
        { label: 'Search Commands...', command: 'searchCommands' },
        { label: 'Keyboard Shortcuts', command: 'shortcuts' },
        ...(import.meta.env.DEV ? [{ label: 'Load Demo Media', command: 'loadDemoMedia' } as Item] : []),
        'separator',
        { label: 'Check for Updates...', command: 'checkForUpdates' },
        { label: 'About Boar', command: 'about' }
      ]
    }
  ]
}

export function MenuBar(): React.JSX.Element {
  const menus = useMenus()
  const [open, setOpen] = useState<number | null>(null)
  const barRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open === null) return
    const close = (e: PointerEvent): void => {
      if (!barRef.current?.contains(e.target as Node)) setOpen(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(null)
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const run = (item: Item): void => {
    if (item.disabled) return
    setOpen(null)
    if (item.run) item.run()
    else if (item.command) commands[item.command]()
  }

  return (
    <div className="menubar" ref={barRef}>
      {menus.map((menu, i) => (
        <div key={menu.label} className="menu">
          <button
            className={`menu-title${open === i ? ' open' : ''}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setOpen(open === i ? null : i)}
            onMouseEnter={() => open !== null && setOpen(i)}
          >
            {menu.label}
          </button>
          {open === i && (
            <div className="menu-popup">
              {menu.entries.map((entry, j) =>
                entry === 'separator' ? (
                  <div key={`sep-${j}`} className="menu-sep" />
                ) : (
                  <button
                    key={entry.label}
                    className="menu-item"
                    disabled={entry.disabled}
                    title={entry.hint}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => run(entry)}
                  >
                    <MenuIcon item={entry} />
                    <span className="menu-label">{entry.label}</span>
                    <span className="menu-shortcut">{entry.command ? shortcutLabel(entry.command) : ''}</span>
                  </button>
                )
              )}
            </div>
          )}
        </div>
      ))}
      <CommandSearch menus={menus} />
      <div className="menubar-title">
        <img src={logo} alt="" />
        Boar
      </div>
    </div>
  )
}

import { useEffect } from 'react'
import { closeDialog } from '../core/actions'
import { useEditor } from '../core/store'
import { type CommandId, commands } from './commands'
import { isPreviewFullScreen, toggleFullScreenPreview } from './fullScreen'
import { isMac } from '../platform'

export interface Binding {
  key: string
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
  command: CommandId
}

/** Default key bindings. `key` is KeyboardEvent.key, lowercased for letters. */
export const BINDINGS: Binding[] = [
  { key: ' ', command: 'playStop' },
  { key: 'Enter', command: 'playPause' },
  { key: 'Enter', alt: true, command: 'properties' },
  { key: 'l', command: 'play' },
  { key: 'k', command: 'pause' },
  { key: 'j', command: 'backOneSecond' },
  { key: 's', command: 'split' },
  { key: 'Delete', command: 'deleteSelection' },
  { key: 'Delete', shift: true, command: 'rippleDelete' },
  { key: 't', ctrl: true, command: 'trimToSelection' },
  { key: 'l', ctrl: true, command: 'toggleRipple' },
  { key: 'Escape', command: 'clearTimeSelection' },
  { key: 'c', ctrl: true, command: 'copy' },
  { key: 'x', ctrl: true, command: 'cut' },
  { key: 'v', ctrl: true, command: 'paste' },
  { key: 'v', ctrl: true, shift: true, command: 'pasteAttributes' },
  { key: 'd', ctrl: true, command: 'cycleEditTool' },
  { key: 'Backspace', command: 'deleteSelection' },
  { key: 'z', ctrl: true, command: 'undo' },
  { key: 'y', ctrl: true, command: 'redo' },
  { key: 'z', ctrl: true, shift: true, command: 'redo' },
  { key: 'a', ctrl: true, command: 'selectAll' },
  { key: 'g', command: 'group' },
  { key: 'u', command: 'ungroup' },
  { key: 'm', command: 'addMarker' },
  { key: 'q', command: 'toggleLoop' },
  { key: 'f', command: 'fullScreenPreview' },
  { key: 'F11', command: 'fullScreenPreview' },
  { key: 'F8', command: 'toggleSnapping' },
  { key: 'F8', alt: true, command: 'toggleQuantize' },
  { key: 'x', ctrl: true, shift: true, command: 'toggleCrossfades' },
  { key: 'q', ctrl: true, shift: true, command: 'addVideoTrack' },
  { key: 'q', ctrl: true, command: 'addAudioTrack' },
  { key: 'i', ctrl: true, command: 'importMedia' },
  { key: 'n', ctrl: true, command: 'newProject' },
  { key: 'o', ctrl: true, command: 'openProject' },
  { key: 's', ctrl: true, command: 'saveProject' },
  { key: 's', ctrl: true, shift: true, command: 'saveProjectAs' },
  { key: 'm', ctrl: true, command: 'render' },
  { key: 'f', ctrl: true, command: 'searchCommands' },
  { key: 'F1', command: 'shortcuts' },
  { key: 'r', ctrl: true, command: 'rotateClockwise' },
  { key: 'r', ctrl: true, shift: true, command: 'rotateCounterclockwise' },
  { key: 'Home', command: 'goToStart' },
  { key: 'End', command: 'goToEnd' },
  { key: 'ArrowLeft', command: 'previousFrame' },
  { key: 'ArrowRight', command: 'nextFrame' },
  { key: 'ArrowLeft', ctrl: true, command: 'previousEditPoint' },
  { key: 'ArrowRight', ctrl: true, command: 'nextEditPoint' },
  { key: 'ArrowUp', command: 'zoomIn' },
  { key: 'ArrowDown', command: 'zoomOut' }
]

export function shortcutLabel(command: CommandId): string {
  const binding = BINDINGS.find((b) => b.command === command)
  return binding ? bindingLabel(binding) : ''
}

/** "Ctrl+Shift+S", or "⇧⌘S" on a Mac. */
export function bindingLabel(binding: Binding): string {
  const names: Record<string, string> = {
    ' ': 'Space',
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    ArrowDown: '↓'
  }
  const key = names[binding.key] ?? (binding.key.length === 1 ? binding.key.toUpperCase() : binding.key)
  if (isMac) return [binding.alt && '⌥', binding.shift && '⇧', binding.ctrl && '⌘', key].filter(Boolean).join('')
  return [binding.ctrl && 'Ctrl', binding.alt && 'Alt', binding.shift && 'Shift', key].filter(Boolean).join('+')
}

const FLOATING_ALLOWED = new Set<CommandId>([
  'playStop',
  'playPause',
  'play',
  'pause',
  'previousFrame',
  'nextFrame',
  'undo',
  'redo',
  'fullScreenPreview'
])

/** The full screen preview is for watching: playback, navigation and markers only. */
const FULL_SCREEN_ALLOWED = new Set<CommandId>([
  ...FLOATING_ALLOWED,
  'backOneSecond',
  'previousEditPoint',
  'nextEditPoint',
  'goToStart',
  'goToEnd',
  'toggleLoop',
  'addMarker'
])

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true
  return target.tagName === 'INPUT' && (target as HTMLInputElement).type !== 'range'
}

export function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const { dialog, exporting } = useEditor.getState()
      if (exporting) return
      const full = isPreviewFullScreen()
      if (full && e.key === 'Escape') {
        e.preventDefault()
        toggleFullScreenPreview()
        return
      }
      if (dialog && e.key === 'Escape') {
        closeDialog()
        return
      }
      if (isTyping(e.target)) return
      // Floating tool windows (Pan/Crop) keep transport keys; modal dialogs block everything.
      const floating = dialog?.kind === 'panCrop' || dialog?.kind === 'text' || dialog?.kind === 'mask' || dialog?.kind === 'fx' || dialog?.kind === 'transition' || dialog?.kind === 'silence' || dialog?.kind === 'youtube' || dialog?.kind === 'themes' || dialog?.kind === 'shortcuts'
      if (dialog && !floating) return
      // The shortcuts window is a legend to keep open while editing: every key works.
      const allowed = full ? FULL_SCREEN_ALLOWED : floating && dialog?.kind !== 'shortcuts' ? FLOATING_ALLOWED : null
      // Sliders keep their arrow keys.
      if (e.target instanceof HTMLInputElement && e.key.startsWith('Arrow')) return
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
      const ctrl = e.ctrlKey || e.metaKey
      const binding = BINDINGS.find(
        (b) => b.key === key && !!b.ctrl === ctrl && !!b.shift === e.shiftKey && !!b.alt === e.altKey
      )
      if (!binding || (allowed && !allowed.has(binding.command))) return
      e.preventDefault()
      commands[binding.command]()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}

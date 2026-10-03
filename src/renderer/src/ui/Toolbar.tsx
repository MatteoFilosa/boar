import {
  Blend,
  Clapperboard,
  FilePlus2,
  FolderOpen,
  FolderInput,
  Magnet,
  MousePointer2,
  Redo2,
  Save,
  Scissors,
  Settings2,
  Trash2,
  Undo2,
  type LucideIcon
} from 'lucide-react'
import { useEditor } from '../core/store'
import { type CommandId, commands } from './commands'
import { RippleButton } from './RippleButton'
import { shortcutLabel } from './shortcuts'

interface ToolButtonProps {
  icon: LucideIcon
  title: string
  command?: CommandId
  active?: boolean
  disabled?: boolean
  /** Transport color: green play, amber pause, red stop. */
  tone?: 'play' | 'pause' | 'stop'
}

export function ToolButton({ icon: Icon, title, command, active, disabled, tone }: ToolButtonProps): React.JSX.Element {
  const shortcut = command ? shortcutLabel(command) : ''
  return (
    <button
      className={`tool-btn${tone ? ` tone-${tone}` : ''}${active ? ' active' : ''}`}
      title={shortcut ? `${title} (${shortcut})` : title}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => command && commands[command]()}
    >
      <Icon size={16} strokeWidth={1.75} />
    </button>
  )
}

export function Toolbar(): React.JSX.Element {
  const options = useEditor((s) => s.options)
  const canUndo = useEditor((s) => s.past.length > 0)
  const canRedo = useEditor((s) => s.future.length > 0)
  const hasSelection = useEditor((s) => s.selection.length > 0)
  return (
    <div className="toolbar">
      <ToolButton icon={FilePlus2} title="New project" command="newProject" />
      <ToolButton icon={FolderOpen} title="Open project" command="openProject" />
      <ToolButton icon={Save} title="Save project" command="saveProject" />
      <ToolButton icon={Clapperboard} title="Render As" command="render" />
      <ToolButton icon={FolderInput} title="Import media" command="importMedia" />
      <div className="tool-sep" />
      <ToolButton icon={Undo2} title="Undo" command="undo" disabled={!canUndo} />
      <ToolButton icon={Redo2} title="Redo" command="redo" disabled={!canRedo} />
      <div className="tool-sep" />
      <ToolButton icon={MousePointer2} title="Normal edit tool" active />
      <ToolButton icon={Scissors} title="Split at cursor" command="split" />
      <ToolButton icon={Trash2} title="Delete selected events" command="deleteSelection" disabled={!hasSelection} />
      <div className="tool-sep" />
      <ToolButton icon={Magnet} title="Enable snapping" command="toggleSnapping" active={options.snapping} />
      <ToolButton
        icon={Blend}
        title="Automatic crossfades"
        command="toggleCrossfades"
        active={options.autoCrossfade}
      />
      <RippleButton />
      <div className="tool-sep" />
      <ToolButton icon={Settings2} title="Project properties" command="properties" />
    </div>
  )
}

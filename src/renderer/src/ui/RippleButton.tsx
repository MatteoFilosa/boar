import { ChevronDown, WrapText } from 'lucide-react'
import * as A from '../core/actions'
import { useEditor, type RippleMode } from '../core/store'
import { openContextMenu } from './ContextMenu'
import { shortcutLabel } from './shortcuts'

const MODES: RippleMode[] = ['tracks', 'tracksMarkers', 'all']

/** Auto Ripple toggle with its mode dropdown. */
export function RippleButton({ placement = 'below' }: { placement?: 'below' | 'above' }): React.JSX.Element {
  const on = useEditor((s) => s.options.autoRipple)
  const mode = useEditor((s) => s.options.rippleMode)
  return (
    <div className="split-btn">
      <button
        className={`tool-btn${on ? ' active' : ''}`}
        title={`Auto Ripple (${shortcutLabel('toggleRipple')}): ${on ? A.RIPPLE_LABELS[mode] : 'off'}\nDeleting, cutting or pasting closes/opens the gap automatically.`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => A.toggleOption('autoRipple')}
      >
        <WrapText size={16} strokeWidth={1.75} />
      </button>
      <button
        className={`tool-btn split-btn-arrow${on ? ' active' : ''}`}
        title="Auto Ripple mode"
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          openContextMenu(
            r.left,
            placement === 'above' ? r.top - 2 : r.bottom + 2,
            [
              ...MODES.map((m) => ({ label: A.RIPPLE_LABELS[m], checked: on && m === mode, run: () => A.setRippleMode(m) })),
              'separator' as const,
              { label: 'Auto Ripple off', checked: !on, run: () => A.setOption('autoRipple', false) }
            ],
            placement
          )
        }}
      >
        <ChevronDown size={12} />
      </button>
    </div>
  )
}

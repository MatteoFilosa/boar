import { useCallback, useEffect, useRef, useState } from 'react'
import { mediaById, useEditor } from '../core/store'
import { formatTimecode, rateLabel } from '../core/time'
import { presetById } from '../core/text'
import { RIPPLE_LABELS } from '../core/actions'
import { useMediaDrag } from './mediaDrag'
import { fxDef } from '../core/fx'
import { transitionDef } from '../core/transitions'

/** Ghost that follows the pointer while media is dragged from Project Media. */
export function MediaDragGhost(): React.JSX.Element | null {
  const drag = useMediaDrag((s) => s.drag)
  if (!drag) return null
  const media = mediaById(drag.mediaId)
  const preset = drag.mediaId.startsWith('text:') ? presetById(drag.mediaId.slice(5)) : undefined
  const fx = drag.mediaId.startsWith('fx:') ? fxDef(drag.mediaId.slice(3)) : undefined
  const transition = drag.mediaId.startsWith('tr:') ? transitionDef(drag.mediaId.slice(3)) : undefined
  const path = drag.mediaId.startsWith('path:') ? drag.mediaId.slice(5).split(/[\\/]/).pop() : undefined
  return (
    <div className="drag-ghost" style={{ left: drag.x + 12, top: drag.y + 10 }}>
      {media?.poster ? <img src={media.poster} alt="" /> : null}
      <span>
        {preset
          ? `Text: ${preset.label}`
          : fx
            ? `${fx.kind === 'video' ? 'Video' : 'Audio'} FX: ${fx.label}`
            : transition
              ? `Transition: ${transition.label}`
              : (path ?? media?.name)}
      </span>
    </div>
  )
}

export function StatusBar(): React.JSX.Element {
  const status = useEditor((s) => s.status)
  const analyzing = useEditor((s) => s.media.filter((m) => m.status === 'analyzing').length)
  const settings = useEditor((s) => s.project.settings)
  const options = useEditor((s) => s.options)
  const range = useEditor((s) => s.timeSelection)
  return (
    <div className="statusbar">
      <span className="status-msg">{status}</span>
      {range && (
        <span className="status-pill on" title="Time selection (Esc to clear)">
          Sel {formatTimecode(range.start, settings.frameRate)} – {formatTimecode(range.end, settings.frameRate)} (
          {formatTimecode(range.end - range.start, settings.frameRate)})
        </span>
      )}
      {analyzing > 0 && <span className="status-pill">Analyzing {analyzing}…</span>}
      <span className={`status-pill${options.snapping ? ' on' : ''}`}>Snap</span>
      <span className={`status-pill${options.autoCrossfade ? ' on' : ''}`}>X-fade</span>
      <span className={`status-pill${options.quantize ? ' on' : ''}`}>Frames</span>
      <span
        className={`status-pill${options.autoRipple ? ' on' : ''}`}
        title={options.autoRipple ? `Auto Ripple: ${RIPPLE_LABELS[options.rippleMode]}` : 'Auto Ripple off'}
      >
        Ripple{options.autoRipple ? (options.rippleMode === 'all' ? ' · all' : options.rippleMode === 'tracksMarkers' ? ' · tracks+M' : ' · tracks') : ''}
      </span>
      <span className="status-format">
        {settings.width}x{settings.height} · {rateLabel(settings.frameRate)} fps · {settings.sampleRate / 1000} kHz
      </span>
    </div>
  )
}

/** Draggable divider between two panes. Sizes are remembered per window. */
export function useSplit(
  key: string,
  initial: number,
  min: number,
  max: number
): [number, (e: React.PointerEvent, axis: 'x' | 'y', invert?: boolean) => void] {
  const [size, setSize] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(`boar.split.${key}`))
      return saved >= min && saved <= max ? saved : initial
    } catch {
      return initial
    }
  })
  const sizeRef = useRef(size)
  sizeRef.current = size

  useEffect(() => {
    try {
      localStorage.setItem(`boar.split.${key}`, String(size))
    } catch {
      // Storage unavailable: layout simply resets next time.
    }
  }, [key, size])

  const start = useCallback(
    (e: React.PointerEvent, axis: 'x' | 'y', invert = false) => {
      e.preventDefault()
      const origin = axis === 'x' ? e.clientX : e.clientY
      const startSize = sizeRef.current
      const move = (ev: PointerEvent): void => {
        const delta = (axis === 'x' ? ev.clientX : ev.clientY) - origin
        setSize(Math.max(min, Math.min(max, startSize + (invert ? -delta : delta))))
      }
      const up = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        document.body.classList.remove('resizing')
      }
      document.body.classList.add('resizing')
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [min, max]
  )
  return [size, start]
}

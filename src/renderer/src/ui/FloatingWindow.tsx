import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import * as A from '../core/actions'

interface Props {
  /** Key under which the position is remembered. */
  id: string
  title: string
  className: string
  children: React.ReactNode
  ariaLabel?: string
}

interface Point {
  x: number
  y: number
}

const storageKey = (id: string): string => `boar.window.${id}`

function loadPosition(id: string): Point | null {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(id)) ?? 'null') as Point | null
    return saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) ? saved : null
  } catch {
    return null
  }
}

function savePosition(id: string, p: Point): void {
  try {
    localStorage.setItem(storageKey(id), JSON.stringify(p))
  } catch {
    // Storage unavailable: the window opens at its default spot next time.
  }
}

/** Keeps at least a grabbable part of the title bar on screen. */
function clampToViewport(p: Point, width: number): Point {
  return {
    x: Math.min(window.innerWidth - 80, Math.max(80 - width, p.x)),
    y: Math.min(window.innerHeight - 40, Math.max(0, p.y))
  }
}

/** Non-modal tool window, moved by dragging its title bar. */
export function FloatingWindow({ id, title, className, children, ariaLabel }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<Point | null>(() => loadPosition(id))
  const posRef = useRef(pos)
  posRef.current = pos

  // First open: switch from the CSS default position to explicit coordinates.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos((current) => clampToViewport(current ?? { x: r.left, y: r.top }, r.width))
  }, [])

  useEffect(() => {
    const onResize = (): void => {
      const el = ref.current
      if (el && posRef.current) setPos(clampToViewport(posRef.current, el.offsetWidth))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const startDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, input, select, textarea')) return
    const el = ref.current
    if (!el) return
    e.preventDefault()
    const r = el.getBoundingClientRect()
    const dx = e.clientX - r.left
    const dy = e.clientY - r.top
    document.body.classList.add('moving-window')
    // The latest point, saved on release even if React has not rendered it yet.
    let last: Point | null = null
    const move = (ev: PointerEvent): void => {
      last = clampToViewport({ x: ev.clientX - dx, y: ev.clientY - dy }, r.width)
      setPos(last)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      document.body.classList.remove('moving-window')
      const p = last ?? posRef.current
      if (p) savePosition(id, p)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  return (
    <div
      ref={ref}
      className={`floating-window ${className}`}
      style={pos ? { left: pos.x, top: pos.y, bottom: 'auto' } : undefined}
      role="dialog"
      aria-label={ariaLabel ?? title}
    >
      <div className="modal-title window-title" onPointerDown={startDrag} title="Drag to move">
        <span>{title}</span>
        <button className="tool-btn" title="Close (Esc)" onClick={A.closeDialog}>
          <X size={14} />
        </button>
      </div>
      {children}
    </div>
  )
}

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { bridge } from '../platform'
import { burstConfetti, celebrationsOn } from './confetti'

interface Props {
  /** 0..1, or null while the length of the task is unknown (the boar runs back and forth). */
  value: number | null
  /** Task finished: the boar reaches the flag, hops and fires confetti. */
  done?: boolean
  /** Caption under the bar. */
  children?: React.ReactNode
  className?: string
}

/** Running boar: a gallop drawn in SVG, colors, legs and tail animated in CSS. */
function BoarSprite(): React.JSX.Element {
  const leg = (x: number, cls: string): React.JSX.Element => (
    <g transform={`translate(${x} 46)`}>
      <g className={`boar-leg ${cls}`}>
        <path d="M -4.5 0 L 4.5 0 L 2.6 18 L -2.6 18 Z" />
        <path d="M -3 17 L 3 17 L 3.6 21 L -3 21 Z" />
      </g>
    </g>
  )
  return (
    <svg className="boar-sprite" viewBox="0 0 120 72" aria-hidden="true">
      <g className="boar-dust">
        <circle cx="22" cy="66" r="3" />
        <circle cx="22" cy="66" r="3" />
        <circle cx="22" cy="66" r="3" />
      </g>
      <g className="boar-body">
        <g className="boar-shade">
          {leg(28, 'hind-far')}
          {leg(70, 'front-far')}
          <path d="M 40 19 L 44 9 L 49 16 L 53 6 L 58 13 L 62 4 L 67 11 L 71 4 L 75 11 L 80 7 L 82 15 L 86 12 L 88 19 Z" />
        </g>
        <path className="boar-tail" d="M 19 30 C 12 27 10 33 14 35" />
        <g className="boar-coat">
          <path d="M 18 36 C 16 26 24 19 38 18 C 48 17 56 12 66 11 C 76 10 84 14 90 20 C 96 25 102 31 108 35 C 112 37 114 40 113 44 C 112 47 108 48 104 48 C 98 48 93 51 88 51 C 82 52 76 52 72 51 C 60 53 44 53 32 51 C 24 50 19 45 18 36 Z" />
          {leg(36, 'hind-near')}
          {leg(78, 'front-near')}
        </g>
        <path className="boar-shade" d="M 84 18 L 88 6 L 93 20 Z" />
        <ellipse className="boar-snout" cx="113" cy="42" rx="2.4" ry="4.2" />
        <path className="boar-tusk" d="M 100 47 C 104 46 108 42 107 36 C 105 40 103 43 99 44 Z" />
        <ellipse className="boar-eye" cx="96" cy="27" rx="2.2" ry="1.7" />
      </g>
    </svg>
  )
}

/** Where the last progress bar was on screen, for celebrate() once its window has closed. */
let lastBar: { element: HTMLElement; rect: DOMRect; value: number; removedAt?: number } | null = null

/** The finish: a pop of confetti at the flag, then a second one from the boar as it hops. */
function fireConfetti(track: HTMLElement): void {
  const flag = track.querySelector('.boar-flag')?.getBoundingClientRect()
  const boar = track.querySelector('.boar-runner')?.getBoundingClientRect()
  if (!flag || flag.width + flag.height === 0) return
  burstConfetti(flag.left + 6, flag.top, { count: 70, angle: -8, spread: 80 })
  if (boar) window.setTimeout(() => burstConfetti(boar.left + boar.width * 0.55, boar.top + 6, { count: 60, angle: -28, spread: 60, speed: 800 }), 170)
}

/** The bar itself: track, dug-up trail, flag and the boar. */
function BoarTrack({ value, done }: { value: number | null; done: boolean }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  // Done: the boar first runs the last stretch to the flag (a frame later, so the move animates).
  const [arrived, setArrived] = useState(false)
  const finished = done && arrived
  const p = finished ? 1 : value === null ? (done ? 0.9 : null) : Math.min(1, Math.max(0, value))

  useLayoutEffect(() => {
    if (ref.current && !done) lastBar = { element: ref.current, rect: ref.current.getBoundingClientRect(), value: p ?? 0.9 }
  })
  useEffect(() => {
    const element = ref.current
    return () => {
      if (lastBar && lastBar.element === element) lastBar.removedAt = performance.now()
    }
  }, [])
  useEffect(() => {
    setArrived(false)
    if (!done) return
    let frame = requestAnimationFrame(() => (frame = requestAnimationFrame(() => setArrived(true))))
    return () => cancelAnimationFrame(frame)
  }, [done])
  useEffect(() => {
    if (!finished || !celebrationsOn()) return
    const timer = window.setTimeout(() => ref.current && fireConfetti(ref.current), 260)
    return () => window.clearTimeout(timer)
  }, [finished])

  return (
    <div
      ref={ref}
      className={`boar-track${finished ? ' done' : ''}${p === null ? ' indeterminate' : ''}`}
      style={{ '--p': p ?? 0 } as React.CSSProperties}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={p === null ? undefined : Math.round(p * 100)}
    >
      <div className="boar-trail" />
      <div className="boar-flag" />
      <div className="boar-runner">
        <BoarSprite />
      </div>
    </div>
  )
}

/**
 * Progress bar of every long task (render, captions, downloads, analysis): the
 * boar runs toward the flag and the dug-up trail behind it is the bar. It also
 * shows on the taskbar button.
 */
export function BoarProgress({ value, done = false, children, className }: Props): React.JSX.Element {
  const p = value === null ? null : Math.min(1, Math.max(0, value))

  useEffect(() => {
    if (!bridge) return
    bridge.setProgress(done ? -1 : (p ?? 2))
  }, [p, done])
  useEffect(() => () => bridge?.setProgress(-1), [])

  return (
    <div className={`render-progress${className ? ` ${className}` : ''}`}>
      <BoarTrack value={p} done={done} />
      {children && <div className="dim">{children}</div>}
    </div>
  )
}

// Windows that close when their task is done call celebrate(): the bar stays a
// moment where it was, as a small card, while the boar reaches the flag.

interface Finish {
  id: number
  left: number
  top: number
  width: number
  /** Where the boar was: it runs from there to the flag. */
  value: number
  label: string
}

const CARD_MS = 2800
let finishes: Finish[] = []
let nextFinish = 1
const finishListeners = new Set<() => void>()

function setFinishes(list: Finish[]): void {
  finishes = list
  for (const listener of finishListeners) listener()
}

/** A task shown by a progress bar finished: the boar crosses the line where the bar was. */
export function celebrate(label = ''): void {
  if (!lastBar || !celebrationsOn()) return
  // The bar of this task: still on screen, or gone a moment ago (not one from an earlier task).
  const shown = lastBar.element.isConnected
  if (!shown && performance.now() - (lastBar.removedAt ?? -Infinity) > 1500) return
  const rect = shown ? lastBar.element.getBoundingClientRect() : lastBar.rect
  if (rect.width < 80) return
  const finish: Finish = { id: nextFinish++, left: rect.left, top: rect.top, width: rect.width, value: Math.min(0.97, lastBar.value), label }
  setFinishes([...finishes, finish])
  window.setTimeout(() => setFinishes(finishes.filter((f) => f !== finish)), CARD_MS)
}

const subscribe = (listener: () => void): (() => void) => {
  finishListeners.add(listener)
  return () => finishListeners.delete(listener)
}

/** Cards of celebrate(), above every window (mounted once in App). */
export function CelebrationLayer(): React.JSX.Element | null {
  const list = useSyncExternalStore(subscribe, () => finishes)
  if (list.length === 0) return null
  return (
    <>
      {list.map((f) => (
        <div key={f.id} className="boar-finish" style={{ left: f.left - 12, top: f.top - 8, width: f.width + 24 }} aria-live="polite">
          <BoarTrack value={f.value} done />
          {f.label && <div className="boar-finish-label">{f.label}</div>}
        </div>
      ))}
    </>
  )
}

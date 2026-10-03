import { useEffect } from 'react'
import { bridge } from '../platform'

interface Props {
  /** 0..1, or null while the length of the task is unknown (the boar runs back and forth). */
  value: number | null
  /** Task finished: the boar stands at the flag. */
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
      <div
        className={`boar-track${done ? ' done' : ''}${p === null ? ' indeterminate' : ''}`}
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
      {children && <div className="dim">{children}</div>}
    </div>
  )
}

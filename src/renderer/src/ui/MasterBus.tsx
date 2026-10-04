import { useEffect, useRef } from 'react'
import { setOption } from '../core/actions'
import { useEditor } from '../core/store'
import { getEngine } from '../engine/preview'
import { themeColor } from './themes'

const MIN_DB = -60
const SCALE = [0, -6, -12, -18, -24, -36, -48]

const toDb = (v: number): number => (v <= 0.000001 ? -Infinity : 20 * Math.log10(v))
const dbToFraction = (db: number): number => Math.max(0, Math.min(1, (db - MIN_DB) / -MIN_DB))

/** Master bus: stereo peak meters and master volume. */
export function MasterBus(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const masterDb = useEditor((s) => s.options.masterDb)
  const peakHold = useRef<[number, number]>([MIN_DB, MIN_DB])

  useEffect(() => {
    let raf = 0
    const draw = (): void => {
      raf = requestAnimationFrame(draw)
      const canvas = canvasRef.current
      if (!canvas) return
      const dpr = window.devicePixelRatio || 1
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
      }
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      const meter = getEngine().meter
      const barW = 11
      const gap = 4
      const left = w - (barW * 2 + gap) - 4
      const top = 6
      const height = h - 12
      ctx.font = '9px "Segoe UI", system-ui, sans-serif'
      ctx.textAlign = 'right'
      ctx.textBaseline = 'middle'
      for (const db of SCALE) {
        const y = top + height * (1 - dbToFraction(db))
        ctx.fillStyle = themeColor('text-faint')
        ctx.fillText(String(db), left - 4, y)
        ctx.fillStyle = 'rgba(255,255,255,0.08)'
        ctx.fillRect(left, Math.round(y), barW * 2 + gap, 1)
      }
      for (let c = 0; c < 2; c++) {
        const x = left + c * (barW + gap)
        ctx.fillStyle = themeColor('well')
        ctx.fillRect(x, top, barW, height)
        const db = toDb(meter[c])
        const fraction = dbToFraction(db)
        const grad = ctx.createLinearGradient(0, top + height, 0, top)
        grad.addColorStop(0, '#2fbf5b')
        grad.addColorStop(0.7, '#2fbf5b')
        grad.addColorStop(0.85, '#e3c13b')
        grad.addColorStop(1, '#ec4b4b')
        ctx.fillStyle = grad
        ctx.fillRect(x, top + height * (1 - fraction), barW, height * fraction)
        peakHold.current[c] = Math.max(db, peakHold.current[c] - 0.4)
        const holdY = top + height * (1 - dbToFraction(peakHold.current[c]))
        if (peakHold.current[c] > MIN_DB) {
          ctx.fillStyle = '#f0f0f0'
          ctx.fillRect(x, Math.round(holdY), barW, 1)
        }
      }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className="master-bus">
      <div className="master-title">Master</div>
      <canvas ref={canvasRef} className="master-meter" />
      <input
        className="master-fader"
        type="range"
        min={-48}
        max={12}
        step={0.1}
        value={masterDb}
        title="Master volume (double-click to reset)"
        onChange={(e) => {
          const db = Number(e.target.value)
          setOption('masterDb', db)
          getEngine().setMasterDb(db)
        }}
        onDoubleClick={() => {
          setOption('masterDb', 0)
          getEngine().setMasterDb(0)
        }}
      />
      <div className="master-value">{masterDb > 0 ? '+' : ''}{masterDb.toFixed(1)} dB</div>
    </div>
  )
}

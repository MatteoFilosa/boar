import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Grid2x2, RectangleHorizontal, RectangleVertical, Square } from 'lucide-react'
import { setFrameSize, setOption } from '../core/actions'
import { useEditor, type PreviewQuality } from '../core/store'
import { frameIndex, rateLabel } from '../core/time'
import { QUALITY_SCALE, getEngine } from '../engine/preview'
import { TransformOverlay } from './TransformOverlay'

const QUALITIES: { id: PreviewQuality; label: string }[] = [
  { id: 'draft', label: 'Draft (1/4)' },
  { id: 'preview', label: 'Preview (1/2)' },
  { id: 'good', label: 'Good (Full)' },
  { id: 'best', label: 'Best (Full)' }
]

const ASPECTS = [
  { label: '16:9', icon: RectangleHorizontal, width: 1920, height: 1080 },
  { label: '9:16', icon: RectangleVertical, width: 1080, height: 1920 },
  { label: '1:1', icon: Square, width: 1080, height: 1080 }
]

/**
 * Guides drawn over the preview only (never rendered). Vertical projects show
 * the areas usually covered by app buttons and captions (approximate);
 * horizontal ones show action/title safe.
 */
function SafeAreas({ vertical }: { vertical: boolean }): React.JSX.Element {
  if (!vertical) {
    return (
      <div className="safe-overlay">
        <div className="safe-rect" style={{ inset: '5%' }} />
        <div className="safe-rect inner" style={{ inset: '10%' }} />
      </div>
    )
  }
  return (
    <div className="safe-overlay">
      <div className="safe-band" style={{ left: 0, right: 0, top: 0, height: '10%' }} />
      <div className="safe-band" style={{ left: 0, right: 0, bottom: 0, height: '22%' }} />
      <div className="safe-band" style={{ right: 0, top: '10%', bottom: '22%', width: '14%' }} />
      <div className="safe-rect" style={{ left: '5%', right: '14%', top: '10%', bottom: '22%' }} />
      <span className="safe-label">App UI zones (approx.)</span>
    </div>
  )
}

function FrameInfo(): React.JSX.Element {
  const cursor = useEditor((s) => s.cursor)
  const rate = useEditor((s) => s.project.settings.frameRate)
  return <span>Frame: {frameIndex(cursor, rate)}</span>
}

export function VideoPreview(): React.JSX.Element {
  const settings = useEditor((s) => s.project.settings)
  const quality = useEditor((s) => s.options.previewQuality)
  const safeAreas = useEditor((s) => s.options.safeAreas)
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [display, setDisplay] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const canvas = canvasRef.current!
    const engine = getEngine()
    engine.attach(canvas)
    return () => engine.detach(canvas)
  }, [])

  useLayoutEffect(() => {
    const host = hostRef.current!
    const fit = (): void => {
      const aw = host.clientWidth - 12
      const ah = host.clientHeight - 12
      const scale = Math.max(0, Math.min(aw / settings.width, ah / settings.height))
      setDisplay({ width: Math.floor(settings.width * scale), height: Math.floor(settings.height * scale) })
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(host)
    return () => observer.disconnect()
  }, [settings.width, settings.height])

  const scale = QUALITY_SCALE[quality]
  const fps = rateLabel(settings.frameRate)
  return (
    <div className="preview">
      <div className="panel-toolbar">
        <select
          className="select"
          value={quality}
          title="Preview quality"
          onChange={(e) => setOption('previewQuality', e.target.value as PreviewQuality)}
        >
          {QUALITIES.map((q) => (
            <option key={q.id} value={q.id}>
              {q.label}
            </option>
          ))}
        </select>
        <div className="tool-sep" />
        <button
          className={`tool-btn${safeAreas ? ' active' : ''}`}
          title="Safe areas overlay (social app UI zones in vertical projects)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOption('safeAreas', !safeAreas)}
        >
          <Grid2x2 size={14} />
        </button>
        <div className="tool-sep" />
        {ASPECTS.map((a) => {
          const Icon = a.icon
          const active = settings.width === a.width && settings.height === a.height
          return (
            <button
              key={a.label}
              className={`tool-btn labeled${active ? ' active' : ''}`}
              title={`Project frame ${a.width}x${a.height}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setFrameSize(a.width, a.height)}
            >
              <Icon size={14} />
              <span>{a.label}</span>
            </button>
          )
        })}
      </div>
      <div className="preview-host" ref={hostRef}>
        <div className="preview-frame" style={{ width: display.width, height: display.height }}>
          <canvas
            ref={canvasRef}
            className="preview-canvas"
            style={{ width: display.width, height: display.height }}
            onDoubleClick={() => getEngine().togglePlay(false)}
          />
          {safeAreas && <SafeAreas vertical={settings.height > settings.width} />}
          <TransformOverlay width={display.width} />
        </div>
      </div>
      <div className="preview-info">
        <span>
          Project: {settings.width}x{settings.height}x32, {fps}p
        </span>
        <span>
          Preview: {Math.round(settings.width * scale)}x{Math.round(settings.height * scale)}x32, {fps}p
        </span>
        <span>
          Display: {display.width}x{display.height}x32
        </span>
        <FrameInfo />
      </div>
    </div>
  )
}

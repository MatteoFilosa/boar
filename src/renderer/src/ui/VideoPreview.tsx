import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  Grid2x2,
  Maximize,
  Minimize,
  Pause,
  Play,
  RectangleHorizontal,
  RectangleVertical,
  Settings,
  Square
} from 'lucide-react'
import { endColorPick, openDialog, setCursor, setFrameSize, setFxParam, setOption, setStatus } from '../core/actions'
import { SAFE_GUIDES } from '../core/safeZones'
import { colorToHex } from '../core/fx'
import { useEditor, type PreviewQuality } from '../core/store'
import { projectEnd } from '../core/timeline'
import { formatTimecode, frameIndex, rateLabel } from '../core/time'
import { QUALITY_SCALE, getEngine } from '../engine/preview'
import { setFullScreenHost, toggleFullScreenPreview } from './fullScreen'
import { shortcutLabel } from './shortcuts'
import { TransformOverlay } from './TransformOverlay'
import { GUIDE_LABELS, SafeZones } from './SafeZones'
import { openContextMenu } from './ContextMenu'
import { Transport } from './Transport'

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

/** Eyedropper of an effect's color: shows the color under the pointer, a click picks it. */
function ColorPickOverlay({ width }: { width: number }): React.JSX.Element | null {
  const pick = useEditor((s) => s.colorPick)
  const projectWidth = useEditor((s) => s.project.settings.width)
  const [hover, setHover] = useState<{ x: number; y: number; color: number } | null>(null)
  useEffect(() => {
    if (!pick) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      endColorPick()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [pick])
  if (!pick || width === 0) return null
  const sample = (e: React.PointerEvent<HTMLDivElement>): { x: number; y: number; color: number | null } => {
    const r = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - r.left
    const y = e.clientY - r.top
    const k = projectWidth / width
    return { x, y, color: getEngine().pickColor(pick.eventId, x * k, y * k) }
  }
  return (
    <div
      className="color-pick-overlay"
      title="Click the color to pick (Esc cancels)"
      onPointerMove={(e) => {
        const at = sample(e)
        setHover(at.color === null ? null : { x: at.x, y: at.y, color: at.color })
      }}
      onPointerLeave={() => setHover(null)}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        const { color } = sample(e)
        endColorPick()
        if (color !== null) {
          setFxParam(pick.eventId, pick.fxId, pick.key, color)
          setStatus(`Picked ${colorToHex(color)}`)
        } else setStatus('Nothing to pick there')
      }}
    >
      {hover && <div className="color-pick-swatch" style={{ left: hover.x + 14, top: hover.y + 14, background: colorToHex(hover.color) }} />}
    </div>
  )
}

function FrameInfo(): React.JSX.Element {
  const cursor = useEditor((s) => s.cursor)
  const rate = useEditor((s) => s.project.settings.frameRate)
  return <span>Frame: {frameIndex(cursor, rate)}</span>
}

/** Seek bar, play/pause, position and exit over the full screen preview. */
function FullScreenControls({ visible }: { visible: boolean }): React.JSX.Element {
  const playing = useEditor((s) => s.playing)
  const cursor = useEditor((s) => s.cursor)
  const markers = useEditor((s) => s.project.markers)
  const rate = useEditor((s) => s.project.settings.frameRate)
  const end = useEditor((s) => projectEnd(s.project))
  const at = (t: number): string => `${end > 0 ? Math.min(100, (t / end) * 100) : 0}%`
  const seek = (e: React.PointerEvent<HTMLDivElement>): void => {
    const box = e.currentTarget.getBoundingClientRect()
    setCursor(Math.round(Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)) * end))
  }
  return (
    <div className={`fs-controls${visible ? '' : ' hidden'}`}>
      <div
        className="fs-seek"
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.currentTarget.setPointerCapture(e.pointerId)
          seek(e)
        }}
        onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && seek(e)}
      >
        <div className="fs-seek-fill" style={{ width: at(cursor) }} />
        {markers.map((m) => (
          <div key={m.id} className="fs-seek-marker" style={{ left: at(m.time) }} title={m.label} />
        ))}
      </div>
      <div className="fs-bar">
        <button
          className={`tool-btn ${playing ? 'tone-pause' : 'tone-play'}`}
          title={`${playing ? 'Pause' : 'Play'} (${shortcutLabel('playPause')})`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => getEngine().togglePlay(false)}
        >
          {playing ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <span className="tc">{formatTimecode(cursor, rate)}</span>
        <span className="tc-dim">/ {formatTimecode(end, rate)}</span>
        <button
          className="tool-btn labeled fs-exit"
          title="Exit full screen (Esc)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={toggleFullScreenPreview}
        >
          <Minimize size={14} />
          <span>Exit Full Screen</span>
        </button>
      </div>
    </div>
  )
}

export function VideoPreview(): React.JSX.Element {
  const settings = useEditor((s) => s.project.settings)
  const quality = useEditor((s) => s.options.previewQuality)
  const safeAreas = useEditor((s) => s.options.safeAreas)
  const safeGuide = useEditor((s) => s.options.safeGuide)
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [display, setDisplay] = useState({ width: 0, height: 0 })
  const [full, setFull] = useState(false)
  const [idle, setIdle] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current!
    const engine = getEngine()
    engine.attach(canvas)
    return () => engine.detach(canvas)
  }, [])

  useEffect(() => {
    const host = hostRef.current!
    setFullScreenHost(host)
    const onChange = (): void => setFull(document.fullscreenElement === host)
    document.addEventListener('fullscreenchange', onChange)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      setFullScreenHost(null)
    }
  }, [])

  // In full screen the controls and the pointer hide when the mouse rests
  // (not while it is over the controls); a new marker shows them again.
  useEffect(() => {
    if (!full) return
    const host = hostRef.current!
    let timer = 0
    const hide = (): void => {
      if (host.querySelector('.fs-controls:hover')) timer = window.setTimeout(hide, 2000)
      else setIdle(true)
    }
    const wake = (): void => {
      setIdle(false)
      window.clearTimeout(timer)
      timer = window.setTimeout(hide, 2000)
    }
    wake()
    host.addEventListener('pointermove', wake)
    host.addEventListener('pointerdown', wake)
    const unsubscribe = useEditor.subscribe((s, prev) => {
      if (s.project.markers !== prev.project.markers) wake()
    })
    return () => {
      window.clearTimeout(timer)
      host.removeEventListener('pointermove', wake)
      host.removeEventListener('pointerdown', wake)
      unsubscribe()
      setIdle(false)
    }
  }, [full])

  useLayoutEffect(() => {
    const host = hostRef.current!
    const margin = full ? 0 : 12
    const fit = (): void => {
      const aw = host.clientWidth - margin
      const ah = host.clientHeight - margin
      const scale = Math.max(0, Math.min(aw / settings.width, ah / settings.height))
      setDisplay({ width: Math.floor(settings.width * scale), height: Math.floor(settings.height * scale) })
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(host)
    return () => observer.disconnect()
  }, [settings.width, settings.height, full])

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
        <div className="split-btn">
          <button
            className={`tool-btn${safeAreas ? ' active' : ''}`}
            title={`Safe areas overlay: ${GUIDE_LABELS[safeGuide]} in vertical projects, action/title safe in horizontal ones`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setOption('safeAreas', !safeAreas)}
          >
            <Grid2x2 size={14} />
          </button>
          <button
            className={`tool-btn split-btn-arrow${safeAreas ? ' active' : ''}`}
            title="Which app's safe areas"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              openContextMenu(r.left, r.bottom + 2, [
                ...SAFE_GUIDES.map((g) => ({
                  label: GUIDE_LABELS[g],
                  checked: safeAreas && g === safeGuide,
                  run: () => {
                    setOption('safeGuide', g)
                    setOption('safeAreas', true)
                  }
                })),
                'separator' as const,
                { label: 'Safe areas off', checked: !safeAreas, run: () => setOption('safeAreas', false) }
              ])
            }}
          >
            <ChevronDown size={12} />
          </button>
        </div>
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
        <div className="tool-sep" />
        <button
          className="tool-btn"
          title={`Project Properties (${shortcutLabel('properties')}): ${settings.width}x${settings.height}, ${fps} fps`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => openDialog({ kind: 'projectProperties' })}
        >
          <Settings size={14} />
        </button>
        <button
          className="tool-btn preview-full-screen"
          title={`Full screen preview (${shortcutLabel('fullScreenPreview')})`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={toggleFullScreenPreview}
        >
          <Maximize size={14} />
        </button>
      </div>
      <div className={`preview-host${full && idle ? ' idle' : ''}`} ref={hostRef}>
        <div className="preview-frame" style={{ width: display.width, height: display.height }}>
          <canvas
            ref={canvasRef}
            className="preview-canvas"
            style={{ width: display.width, height: display.height }}
            onDoubleClick={() => getEngine().togglePlay(false)}
          />
          {!full && safeAreas && <SafeZones />}
          {!full && <TransformOverlay width={display.width} />}
          {!full && <ColorPickOverlay width={display.width} />}
        </div>
        {full && <FullScreenControls visible={!idle} />}
      </div>
      <Transport />
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

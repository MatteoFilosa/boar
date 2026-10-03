import { useEffect, useRef } from 'react'
import { AudioLines, AudioWaveform, Mic, SlidersHorizontal, Sparkles, type LucideIcon } from 'lucide-react'
import * as A from '../core/actions'
import { useEditor } from '../core/store'
import { AUDIO_FX, type FxKind, VIDEO_FX, createFx } from '../core/fx'
import { applyVideoFx } from '../engine/videoFx'
import { startMediaDrag } from './mediaDrag'

const THUMB_W = 192
const THUMB_H = 108

let sample: OffscreenCanvas | null = null

/** A small synthetic scene: sky, sun, hills and a striped ball, so color and distortion effects both read. */
function sampleScene(): OffscreenCanvas {
  if (sample) return sample
  const c = new OffscreenCanvas(THUMB_W, THUMB_H)
  const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D
  const sky = ctx.createLinearGradient(0, 0, 0, THUMB_H)
  sky.addColorStop(0, '#3d7fd6')
  sky.addColorStop(0.65, '#f4b56b')
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, THUMB_W, THUMB_H)
  ctx.fillStyle = '#ffe28a'
  ctx.beginPath()
  ctx.arc(142, 42, 16, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#5b3f73'
  ctx.beginPath()
  ctx.moveTo(0, 80)
  ctx.lineTo(40, 48)
  ctx.lineTo(78, 76)
  ctx.lineTo(118, 52)
  ctx.lineTo(THUMB_W, 82)
  ctx.lineTo(THUMB_W, THUMB_H)
  ctx.lineTo(0, THUMB_H)
  ctx.fill()
  ctx.fillStyle = '#3f9a4d'
  ctx.fillRect(0, 86, THUMB_W, THUMB_H - 86)
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = i % 2 ? '#ffffff' : '#e8413c'
    ctx.beginPath()
    ctx.arc(62, 78, 18 - i * 3, 0, Math.PI * 2)
    ctx.fill()
  }
  sample = c
  return c
}

/** The sample scene run through one video effect. */
export function FxThumb({ type, params }: { type: string; params?: Record<string, number> }): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const fx = createFx(type)
    if (!canvas || !fx) return
    if (params) fx.params = { ...params }
    canvas.width = THUMB_W
    canvas.height = THUMB_H
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
    const scene = sampleScene()
    const out = applyVideoFx(scene, [fx], THUMB_W, THUMB_H, 0.7)
    // Checkerboard behind, so transparency (chroma key, distortions) is visible.
    for (let y = 0; y < THUMB_H; y += 8) {
      for (let x = 0; x < THUMB_W; x += 8) {
        ctx.fillStyle = (x + y) % 16 === 0 ? '#3a3c42' : '#2a2b30'
        ctx.fillRect(x, y, 8, 8)
      }
    }
    ctx.drawImage(out ?? scene, 0, 0)
  }, [type, params])
  return <canvas ref={ref} className="fx-thumb" />
}

const AUDIO_ICONS: Record<string, LucideIcon> = {
  'Clean Up': Mic,
  'EQ & Dynamics': SlidersHorizontal,
  Space: AudioWaveform,
  Creative: Sparkles
}

/** Dock tab listing the effects: drag one onto an event, or double-click to add it to the selection. */
export function FxBrowser({ kind }: { kind: FxKind }): React.JSX.Element {
  const library = kind === 'video' ? VIDEO_FX : AUDIO_FX
  const categories = [...new Set(library.map((d) => d.category))]
  return (
    <div className="fx-browser">
      <div className="gen-title">
        {kind === 'video' ? 'Video FX' : 'Audio FX'} — drag onto an event, or double-click to add to the selected events
      </div>
      {categories.map((category) => (
        <div key={category} className="fx-group">
          <div className="fx-group-title">{category}</div>
          <div className={kind === 'video' ? 'gen-grid' : 'fx-audio-grid'}>
            {library
              .filter((d) => d.category === category)
              .map((d) => {
                const Icon = AUDIO_ICONS[d.category] ?? AudioLines
                return (
                  <div
                    key={d.type}
                    className={kind === 'video' ? 'gen-tile' : 'fx-audio-tile'}
                    title={`${d.description}\nDrag onto an event or double-click to add it to the selected events.`}
                    onPointerDown={(e) => e.button === 0 && startMediaDrag(`fx:${d.type}`, e.clientX, e.clientY)}
                    onDoubleClick={() => A.addFx(useEditor.getState().selection, d.type)}
                  >
                    {kind === 'video' ? <FxThumb type={d.type} /> : <Icon size={16} />}
                    <span>{d.label}</span>
                  </div>
                )
              })}
          </div>
        </div>
      ))}
    </div>
  )
}

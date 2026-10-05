import { useState } from 'react'
import { X } from 'lucide-react'
import { create } from 'zustand'
import * as A from '../../core/actions'
import { useEditor } from '../../core/store'
import type { Track } from '../../core/types'
import { layoutTracks, tracksHeight } from './geometry'

/** Track being reordered by dragging its header, and where the drop line is drawn. */
export const useTrackDrag = create<{ dragId: string | null; lineY: number | null }>()(() => ({ dragId: null, lineY: null }))

/** Insertion slot for a header dropped at content y: index before which the track goes. */
function dropSlot(tracks: readonly Track[], y: number): { slot: number; lineY: number } {
  for (const l of layoutTracks(tracks)) if (y < l.top + l.height / 2) return { slot: l.index, lineY: l.top }
  return { slot: tracks.length, lineY: tracksHeight(tracks) }
}

/** Dragging a header (outside its controls) moves the track up or down. */
function startTrackDrag(e: React.PointerEvent<HTMLDivElement>, track: Track): void {
  if (e.button !== 0 || (e.target as HTMLElement).closest('input, button, select, .th-resize')) return
  const inner = e.currentTarget.parentElement
  if (!inner) return
  const startY = e.clientY
  let active = false
  const slotAt = (clientY: number): { slot: number; lineY: number } =>
    dropSlot(useEditor.getState().project.tracks, clientY - inner.getBoundingClientRect().top)
  const move = (ev: PointerEvent): void => {
    if (!active && Math.abs(ev.clientY - startY) < 5) return
    active = true
    document.body.classList.add('dragging-track')
    useTrackDrag.setState({ dragId: track.id, lineY: slotAt(ev.clientY).lineY })
  }
  const up = (ev: PointerEvent): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    document.body.classList.remove('dragging-track')
    useTrackDrag.setState({ dragId: null, lineY: null })
    if (!active) return
    const tracks = useEditor.getState().project.tracks
    const from = tracks.findIndex((t) => t.id === track.id)
    const { slot } = slotAt(ev.clientY)
    A.moveTrack(track.id, slot > from ? slot - 1 : slot)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

const formatDb = (db: number): string => (db <= -60 ? '-Inf' : `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`)
const formatPan = (pan: number): string =>
  Math.abs(pan) < 0.005 ? 'Center' : `${Math.round(Math.abs(pan) * 100)}% ${pan < 0 ? 'L' : 'R'}`

interface SliderProps {
  label: string
  min: number
  max: number
  step: number
  value: number
  resetTo: number
  onChange: (value: number) => void
}

/** Track slider: a drag is one undo step, double-click resets. */
function HeaderSlider({ label, min, max, step, value, resetTo, onChange }: SliderProps): React.JSX.Element {
  const begin = (): void => {
    A.beginGesture()
    window.addEventListener('pointerup', () => A.endGesture(), { once: true })
  }
  return (
    <label className="th-slider" onDoubleClick={() => onChange(resetTo)}>
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onPointerDown={begin}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  )
}

export function TrackHeader({ track, index }: { track: Track; index: number }): React.JSX.Element {
  const selected = useEditor((s) => s.selectedTrackId === track.id)
  const dragging = useTrackDrag((s) => s.dragId === track.id)
  const [draftName, setDraftName] = useState<string | null>(null)
  const color = A.TRACK_COLORS[track.color % A.TRACK_COLORS.length]
  const commitName = (): void => {
    if (draftName !== null && draftName !== track.name) A.updateTrack(track.id, { name: draftName })
    setDraftName(null)
  }

  return (
    <div
      className={`track-header${selected ? ' selected' : ''}${dragging ? ' dragging' : ''}`}
      style={{ height: track.height }}
      onPointerDown={(e) => {
        A.selectTrack(track.id)
        startTrackDrag(e, track)
      }}
    >
      <div className="th-strip" style={{ background: color }} title="Drag to move the track">
        <span>{index + 1}</span>
      </div>
      <div className="th-main">
        <div className="th-row">
          <input
            className="th-name"
            value={draftName ?? track.name}
            placeholder={track.kind === 'video' ? 'Video' : 'Audio'}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === 'Escape') {
                if (e.key === 'Escape') setDraftName(null)
                ;(e.target as HTMLInputElement).blur()
              }
            }}
          />
          <button
            className={`th-btn${track.muted ? ' on-mute' : ''}`}
            title={track.kind === 'video' ? 'Mute (hide track)' : 'Mute'}
            onClick={() => A.updateTrack(track.id, { muted: !track.muted })}
          >
            M
          </button>
          <button
            className={`th-btn${track.solo ? ' on-solo' : ''}`}
            title="Solo"
            onClick={() => A.updateTrack(track.id, { solo: !track.solo })}
          >
            S
          </button>
          <button className="th-btn th-del" title="Delete track" onClick={() => A.removeTrack(track.id)}>
            <X size={12} />
          </button>
        </div>
        <div
          className="th-resize"
          title="Drag to resize the track"
          onPointerDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
            const startY = e.clientY
            const startHeight = track.height
            A.beginGesture()
            const move = (ev: PointerEvent): void => {
              const height = Math.round(Math.min(A.MAX_TRACK_HEIGHT, Math.max(A.MIN_TRACK_HEIGHT, startHeight + ev.clientY - startY)))
              A.updateTrack(track.id, { height })
            }
            const up = (): void => {
              window.removeEventListener('pointermove', move)
              window.removeEventListener('pointerup', up)
              A.endGesture()
            }
            window.addEventListener('pointermove', move)
            window.addEventListener('pointerup', up)
          }}
        />
        {track.kind === 'video' ? (
          <HeaderSlider
            label={`Level: ${(track.level * 100).toFixed(1)} %`}
            min={0}
            max={1}
            step={0.001}
            value={track.level}
            resetTo={1}
            onChange={(level) => A.updateTrack(track.id, { level })}
          />
        ) : (
          <>
            <HeaderSlider
              label={`Vol: ${formatDb(track.volumeDb)}`}
              min={-60}
              max={12}
              step={0.1}
              value={track.volumeDb}
              resetTo={0}
              onChange={(volumeDb) => A.updateTrack(track.id, { volumeDb })}
            />
            <HeaderSlider
              label={`Pan: ${formatPan(track.pan)}`}
              min={-1}
              max={1}
              step={0.01}
              value={track.pan}
              resetTo={0}
              onChange={(pan) => A.updateTrack(track.id, { pan })}
            />
          </>
        )}
      </div>
    </div>
  )
}

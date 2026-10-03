import { useState } from 'react'
import { AudioLines, X } from 'lucide-react'
import * as A from '../core/actions'
import { mediaById, useEditor } from '../core/store'
import { FLICKS_PER_SECOND, secondsToFlicks } from '../core/time'
import { autoThreshold, eventLevels, mediaLevels, soundIntervals } from '../engine/analysis'
import type { Project } from '../core/types'

const trackLabel = (project: Project, id: string): string => {
  const index = project.tracks.findIndex((t) => t.id === id)
  const track = project.tracks[index]
  return `${index + 1}. ${track?.name || 'Audio'}`
}

/** Tools › Auto Ducking: the music goes down while someone talks. */
export function DuckingDialog(): React.JSX.Element {
  const project = useEditor((s) => s.project)
  const selection = useEditor((s) => s.selection)
  const audioTracks = project.tracks.filter((t) => t.kind === 'audio' && project.events.some((e) => e.trackId === t.id))
  // Voice: tracks of the selected audio (or of the sound of selected videos); music: the other ones.
  const [voice, setVoice] = useState<string[]>(() => {
    const picked = new Set<string>()
    for (const e of project.events) {
      if (!selection.includes(e.id)) continue
      const audio = e.kind === 'audio' ? e : project.events.find((o) => o.groupId && o.groupId === e.groupId && o.kind === 'audio')
      if (audio) picked.add(audio.trackId)
    }
    if (picked.size === 0 && audioTracks[0]) picked.add(audioTracks[0].id)
    return [...picked]
  })
  const [music, setMusic] = useState<string[]>(() => audioTracks.map((t) => t.id).filter((id) => !voice.includes(id)))
  const [duckDb, setDuckDb] = useState(-14)
  const [attack, setAttack] = useState(0.2)
  const [release, setRelease] = useState(0.6)
  const [hold, setHold] = useState(0.6)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const toggle = (list: string[], id: string): string[] => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id])

  const apply = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const ranges: { start: number; end: number }[] = []
      for (const e of project.events) {
        if (e.kind !== 'audio' || !voice.includes(e.trackId)) continue
        const media = mediaById(e.mediaId)
        if (!media?.hasAudio) continue
        const levels = eventLevels(await mediaLevels(media), e.offset / FLICKS_PER_SECOND, e.length / FLICKS_PER_SECOND, e.rate)
        for (const v of soundIntervals(levels, autoThreshold(levels), hold)) {
          ranges.push({ start: e.start + secondsToFlicks(v.start), end: e.start + secondsToFlicks(v.end) })
        }
      }
      if (ranges.length === 0) throw new Error('No voice found on the voice tracks')
      A.applyDucking(music, ranges, { duckDb, attack, release })
      A.closeDialog()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const slider = (label: string, value: number, min: number, max: number, step: number, unit: string, set: (v: number) => void): React.JSX.Element => (
    <>
      <label>{label}</label>
      <div className="te-control">
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => set(Number(e.target.value))} />
        <span className="te-val">
          {value.toFixed(step < 1 ? 2 : 0)} {unit}
        </span>
      </div>
    </>
  )

  return (
    <div className="modal-backdrop">
      <div className="modal" style={{ width: 520 }} role="dialog" aria-label="Auto ducking">
        <div className="modal-title">
          <span>Auto Ducking</span>
          <button className="tool-btn" title="Close (Esc)" disabled={busy} onClick={A.closeDialog}>
            <X size={14} />
          </button>
        </div>
        <div className="modal-body">
          <p className="dim">
            The music tracks get a volume envelope (yellow line on the events) that goes down while the voice tracks have
            sound. Run it again after editing; "Remove" flattens it.
          </p>
          {audioTracks.length < 2 ? (
            <div className="render-result error">Put the voice and the music on two different audio tracks first.</div>
          ) : (
            <div className="form">
              <label>Voice tracks</label>
              <div className="te-control wrap">
                {audioTracks.map((t) => (
                  <label key={t.id} className="te-check">
                    <input type="checkbox" checked={voice.includes(t.id)} onChange={() => setVoice(toggle(voice, t.id))} />
                    {trackLabel(project, t.id)}
                  </label>
                ))}
              </div>
              <label>Music tracks</label>
              <div className="te-control wrap">
                {audioTracks.map((t) => (
                  <label key={t.id} className="te-check">
                    <input type="checkbox" checked={music.includes(t.id)} onChange={() => setMusic(toggle(music, t.id))} />
                    {trackLabel(project, t.id)}
                  </label>
                ))}
              </div>
              {slider('Music while talking', duckDb, -30, -3, 1, 'dB', setDuckDb)}
              {slider('Fade down', attack, 0.05, 1, 0.05, 's', setAttack)}
              {slider('Fade up', release, 0.1, 2, 0.05, 's', setRelease)}
              {slider('Stay down in pauses', hold, 0.1, 2, 0.05, 's', setHold)}
            </div>
          )}
          {error && <div className="render-result error">{error}</div>}
          <div className="modal-actions">
            <button className="btn" disabled={busy || music.length === 0} onClick={() => (A.clearEnvelopes(music), A.closeDialog())}>
              Remove ducking
            </button>
            <button className="btn" disabled={busy} onClick={A.closeDialog}>
              Cancel
            </button>
            <button
              className="btn primary"
              disabled={busy || voice.length === 0 || music.length === 0 || audioTracks.length < 2 || voice.some((v) => music.includes(v))}
              onClick={() => void apply()}
            >
              <AudioLines size={13} /> {busy ? 'Analyzing…' : 'Apply ducking'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

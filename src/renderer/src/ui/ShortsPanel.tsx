import { useMemo, useState } from 'react'
import { ChevronLeft, Clapperboard, Play, Sparkles, Trash2 } from 'lucide-react'
import * as A from '../core/actions'
import { useEditor } from '../core/store'
import { CAPTION_STYLES } from '../core/captions'
import { formatTimecode, FLICKS_PER_SECOND } from '../core/time'
import { type ShortCandidate, findHighlights, shortDuration } from '../core/shorts'
import { defaultSpeechTrack, hasSpeech, speechTracks, wordsOnTimeline } from '../core/transcript'
import { uid } from '../core/ids'
import { isDirty } from '../core/session'
import { DEFAULT_SHORT_OPTIONS, type MakeShortOptions, type ShortFraming, backToLongVideo, makeShort } from '../engine/makeShort'
import { commands } from './commands'
import { shortcutLabel } from './shortcuts'

const FRAMINGS: { id: ShortFraming; label: string }[] = [
  { id: 'reframe', label: 'Follow the face' },
  { id: 'blurred', label: 'Blurred background' },
  { id: 'fill', label: 'Crop to fill' }
]

const seconds = (t: number): string => `${Math.round(t / FLICKS_PER_SECOND)} s`

/** Shorts tab: candidate moments of a long video and Make Short. */
export function ShortsPanel(): React.JSX.Element {
  const shorts = useEditor((s) => s.shorts)
  const longVideo = useEditor((s) => s.longVideo)
  const project = useEditor((s) => s.project)
  const transcripts = useEditor((s) => s.transcripts)
  const rate = project.settings.frameRate
  const [options, setOptions] = useState<MakeShortOptions>(DEFAULT_SHORT_OPTIONS)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const words = useMemo(() => {
    const track = defaultSpeechTrack(project, [], speechTracks(project))
    return track ? wordsOnTimeline(project.events.filter((e) => e.trackId === track && hasSpeech(e)), transcripts) : []
  }, [project, transcripts])

  if (longVideo) {
    return (
      <div className="shorts">
        <div className="shorts-banner">
          <Clapperboard size={16} />
          <span>
            Short made from <b>{longVideo.name}</b>. Render it ({shortcutLabel('render')}) and save it if you want to keep it.
          </span>
        </div>
        <div className="ex-bar">
          <button
            className="btn small"
            onClick={() => {
              if (isDirty() && !window.confirm('Go back to the long video? This Short is discarded unless you saved it.')) return
              backToLongVideo()
            }}
          >
            <ChevronLeft size={13} /> Back to the long video
          </button>
        </div>
      </div>
    )
  }

  const find = (): void => {
    const found = findHighlights(words, 4)
    if (found.length === 0) {
      setError('No moment of 20–60 s of continuous speech found.')
      return
    }
    setError('')
    A.setShorts(found.map((c) => ({ ...c, id: uid() })))
    A.setStatus(`Found ${found.length} moments: preview them and make the Short you like`)
  }

  const make = async (c: ShortCandidate): Promise<void> => {
    setError('')
    setBusy('Starting…')
    try {
      await makeShort(c, options, setBusy)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy('')
    }
  }

  const preview = (c: ShortCandidate): void => {
    A.setTimeSelection(c.ranges[0])
    commands.playSelection()
  }

  return (
    <div className="shorts">
      <div className="ex-bar">
        <button
          className="btn small"
          disabled={words.length === 0 || !!busy}
          title={words.length ? 'Look for strong self-contained moments in the transcript (on this PC)' : 'Transcribe the video first (Transcript tab)'}
          onClick={find}
        >
          <Sparkles size={13} /> Find highlights
        </button>
        {shorts.length > 0 && (
          <button className="btn small" disabled={!!busy} title="Remove all candidates" onClick={() => A.setShorts([])}>
            <Trash2 size={13} />
          </button>
        )}
        <span className="dim shorts-tip">or ask your AI agent: prompt “make_shorts”</span>
      </div>
      <div className="shorts-options">
        <select className="select" value={options.framing} title="How horizontal footage fills the vertical frame" onChange={(e) => setOptions({ ...options, framing: e.target.value as ShortFraming })}>
          {FRAMINGS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
        <select
          className="select"
          value={options.captions ?? ''}
          title="Captions from the transcript"
          onChange={(e) => setOptions({ ...options, captions: e.target.value || null })}
        >
          {CAPTION_STYLES.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
          <option value="">No captions</option>
        </select>
        <label className="te-check">
          <input type="checkbox" checked={options.hook} onChange={(e) => setOptions({ ...options, hook: e.target.checked })} />
          Hook title
        </label>
        <label className="te-check">
          <input type="checkbox" checked={options.progressBar} onChange={(e) => setOptions({ ...options, progressBar: e.target.checked })} />
          Progress bar
        </label>
      </div>
      {busy && <div className="dim shorts-busy">{busy}</div>}
      {error && <div className="render-result error">{error}</div>}
      <div className="shorts-list">
        {shorts.length === 0 ? (
          <p className="dim">
            Turn a long video into Shorts: transcribe it (Transcript tab), then click Find highlights, or ask your AI agent
            through Options › AI Agents to pick the best moments. Each one becomes a vertical video with captions in one click,
            and you can go back to the long video for the next.
          </p>
        ) : (
          shorts.map((c, i) => (
            <div key={c.id} className="shorts-item">
              <div className="shorts-head">
                <b>
                  {i + 1}. {c.title}
                </b>
                <span className="dim">
                  {formatTimecode(c.ranges[0].start, rate)} · {seconds(shortDuration(c))}
                  {c.ranges.length > 1 ? ` · ${c.ranges.length} parts` : ''}
                </span>
              </div>
              {c.hook && <div className="shorts-hook">“{c.hook.replace(/\*/g, '')}”</div>}
              {c.reason && <div className="dim shorts-reason">{c.reason}</div>}
              <div className="shorts-actions">
                <span className="badge">{c.source}</span>
                <button className="btn small" disabled={!!busy} onClick={() => preview(c)}>
                  <Play size={12} className="icon-play" /> Preview
                </button>
                <button className="btn small primary" disabled={!!busy} onClick={() => void make(c)}>
                  <Clapperboard size={12} /> Make Short
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

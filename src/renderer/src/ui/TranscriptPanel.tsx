import { useEffect, useMemo, useRef, useState } from 'react'
import { Captions, Download, Scissors } from 'lucide-react'
import * as A from '../core/actions'
import { mediaById, useEditor } from '../core/store'
import { CAPTION_STYLES, alignWords, chunkWords } from '../core/captions'
import { type TimelineWord, type WordFlag, defaultSpeechTrack, hasSpeech, longPauses, speechTracks, wordFlag, wordsOnTimeline } from '../core/transcript'
import { FLICKS_PER_SECOND, type Flicks, formatTimecode } from '../core/time'
import type { MediaItem } from '../core/types'
import { type CaptionProgress, type CaptionStatus, bridge } from '../platform'
import { BoarProgress } from './BoarProgress'

const LANGUAGES = [
  ['auto', 'Auto'],
  ['it', 'Italiano'],
  ['en', 'English'],
  ['es', 'Español'],
  ['fr', 'Français'],
  ['de', 'Deutsch'],
  ['pt', 'Português']
] as const

/** Best installed Whisper model first. */
const MODEL_ORDER = ['large-v3-turbo', 'small', 'base']

/** Pauses longer than this are shown, and cut down to PAUSE_KEEP by "Pauses". */
const PAUSE_MIN = 0.8
const PAUSE_KEEP = 0.25

const seconds = (t: Flicks): string => `${(t / FLICKS_PER_SECOND).toFixed(1)} s`

type Token =
  | { kind: 'word'; i: number; word: TimelineWord; flag: WordFlag | null }
  | { kind: 'pause'; length: Flicks; key: string }
  | { kind: 'cut'; key: string }

interface Paragraph {
  start: Flicks
  tokens: Token[]
}

/** Words grouped in paragraphs (long pauses, sentence ends), with pauses and cut points between them. */
function layout(words: readonly TimelineWord[]): Paragraph[] {
  const out: Paragraph[] = []
  let current: Paragraph | null = null
  let count = 0
  words.forEach((word, i) => {
    const previous = words[i - 1]
    const gap = previous ? word.start - previous.end : 0
    const sentenceEnd = previous ? /[.!?…]$/.test(previous.text) : false
    if (!current || gap > 2 * FLICKS_PER_SECOND || (sentenceEnd && count >= 30)) {
      current = { start: word.start, tokens: [] }
      out.push(current)
      count = 0
    } else {
      if (previous && previous.eventId !== word.eventId) current.tokens.push({ kind: 'cut', key: `c${i}` })
      if (gap > PAUSE_MIN * FLICKS_PER_SECOND) current.tokens.push({ kind: 'pause', length: gap, key: `p${i}` })
    }
    current.tokens.push({ kind: 'word', i, word, flag: wordFlag(words, i) })
    count++
  })
  return out
}

/**
 * Transcript tab: the speech of a track as text. Click a word to jump there,
 * select words (drag, Shift, Ctrl) and press Delete to cut them out of the
 * video; fillers and repeated words are underlined.
 */
export function TranscriptPanel(): React.JSX.Element {
  const project = useEditor((s) => s.project)
  const selection = useEditor((s) => s.selection)
  const transcripts = useEditor((s) => s.transcripts)
  const rate = project.settings.frameRate
  const candidates = useMemo(() => speechTracks(project), [project])
  const [chosen, setChosen] = useState<string | null>(null)
  const trackId = chosen && candidates.includes(chosen) ? chosen : defaultSpeechTrack(project, selection, candidates)
  const events = useMemo(() => project.events.filter((e) => e.trackId === trackId && hasSpeech(e)), [project, trackId])
  const words = useMemo(() => wordsOnTimeline(events, transcripts), [events, transcripts])
  const paragraphs = useMemo(() => layout(words), [words])
  const missing = useMemo(() => {
    const ids = [...new Set(events.map((e) => e.mediaId))].filter((id) => !transcripts[id])
    return ids.map((id) => mediaById(id)).filter((m): m is MediaItem => !!m)
  }, [events, transcripts])

  const [picked, setPicked] = useState<Set<number>>(new Set())
  const anchor = useRef<number | null>(null)
  const dragging = useRef(false)
  const textRef = useRef<HTMLDivElement>(null)
  const [language, setLanguage] = useState('auto')
  const [style, setStyle] = useState(CAPTION_STYLES[0].id)
  const [status, setStatus] = useState<CaptionStatus | null>(null)
  const [busy, setBusy] = useState<(CaptionProgress & { label: string }) | null>(null)
  const [error, setError] = useState('')

  // A cut changes the words: the old selection no longer applies.
  useEffect(() => setPicked(new Set()), [words])

  useEffect(() => {
    if (!bridge) return
    void bridge.captionsStatus().then(setStatus)
    return bridge.onCaptionProgress((p) => setBusy((b) => (b ? { ...b, ...p } : b)))
  }, [])

  // The word under the cursor is highlighted (and followed while playing) without re-rendering the text.
  useEffect(() => {
    let active: HTMLElement | null = null
    const update = (cursor: Flicks, playing: boolean): void => {
      let lo = 0
      let hi = words.length - 1
      let found = -1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (words[mid].end <= cursor) lo = mid + 1
        else if (words[mid].start > cursor) hi = mid - 1
        else {
          found = mid
          break
        }
      }
      const el = found >= 0 ? textRef.current?.querySelector<HTMLElement>(`[data-i="${found}"]`) ?? null : null
      if (el === active) return
      active?.classList.remove('active')
      el?.classList.add('active')
      active = el
      if (el && playing && textRef.current) {
        const box = textRef.current.getBoundingClientRect()
        const r = el.getBoundingClientRect()
        if (r.top < box.top || r.bottom > box.bottom) el.scrollIntoView({ block: 'center' })
      }
    }
    const s = useEditor.getState()
    update(s.cursor, false)
    return useEditor.subscribe((n, p) => {
      if (n.cursor !== p.cursor) update(n.cursor, n.playing)
    })
  }, [words])

  const flagged = (kinds: WordFlag[]): number[] =>
    words.map((_, i) => i).filter((i) => {
      const f = wordFlag(words, i)
      return f !== null && kinds.includes(f)
    })
  const fillers = useMemo(() => flagged(['filler', 'repeat']), [words])
  const maybes = useMemo(() => flagged(['maybe']), [words])
  const pauses = useMemo(() => longPauses(words, PAUSE_MIN, PAUSE_KEEP), [words])
  const pickedLength = [...picked].reduce((n, i) => n + (words[i] ? words[i].end - words[i].start : 0), 0)

  const wordAt = (x: number, y: number): number | null => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-i]')
    return el ? Number(el.dataset.i) : null
  }

  const range = (a: number, b: number): Set<number> => {
    const out = new Set<number>()
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.add(i)
    return out
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    const i = wordAt(e.clientX, e.clientY)
    e.currentTarget.focus()
    if (i === null) {
      setPicked(new Set())
      return
    }
    e.preventDefault()
    if (e.shiftKey && anchor.current !== null) setPicked(range(anchor.current, i))
    else if (e.ctrlKey || e.metaKey) {
      setPicked((p) => {
        const next = new Set(p)
        if (next.has(i)) next.delete(i)
        else next.add(i)
        return next
      })
      anchor.current = i
    } else {
      setPicked(new Set([i]))
      anchor.current = i
      A.setCursor(words[i].start)
    }
    dragging.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging.current || anchor.current === null) return
    const i = wordAt(e.clientX, e.clientY)
    if (i !== null) setPicked(range(anchor.current, i))
  }

  const remove = (which: Set<number>): void => {
    if (which.size === 0) return
    A.deleteWords(words, which)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      e.stopPropagation()
      remove(picked)
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      setPicked(new Set())
    } else if (e.key.toLowerCase() === 'a' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      e.stopPropagation()
      setPicked(new Set(words.map((_, i) => i)))
    }
  }

  const cutPauses = (): void => {
    if (pauses.length === 0) return
    const ids = events.map((e) => e.id)
    const cuts = A.cutRanges(ids, pauses, 'remove')
    A.setStatus(`Shortened ${cuts} pause${cuts === 1 ? '' : 's'} to ${PAUSE_KEEP} s`)
  }

  const makeCaptions = (): void => {
    const look = CAPTION_STYLES.find((s) => s.id === style) ?? CAPTION_STYLES[0]
    const timed = words.map((w) => ({ text: w.text, start: w.start / FLICKS_PER_SECOND, end: w.end / FLICKS_PER_SECOND }))
    const chunks = chunkWords(timed, { maxChars: look.maxChars, maxWords: look.maxWords, maxGap: 0.6 })
    const count = A.addCaptionEvents(chunks, 0, style)
    A.setStatus(`Added ${count} captions from the transcript`)
  }

  const model = MODEL_ORDER.find((id) => status?.models.some((m) => m.id === id && m.installed)) ?? null

  const transcribe = async (): Promise<void> => {
    if (!bridge || !model) return
    setError('')
    try {
      for (const [n, media] of missing.entries()) {
        if (!media.path) throw new Error(`${media.name} has no file path: import it again in the desktop app`)
        setBusy({ phase: 'transcribe', progress: 0, label: `${media.name} (${n + 1}/${missing.length})` })
        const result = await bridge.transcribe({
          path: media.path,
          start: 0,
          duration: media.duration / FLICKS_PER_SECOND,
          model,
          language
        })
        A.setTranscript(media.id, { language, model, words: alignWords(result) })
      }
      A.setStatus('Transcript ready: select words and press Delete to cut them')
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err))
    } finally {
      setBusy(null)
    }
  }

  const downloadBase = async (): Promise<void> => {
    if (!bridge) return
    setError('')
    setBusy({ phase: 'download', progress: 0, label: 'Whisper base model (148 MB)' })
    try {
      await bridge.downloadModel('base')
      setStatus(await bridge.captionsStatus())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  let notice = ''
  if (!trackId) notice = 'Add a clip with speech to the timeline.'
  else if (missing.length > 0 && !bridge) notice = 'Transcription runs in the desktop app (npm run dev).'
  else if (missing.length > 0 && status && !status.whisper) notice = 'FFmpeg with the "whisper" filter is needed (see README).'

  return (
    <div className="transcript">
      <div className="ex-bar">
        {candidates.length > 1 && (
          <select className="select" value={trackId ?? ''} title="Track to read" onChange={(e) => setChosen(e.target.value)}>
            {candidates.map((id) => {
              const index = project.tracks.findIndex((t) => t.id === id)
              const track = project.tracks[index]
              return (
                <option key={id} value={id}>
                  {index + 1}. {track?.name || (track?.kind === 'audio' ? 'Audio' : 'Video')}
                </option>
              )
            })}
          </select>
        )}
        {missing.length > 0 && bridge && (
          <>
            <select className="select" value={language} title="Spoken language" onChange={(e) => setLanguage(e.target.value)}>
              {LANGUAGES.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
            {model ? (
              <button className="btn small primary" disabled={busy !== null} onClick={() => void transcribe()}>
                Transcribe {missing.length > 1 ? `${missing.length} files` : ''}
              </button>
            ) : (
              <button className="btn small" disabled={busy !== null || !status?.whisper} onClick={() => void downloadBase()}>
                <Download size={13} /> Get Whisper (148 MB)
              </button>
            )}
          </>
        )}
        {words.length > 0 && (
          <>
            <button className="btn small" disabled={picked.size === 0} title="Cut the selected words (Delete)" onClick={() => remove(picked)}>
              <Scissors size={13} /> Delete{picked.size > 0 ? ` ${picked.size}` : ''}
            </button>
            <button className="btn small" disabled={fillers.length === 0} title="Select ehm, uhm and repeated words" onClick={() => setPicked(new Set(fillers))}>
              Fillers {fillers.length}
            </button>
            <button
              className="btn small"
              disabled={maybes.length === 0}
              title="Also select cioè, tipo, allora, praticamente… (check them before deleting)"
              onClick={() => setPicked((p) => new Set([...p, ...maybes]))}
            >
              + cioè, tipo… {maybes.length}
            </button>
            <button className="btn small" disabled={pauses.length === 0} title={`Shorten pauses longer than ${PAUSE_MIN} s to ${PAUSE_KEEP} s`} onClick={cutPauses}>
              Pauses {pauses.length}
            </button>
          </>
        )}
      </div>
      {busy && (
        <BoarProgress value={busy.progress} className="tr-busy">
          {busy.phase === 'download' ? 'Downloading' : 'Transcribing'} {busy.label} {Math.round(busy.progress * 100)}%
        </BoarProgress>
      )}
      {error && <div className="render-result error">{error}</div>}
      {notice && <p className="dim tr-notice">{notice}</p>}
      <div
        className="tr-text"
        ref={textRef}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => (dragging.current = false)}
        onKeyDown={onKeyDown}
      >
        {words.length === 0 && !notice && missing.length === 0 && <p className="dim">No speech found on this track.</p>}
        {words.length === 0 && missing.length > 0 && bridge && (
          <p className="dim">
            Transcribe the track to edit it as text: delete words and the video is cut with them. Nothing leaves this PC.
          </p>
        )}
        {paragraphs.map((p) => (
          <p key={p.start} className="tr-paragraph">
            <span className="tr-time">{formatTimecode(p.start, rate)}</span>
            {p.tokens.map((t) =>
              t.kind === 'word' ? (
                <span
                  key={t.i}
                  data-i={t.i}
                  className={`tr-word${t.flag ? ` ${t.flag}` : ''}${picked.has(t.i) ? ' selected' : ''}`}
                  title={t.flag === 'filler' ? 'Filler' : t.flag === 'repeat' ? 'Repeated word' : t.flag === 'maybe' ? 'Possible filler' : undefined}
                >
                  {t.word.text}{' '}
                </span>
              ) : t.kind === 'pause' ? (
                <span key={t.key} className="tr-pause">
                  {seconds(t.length)}{' '}
                </span>
              ) : (
                <span key={t.key} className="tr-cut" title="Cut" />
              )
            )}
          </p>
        ))}
      </div>
      {words.length > 0 && (
        <div className="ex-bar tr-footer">
          <span className="dim">
            {words.length} words
            {picked.size > 0 ? ` · ${picked.size} selected (${seconds(pickedLength)})` : ' · click a word to jump, drag to select'}
          </span>
          <select className="select" value={style} title="Caption look" onChange={(e) => setStyle(e.target.value)}>
            {CAPTION_STYLES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <button className="btn small" title="Captions for the edited track, word-timed from the transcript" onClick={makeCaptions}>
            <Captions size={13} /> Captions
          </button>
        </div>
      )}
    </div>
  )
}

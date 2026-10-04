import { useEffect, useState } from 'react'
import { AudioLines, Download, FolderPlus, GripVertical, ListPlus, RefreshCw } from 'lucide-react'
import * as A from '../core/actions'
import { mediaById, useEditor } from '../core/store'
import { importPaths } from '../media/importer'
import { type LibraryFolder, type YoutubeProgress, type YoutubeStatus, bridge } from '../platform'
import { BoarProgress } from './BoarProgress'
import { FloatingWindow } from './FloatingWindow'
import { startMediaDrag } from './mediaDrag'

const QUALITIES = [
  { label: 'Best available', height: 0 },
  { label: '1080p', height: 1080 },
  { label: '720p', height: 720 },
  { label: '480p', height: 480 }
]

const cleanError = (err: unknown): string =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err)

/** The last download: drag it to the timeline or add it at the cursor. */
function Downloaded({ mediaId }: { mediaId: string }): React.JSX.Element | null {
  const media = useEditor((s) => s.media.find((m) => m.id === mediaId))
  if (!media) return null
  const ready = media.status === 'ready'
  return (
    <div
      className="yt-result"
      title="Drag to the timeline"
      onPointerDown={(e) => {
        if (e.button === 0 && ready && !(e.target as HTMLElement).closest('button')) startMediaDrag(media.id, e.clientX, e.clientY)
      }}
    >
      <GripVertical size={14} className="dim" />
      <div className="yt-thumb">{media.poster ? <img src={media.poster} alt="" draggable={false} /> : <AudioLines size={18} />}</div>
      <div className="yt-name">
        <b>{media.name}</b>
        <span className="dim">{ready ? 'In Project Media: drag it to the timeline' : 'Importing…'}</span>
      </div>
      <button className="btn small" disabled={!ready} onClick={() => A.addMediaToTimeline(media.id, useEditor.getState().cursor)}>
        <ListPlus size={13} /> Add at Cursor
      </button>
    </div>
  )
}

/** Downloads a video (MP4) or its sound from a link with yt-dlp into a library folder, then imports it. */
export function YoutubeDialog(): React.JSX.Element {
  const [status, setStatus] = useState<YoutubeStatus | null>(null)
  const [folders, setFolders] = useState<LibraryFolder[]>([])
  const [url, setUrl] = useState('')
  const [format, setFormat] = useState<'mp4' | 'audio'>('mp4')
  const [height, setHeight] = useState(1080)
  const [folder, setFolder] = useState('')
  const [last, setLast] = useState<string | null>(null)
  const [busy, setBusy] = useState<YoutubeProgress | null>(null)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)

  const refresh = async (): Promise<void> => {
    if (!bridge) return
    const [s, f] = await Promise.all([bridge.youtubeStatus(), bridge.libraryFolders()])
    setStatus(s)
    setFolders(f)
    setFolder((current) => (current && f.some((x) => x.path === current) ? current : (f[0]?.path ?? '')))
  }

  useEffect(() => {
    if (!bridge) return
    void refresh()
    // A link already copied in the browser is filled in.
    void navigator.clipboard
      ?.readText()
      .then((text) => /^https?:\/\/\S+$/.test(text.trim()) && setUrl((u) => u || text.trim()))
      .catch(() => undefined)
    return bridge.onYoutubeProgress(setBusy)
  }, [])

  const run = async (job: () => Promise<void>): Promise<void> => {
    setMessage(null)
    setBusy({ phase: 'download', progress: 0, text: 'Starting…' })
    try {
      await job()
    } catch (err) {
      setMessage({ text: cleanError(err), error: true })
    } finally {
      setBusy(null)
    }
  }

  const download = (toTimeline: boolean): Promise<void> =>
    run(async () => {
      if (!bridge) return
      const path = await bridge.downloadYoutube({ url: url.trim(), format, maxHeight: format === 'mp4' ? height : 0, folder })
      const pending = importPaths([path])[0]
      // The card shows up while the file is imported.
      const known = useEditor.getState().media.find((m) => m.path === path)
      if (known) setLast(known.id)
      const media = await pending
      if (media) {
        setLast(media.id)
        if (toTimeline) A.addMediaToTimeline(media.id, useEditor.getState().cursor)
      }
      setMessage({ text: toTimeline && media ? `Added to the timeline: ${path}` : `Saved ${path}`, error: false })
      setUrl('')
    })

  const addFolder = async (): Promise<void> => {
    const path = await bridge?.addLibraryFolder()
    if (path) {
      await refresh()
      setFolder(path)
    }
  }

  let blocker = ''
  if (!bridge) blocker = 'Downloads work in the desktop app (npm run dev), not in the browser preview.'
  else if (folders.length === 0) blocker = 'Add a library folder for the downloads.'

  const ready = !busy && !blocker && !!status?.ytdlp && !!url.trim() && !!folder
  return (
    <FloatingWindow id="youtube" className="youtube-window" title="Download from Link (YouTube and more)">
      <div className="modal-body">
        <div className="form">
          <label>Link</label>
          <input
            className="input"
            placeholder="https://www.youtube.com/watch?v=…"
            value={url}
            autoFocus
            spellCheck={false}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && ready && void download(true)}
          />
          <label>Format</label>
          <div className="te-control">
            <label className="te-check">
              <input type="radio" name="yt-format" checked={format === 'mp4'} onChange={() => setFormat('mp4')} />
              Video (MP4)
            </label>
            <label className="te-check" title="The original sound, not converted (M4A from most sites)">
              <input type="radio" name="yt-format" checked={format === 'audio'} onChange={() => setFormat('audio')} />
              Audio only
            </label>
            {format === 'mp4' && (
              <select className="select" value={height} onChange={(e) => setHeight(Number(e.target.value))}>
                {QUALITIES.map((q) => (
                  <option key={q.height} value={q.height}>
                    {q.label}
                  </option>
                ))}
              </select>
            )}
          </div>
          <label>Save to</label>
          <div className="te-control">
            <select className="select" style={{ flex: 1 }} value={folder} onChange={(e) => setFolder(e.target.value)}>
              {folders.length === 0 && <option value="">No library folders</option>}
              {folders.map((f) => (
                <option key={f.path} value={f.path}>
                  {f.path}
                </option>
              ))}
            </select>
            <button className="tool-btn" title="Add a library folder" onClick={() => void addFolder()}>
              <FolderPlus size={14} />
            </button>
          </div>
          <label>Downloader</label>
          <div className="te-control">
            {status?.ytdlp ? (
              <>
                <span className="dim">yt-dlp {status.ytdlp.version}</span>
                <button
                  className="btn small"
                  disabled={busy !== null}
                  title="Sites change often: update when downloads start failing"
                  onClick={() =>
                    void run(async () => {
                      const out = await bridge?.updateYtDlp()
                      await refresh()
                      setMessage({ text: out || 'Updated', error: false })
                    })
                  }
                >
                  <RefreshCw size={12} /> Update
                </button>
              </>
            ) : status ? (
              <button
                className="btn small"
                disabled={busy !== null}
                onClick={() =>
                  void run(async () => {
                    await bridge?.installYtDlp()
                    await refresh()
                  })
                }
              >
                <Download size={12} /> Install yt-dlp (about 18 MB, from GitHub)
              </button>
            ) : (
              <span className="dim">Checking…</span>
            )}
          </div>
        </div>
        <p className="dim">Download only content you own or have permission to use.</p>

        {busy && (
          <BoarProgress value={busy.progress}>{busy.text}</BoarProgress>
        )}
        {last && mediaById(last) && <Downloaded mediaId={last} />}
        {(blocker || message) && (
          <div className={`render-result${message && !message.error ? '' : ' error'}`}>{message?.text ?? blocker}</div>
        )}

        <div className="modal-actions">
          {busy ? (
            <button className="btn" onClick={() => void bridge?.cancelYoutube()}>
              Cancel
            </button>
          ) : (
            <button className="btn" onClick={A.closeDialog}>
              Close
            </button>
          )}
          <button className="btn" disabled={!ready} title="Download into the library folder and Project Media" onClick={() => void download(false)}>
            <Download size={13} /> Download
          </button>
          <button className="btn primary" disabled={!ready} title="Download, then put it on the timeline at the cursor (Enter)" onClick={() => void download(true)}>
            <ListPlus size={13} /> Download and Add to Timeline
          </button>
        </div>
      </div>
    </FloatingWindow>
  )
}

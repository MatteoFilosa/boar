import { useEffect, useState } from 'react'
import { Download, FolderPlus, RefreshCw, X } from 'lucide-react'
import * as A from '../core/actions'
import { useEditor } from '../core/store'
import { importPaths } from '../media/importer'
import { type LibraryFolder, type YoutubeProgress, type YoutubeStatus, bridge } from '../platform'
import { BoarProgress } from './BoarProgress'

const QUALITIES = [
  { label: 'Best available', height: 0 },
  { label: '1080p', height: 1080 },
  { label: '720p', height: 720 },
  { label: '480p', height: 480 }
]

const cleanError = (err: unknown): string =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err)

/** Downloads a video (MP4) or its audio (MP3) from a link with yt-dlp into a library folder, then imports it. */
export function YoutubeDialog(): React.JSX.Element {
  const [status, setStatus] = useState<YoutubeStatus | null>(null)
  const [folders, setFolders] = useState<LibraryFolder[]>([])
  const [url, setUrl] = useState('')
  const [format, setFormat] = useState<'mp4' | 'mp3'>('mp4')
  const [height, setHeight] = useState(1080)
  const [folder, setFolder] = useState('')
  const [toTimeline, setToTimeline] = useState(true)
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

  const download = (): Promise<void> =>
    run(async () => {
      if (!bridge) return
      const path = await bridge.downloadYoutube({ url: url.trim(), format, maxHeight: format === 'mp4' ? height : 0, folder })
      const media = await importPaths([path])[0]
      if (media && toTimeline) A.addMediaToTimeline(media.id, useEditor.getState().cursor)
      setMessage({ text: `Saved ${path}`, error: false })
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
  else if (status && !status.ffmpeg) blocker = 'FFmpeg was not found in PATH (needed to merge video and audio and to make MP3s).'
  else if (folders.length === 0) blocker = 'Add a library folder for the downloads.'

  return (
    <div className="modal-backdrop">
      <div className="modal" style={{ width: 560 }} role="dialog" aria-label="Download from link">
        <div className="modal-title">
          <span>Download from Link (YouTube and more)</span>
          <button className="tool-btn" title="Close (Esc)" disabled={busy !== null} onClick={A.closeDialog}>
            <X size={14} />
          </button>
        </div>
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
              onKeyDown={(e) => e.key === 'Enter' && url.trim() && !blocker && status?.ytdlp && !busy && void download()}
            />
            <label>Format</label>
            <div className="te-control">
              <label className="te-check">
                <input type="radio" name="yt-format" checked={format === 'mp4'} onChange={() => setFormat('mp4')} />
                Video (MP4)
              </label>
              <label className="te-check">
                <input type="radio" name="yt-format" checked={format === 'mp3'} onChange={() => setFormat('mp3')} />
                Audio only (MP3)
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
            <label />
            <label className="te-check">
              <input type="checkbox" checked={toTimeline} onChange={(e) => setToTimeline(e.target.checked)} />
              Add to the timeline at the cursor
            </label>
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
            <button
              className="btn primary"
              disabled={busy !== null || !!blocker || !status?.ytdlp || !url.trim() || !folder}
              onClick={() => void download()}
            >
              <Download size={13} /> Download
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

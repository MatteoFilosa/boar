import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowUp,
  AudioLines,
  Download,
  Film,
  Folder,
  FolderOpen,
  FolderPlus,
  Image as ImageIcon,
  Pause,
  Play,
  RefreshCw,
  Search,
  X
} from 'lucide-react'
import * as A from '../core/actions'
import { useEditor } from '../core/store'
import { importPaths, kindOfName } from '../media/importer'
import { type LibraryEntry, type LibraryFolder, bridge, mediaPathUrl } from '../platform'
import { startMediaDrag } from './mediaDrag'

const LAST_FOLDER = 'boar.explorer.folder'

const formatSize = (bytes: number): string =>
  bytes >= 1024 * 1024 * 1024
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : bytes >= 1024 * 1024
      ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`

/** One audio element shared by the list: click an audio file to hear it, click again to stop. */
let previewAudio: HTMLAudioElement | null = null

/** Library folders (Explorer tab): browse sound effects and stock media, drag them to the timeline. */
export function Explorer(): React.JSX.Element {
  const [folders, setFolders] = useState<LibraryFolder[]>([])
  const [root, setRoot] = useState<string | null>(() => {
    try {
      return localStorage.getItem(LAST_FOLDER)
    } catch {
      return null
    }
  })
  const [dir, setDir] = useState<string | null>(null)
  const [entries, setEntries] = useState<LibraryEntry[]>([])
  const [filter, setFilter] = useState('')
  const [playing, setPlaying] = useState<string | null>(null)
  const [error, setError] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const linkDownloads = useEditor((s) => s.options.linkDownloads)

  const refreshFolders = useCallback(async () => {
    if (!bridge) return
    const list = await bridge.libraryFolders()
    setFolders(list)
    setRoot((current) => (current && list.some((f) => f.path === current) ? current : (list[0]?.path ?? null)))
  }, [])

  useEffect(() => {
    void refreshFolders()
  }, [refreshFolders])

  useEffect(() => {
    try {
      if (root) localStorage.setItem(LAST_FOLDER, root)
    } catch {
      // Not remembered: the first folder opens next time.
    }
    setDir(root)
  }, [root])

  const load = useCallback(async (path: string | null) => {
    if (!bridge || !path) {
      setEntries([])
      return
    }
    try {
      setError('')
      setEntries(await bridge.listLibrary(path))
    } catch (err) {
      setEntries([])
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err))
    }
  }, [])

  useEffect(() => {
    void load(dir)
    listRef.current?.scrollTo(0, 0)
  }, [dir, load])

  useEffect(
    () => () => {
      previewAudio?.pause()
    },
    []
  )

  const togglePreview = (entry: LibraryEntry): void => {
    if (!previewAudio) {
      previewAudio = new Audio()
      previewAudio.onended = () => setPlaying(null)
    }
    if (playing === entry.path) {
      previewAudio.pause()
      setPlaying(null)
      return
    }
    previewAudio.src = mediaPathUrl(entry.path)
    void previewAudio.play().catch(() => setPlaying(null))
    setPlaying(entry.path)
  }

  const addToTimeline = (entry: LibraryEntry): void => {
    void importPaths([entry.path])[0].then((media) => media && A.addMediaToTimeline(media.id, useEditor.getState().cursor))
  }

  const api = bridge
  if (!api) {
    return <div className="planned">The Explorer works in the desktop app (npm run dev), not in the browser preview.</div>
  }

  const addFolder = async (): Promise<void> => {
    const path = await api.addLibraryFolder()
    if (!path) return
    await refreshFolders()
    setRoot(path)
  }

  const q = filter.trim().toLowerCase()
  const shown = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries
  const rootFolder = folders.find((f) => f.path === root)
  const relative = dir && root && dir !== root ? dir.slice(root.length).replace(/^[\\/]/, '') : ''

  return (
    <div className="explorer">
      <div className="ex-bar">
        <select className="select ex-folder" value={root ?? ''} onChange={(e) => setRoot(e.target.value || null)} title="Library folder">
          {folders.length === 0 && <option value="">No folders yet</option>}
          {folders.map((f) => (
            <option key={f.path} value={f.path}>
              {f.name}
              {f.exists ? '' : ' (missing)'}
            </option>
          ))}
        </select>
        <button className="tool-btn" title="Add a folder (sound effects, stock footage, downloads…)" onClick={() => void addFolder()}>
          <FolderPlus size={14} />
        </button>
        {root && (
          <>
            <button
              className="tool-btn"
              title="Remove this folder from the library (the files stay on disk)"
              onClick={() => void api.removeLibraryFolder(root).then(refreshFolders)}
            >
              <X size={14} />
            </button>
            <button className="tool-btn" title="Show in File Explorer" onClick={() => void api.revealInLibrary(dir ?? root)}>
              <FolderOpen size={14} />
            </button>
            <button className="tool-btn" title="Refresh" onClick={() => void load(dir)}>
              <RefreshCw size={14} />
            </button>
          </>
        )}
        {linkDownloads && (
          <button className="tool-btn labeled" title="Download from a link into a library folder" onClick={() => A.openDialog({ kind: 'youtube' })}>
            <Download size={14} />
            <span>Link</span>
          </button>
        )}
        <div className="ex-search">
          <Search size={13} />
          <input className="input" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      </div>
      {root && (
        <div className="ex-path">
          <button className="tool-btn" disabled={!relative} title="Up one folder" onClick={() => dir && setDir(dir.replace(/[\\/][^\\/]+$/, ''))}>
            <ArrowUp size={13} />
          </button>
          <span title={dir ?? ''}>
            {rootFolder?.name}
            {relative ? ` › ${relative.split(/[\\/]/).join(' › ')}` : ''}
          </span>
        </div>
      )}
      <div className="ex-list" ref={listRef}>
        {folders.length === 0 && (
          <div className="ex-empty">
            <p>Add the folders you take media from — for example your Sound Effects folder — and drag files straight onto the timeline.</p>
            <button className="btn primary" onClick={() => void addFolder()}>
              <FolderPlus size={13} /> Add folder…
            </button>
          </div>
        )}
        {error && <div className="ex-empty error">{error}</div>}
        {shown.map((entry) => {
          const kind = entry.dir ? null : kindOfName(entry.name)
          const Icon = entry.dir ? Folder : kind === 'audio' ? AudioLines : kind === 'image' ? ImageIcon : Film
          return (
            <div
              key={entry.path}
              className={`ex-item${playing === entry.path ? ' playing' : ''}`}
              title={entry.dir ? entry.name : `${entry.name}\nDrag to the timeline · double-click: add at the cursor${kind === 'audio' ? ' · click ▶ to listen' : ''}`}
              onPointerDown={(e) => {
                if (e.button !== 0 || entry.dir || (e.target as HTMLElement).closest('button')) return
                startMediaDrag(`path:${entry.path}`, e.clientX, e.clientY)
              }}
              onDoubleClick={() => (entry.dir ? setDir(entry.path) : addToTimeline(entry))}
            >
              {kind === 'audio' ? (
                <button className="ex-play" title={playing === entry.path ? 'Stop' : 'Listen'} onClick={() => togglePreview(entry)}>
                  {playing === entry.path ? <Pause size={12} /> : <Play size={12} />}
                </button>
              ) : (
                <span className="ex-icon">
                  <Icon size={14} />
                </span>
              )}
              <span className="ex-name">{entry.name}</span>
              {!entry.dir && <span className="ex-size">{formatSize(entry.size)}</span>}
            </div>
          )
        })}
        {root && !error && entries.length === 0 && <div className="ex-empty">No media files in this folder.</div>}
      </div>
    </div>
  )
}

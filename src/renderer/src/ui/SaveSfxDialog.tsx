import { useEffect, useState } from 'react'
import { FolderPlus, Save, X } from 'lucide-react'
import * as A from '../core/actions'
import { mediaById, useEditor } from '../core/store'
import { activeFx } from '../core/fx'
import { flicksToSeconds } from '../core/time'
import { renderEventAudio } from '../engine/export'
import { encodeWav } from '../media/wav'
import { type LibraryFolder, bridge } from '../platform'

const LAST_SFX_FOLDER = 'boar.sfx.folder'

function lastFolder(): string {
  try {
    return localStorage.getItem(LAST_SFX_FOLDER) ?? ''
  } catch {
    return ''
  }
}

/** Saves an audio event (trimmed, with fades and optionally its Audio FX) as a WAV in a library folder. */
export function SaveSfxDialog({ eventId }: { eventId: string }): React.JSX.Element | null {
  const event = useEditor((s) => s.project.events.find((e) => e.id === eventId))
  const media = event ? mediaById(event.mediaId) : undefined
  const [folders, setFolders] = useState<LibraryFolder[]>([])
  const [folder, setFolder] = useState(lastFolder)
  const [name, setName] = useState(() => (media?.name ?? 'Sound effect').replace(/\.[^.]+$/, ''))
  const [withFx, setWithFx] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)

  const refresh = async (): Promise<void> => {
    if (!bridge) return
    const list = await bridge.libraryFolders()
    setFolders(list)
    setFolder((current) => (list.some((f) => f.path === current) ? current : (list[0]?.path ?? '')))
  }

  useEffect(() => {
    void refresh()
  }, [])
  useEffect(() => {
    if (!event) A.closeDialog()
  }, [event])
  if (!event) return null

  const hasFx = activeFx(event.fx, 'audio').length > 0
  const save = async (): Promise<void> => {
    if (!bridge || !folder) return
    setBusy(true)
    setMessage(null)
    try {
      const audio = await renderEventAudio(event, withFx)
      if (!audio) throw new Error('This event has no sound')
      const path = await bridge.saveToLibrary(folder, name.trim() || 'Sound effect', 'wav', encodeWav(audio))
      try {
        localStorage.setItem(LAST_SFX_FOLDER, folder)
      } catch {
        // Not remembered: the first folder is proposed next time.
      }
      A.setStatus(`Sound effect saved: ${path}`)
      A.closeDialog()
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err), error: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal" style={{ width: 500 }} role="dialog" aria-label="Save as sound effect">
        <div className="modal-title">
          <span>Save as Sound Effect</span>
          <button className="tool-btn" title="Close (Esc)" disabled={busy} onClick={A.closeDialog}>
            <X size={14} />
          </button>
        </div>
        <div className="modal-body">
          <p className="dim">
            The event is saved as a WAV file ({flicksToSeconds(event.length).toFixed(2)} s) in a library folder, ready to
            drag from the Explorer tab into any project.
          </p>
          <div className="form">
            <label>Name</label>
            <input className="input" value={name} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void save()} />
            <label>Folder</label>
            <div className="te-control">
              <select className="select" style={{ flex: 1 }} value={folder} onChange={(e) => setFolder(e.target.value)}>
                {folders.length === 0 && <option value="">No library folders</option>}
                {folders.map((f) => (
                  <option key={f.path} value={f.path}>
                    {f.path}
                  </option>
                ))}
              </select>
              <button
                className="tool-btn"
                title="Add a library folder"
                onClick={() =>
                  void bridge?.addLibraryFolder().then(async (path) => {
                    await refresh()
                    if (path) setFolder(path)
                  })
                }
              >
                <FolderPlus size={14} />
              </button>
            </div>
            <label />
            <label className="te-check">
              <input type="checkbox" checked={withFx} disabled={!hasFx} onChange={(e) => setWithFx(e.target.checked)} />
              Include Audio FX {hasFx ? '' : '(this event has none)'}
            </label>
          </div>
          {!bridge && <div className="render-result error">Saving works in the desktop app.</div>}
          {message && <div className={`render-result${message.error ? ' error' : ''}`}>{message.text}</div>}
          <div className="modal-actions">
            <button className="btn" disabled={busy} onClick={A.closeDialog}>
              Cancel
            </button>
            <button className="btn primary" disabled={busy || !bridge || !folder} onClick={() => void save()}>
              <Save size={13} /> {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

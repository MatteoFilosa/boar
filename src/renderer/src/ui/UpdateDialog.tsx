import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import * as A from '../core/actions'
import { useEditor } from '../core/store'
import { type UpdateInfo, bridge } from '../platform'

type Phase = 'idle' | 'downloading' | 'ready' | 'failed'

/** Message of an error thrown in the main process, without the IPC wrapper. */
const reason = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Update available (at startup or from Help › Check for Updates), or the result of a manual check. */
export function UpdateDialog({ info, error }: { info: UpdateInfo | null; error?: string }): React.JSX.Element {
  const checkUpdates = useEditor((s) => s.options.checkUpdates)
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState(0)
  const [failure, setFailure] = useState('')

  useEffect(() => bridge?.onUpdateProgress(setProgress), [])
  // Closing the window stops a download in progress.
  useEffect(() => () => void bridge?.cancelUpdate(), [])

  const download = async (): Promise<void> => {
    if (!bridge) return
    setPhase('downloading')
    setProgress(0)
    try {
      await bridge.downloadUpdate()
      setPhase('ready')
    } catch (err) {
      if (/abort/i.test(reason(err))) {
        setPhase('idle')
        return
      }
      setFailure(reason(err))
      setPhase('failed')
    }
  }

  const install = async (now: boolean): Promise<void> => {
    if (!bridge) return
    try {
      await bridge.installUpdate(now)
      if (!now || info?.mode === 'open') A.closeDialog()
    } catch (err) {
      setFailure(reason(err))
      setPhase('failed')
    }
  }

  const available = !!info?.available
  const disk = info?.file?.name.endsWith('.dmg')
  let body: React.ReactNode
  if (error) body = <p>Could not check for updates: {error}</p>
  else if (!info) body = <p>This copy of Boar runs from the sources: update it with git pull.</p>
  else if (!info.available) body = <p>Boar {info.current} is up to date.</p>
  else {
    body = (
      <>
        <p>
          <b>Boar {info.latest}</b> is available. You have {info.current}.{' '}
          <button className="link-btn" onClick={() => void bridge?.openUpdatePage()}>
            What's new
          </button>
        </p>
        {!info.file && <p className="dim">This release has no installer for this system: get it from the release page.</p>}
        {phase === 'downloading' && (
          <div className="render-progress">
            <div className="render-bar">
              <div style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <div className="dim">
              Downloading {info.file?.name} {Math.round(progress * 100)}%
            </div>
          </div>
        )}
        {phase === 'ready' && (
          <p>
            {info.mode === 'restart'
              ? 'Ready to install: Boar closes, updates and starts again. Unsaved changes are asked about first.'
              : disk
                ? 'Downloaded: in the disk image, drag Boar into Applications to replace this version, then open it again.'
                : 'Downloaded: open the package to install it with the system installer, then open Boar again.'}
          </p>
        )}
        {phase === 'failed' && <div className="render-result error">{failure}</div>}
      </>
    )
  }

  return (
    <div className="modal-backdrop">
      <div className="modal" style={{ width: 460 }} role="dialog" aria-label="Updates">
        <div className="modal-title">
          <span>{available ? 'Update available' : 'Updates'}</span>
          <button className="tool-btn" title="Close (Esc)" onClick={A.closeDialog}>
            <X size={14} />
          </button>
        </div>
        <div className="modal-body">
          {body}
          <div className="modal-actions">
            {available && (
              <label className="te-check update-startup" title="Check again from Help › Check for Updates">
                <input type="checkbox" checked={!checkUpdates} onChange={(e) => A.setOption('checkUpdates', !e.target.checked)} />
                Don't show this at startup
              </label>
            )}
            {available && info?.file && (phase === 'idle' || phase === 'failed') && (
              <>
                <button className="btn primary" onClick={() => void download()}>
                  Update ({Math.round(info.file.size / 1048576)} MB)
                </button>
                <button className="btn" onClick={A.closeDialog}>
                  Later
                </button>
              </>
            )}
            {available && !info?.file && (
              <button className="btn primary" onClick={() => void bridge?.openUpdatePage()}>
                Open Release Page
              </button>
            )}
            {phase === 'downloading' && (
              <button className="btn" onClick={() => void bridge?.cancelUpdate()}>
                Cancel
              </button>
            )}
            {phase === 'ready' && (
              <>
                <button className="btn primary" onClick={() => void install(true)}>
                  {info?.mode === 'restart' ? 'Restart Now' : 'Open'}
                </button>
                {info?.mode === 'restart' && (
                  <button className="btn" title="Installs when you close Boar" onClick={() => void install(false)}>
                    Later
                  </button>
                )}
              </>
            )}
            {!available && (
              <button className="btn primary" onClick={A.closeDialog}>
                OK
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

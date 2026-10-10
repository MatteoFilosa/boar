import { useEffect, useSyncExternalStore } from 'react'
import { X } from 'lucide-react'
import * as A from '../core/actions'
import { cancelReverse, currentReverseJob, onReverseJob } from '../engine/reverse'
import { BoarProgress, celebrate } from './BoarProgress'

/** Progress of Reverse while it writes a reversed copy (engine/reverse.ts). Closing it (Esc too) cancels. */
export function ReverseDialog(): React.JSX.Element {
  const job = useSyncExternalStore(onReverseJob, currentReverseJob)
  const running = job?.state === 'running'

  useEffect(() => {
    if (job?.state === 'done') {
      celebrate(job.message)
      A.closeDialog()
    } else if (job?.state === 'cancelled' || !job) {
      A.closeDialog()
    }
  }, [job])

  const close = (): void => {
    if (running) cancelReverse()
    else A.closeDialog()
  }

  return (
    <div className="modal-backdrop">
      <div className="modal" style={{ width: 480 }} role="dialog" aria-label="Reverse">
        <div className="modal-title">
          <span>Reverse</span>
          <button className="tool-btn" title="Close (Esc)" onClick={close}>
            <X size={14} />
          </button>
        </div>
        <div className="modal-body">
          <p className="dim">
            Making a copy of <b>{job?.label || 'the clip'}</b> that plays backwards, picture and sound. It stays with your
            media, so reversing the clip again (or another clip of the same file) is instant.
          </p>
          {running && <BoarProgress value={job.progress}>Reversing… {Math.round(job.progress * 100)}%</BoarProgress>}
          {job?.state === 'failed' && <div className="render-result error">{job.message}</div>}
          <div className="modal-actions">
            <button className="btn" onClick={close}>
              {running ? 'Cancel' : 'Close'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

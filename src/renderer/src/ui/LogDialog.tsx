import { useEffect, useRef, useState } from 'react'
import { Check, Copy, FolderOpen, MessageSquareWarning, X } from 'lucide-react'
import * as A from '../core/actions'
import { bridge } from '../platform'

/**
 * Help › Problem Log: what Boar wrote down about renders, crashes and errors
 * (src/main/log.ts), to copy into a problem report. Opens by itself after Boar
 * or its page stopped unexpectedly, with `notice` saying so.
 */
export function LogDialog({ notice }: { notice?: string }): React.JSX.Element {
  const [log, setLog] = useState<{ text: string; path: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const box = useRef<HTMLPreElement>(null)

  useEffect(() => {
    if (bridge) void bridge.readLog().then(setLog)
  }, [])
  // The newest lines are at the end.
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight
  }, [log])

  const copy = (): void => {
    if (!log) return
    void navigator.clipboard.writeText(log.text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && A.closeDialog()}>
      <div className="modal" style={{ width: 760 }} role="dialog" aria-label="Problem Log">
        <div className="modal-title">
          <span>Problem Log</span>
          <button className="tool-btn" title="Close (Esc)" onClick={A.closeDialog}>
            <X size={14} />
          </button>
        </div>
        <div className="modal-body">
          {notice && <div className="render-result error log-notice">{notice} The log below may tell why.</div>}
          {bridge ? (
            <>
              <p className="dim">
                What Boar wrote down about renders, crashes and errors. Nothing is sent: copy it into a problem report. Paths in
                your user folder are written as ~.
              </p>
              <div className="agent-copy log-box">
                <div className="agent-copy-head">
                  <span>{log ? log.path : 'Reading…'}</span>
                  <button className="btn small" disabled={!log?.text} onClick={copy}>
                    {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <pre ref={box}>{log ? log.text || 'Nothing written yet.' : ''}</pre>
              </div>
            </>
          ) : (
            <p className="dim">The problem log is kept by the desktop app.</p>
          )}
          <div className="modal-actions">
            {bridge && (
              <button className="btn" onClick={() => void bridge?.revealLog()}>
                <FolderOpen size={13} /> Show in Folder
              </button>
            )}
            <button className="btn" onClick={() => A.openDialog({ kind: 'report' })}>
              <MessageSquareWarning size={13} /> Report a Problem...
            </button>
            <button className="btn primary" onClick={A.closeDialog}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

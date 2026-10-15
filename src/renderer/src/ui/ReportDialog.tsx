import { useEffect, useState } from 'react'
import { ExternalLink, X } from 'lucide-react'
import * as A from '../core/actions'
import { bridge } from '../platform'
import { type ExportCodec, audioSupport, encoderSupport } from '../engine/export'
import { CopyBox } from './AgentDialog'

const ISSUES = 'https://github.com/MatteoFilosa/boar/issues/new/choose'

const CODEC_NAMES: Record<ExportCodec, string> = { avc: 'H.264', hevc: 'HEVC', av1: 'AV1', vp9: 'VP9' }

/** Name of the graphics card as the browser engine sees it. */
function gpuName(): string {
  try {
    const gl = document.createElement('canvas').getContext('webgl2')
    if (!gl) return 'no WebGL2'
    const info = gl.getExtension('WEBGL_debug_renderer_info')
    const name = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return name
  } catch {
    return 'unknown'
  }
}

/** What a bug report needs to know about this copy of Boar and this machine. */
async function systemDetails(): Promise<string> {
  const system = bridge ? await bridge.systemInfo().catch(() => null) : null
  const [video, audio] = await Promise.all([encoderSupport(1920, 1080).catch(() => null), audioSupport().catch(() => null)])
  const encoders = video
    ? (Object.keys(CODEC_NAMES) as ExportCodec[])
        .map((c) => `${CODEC_NAMES[c]} ${[video[c].gpu && 'GPU', video[c].cpu && 'CPU'].filter(Boolean).join('+') || 'no'}`)
        .join(', ')
    : 'unknown'
  return [
    `Boar ${__APP_VERSION__}${system && !system.packaged ? ' (from the sources)' : ''}`,
    `System: ${system ? system.os : navigator.userAgent}`,
    ...(system ? [`Electron ${system.electron}, Chromium ${system.chrome}`] : []),
    `GPU: ${gpuName()}`,
    `Video encoders (1080p): ${encoders}`,
    `Audio encoders: ${audio ? [audio.aac && 'AAC', audio.opus && 'Opus'].filter(Boolean).join(', ') || 'none' : 'unknown'}`
  ].join('\n')
}

/** Help › Report a Problem: where to write, and the details to paste. Boar sends nothing itself. */
export function ReportDialog(): React.JSX.Element {
  const [details, setDetails] = useState('Reading…')
  useEffect(() => {
    void systemDetails().then(setDetails)
  }, [])
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && A.closeDialog()}>
      <div className="modal" style={{ width: 560 }} role="dialog" aria-label="Report a Problem">
        <div className="modal-title">
          <span>Report a Problem</span>
          <button className="tool-btn" title="Close (Esc)" onClick={A.closeDialog}>
            <X size={14} />
          </button>
        </div>
        <div className="modal-body">
          <p>
            Problems and ideas go on Boar's page on GitHub (a free account is needed). Say what you did, what you expected and
            what happened instead: a screen recording or the project file helps a lot.
          </p>
          <p className="dim">Paste these details into the report. Boar sends nothing by itself.</p>
          <CopyBox label="Details" text={details} />
          <div className="modal-actions">
            <button className="btn primary" onClick={() => window.open(ISSUES, '_blank', 'noopener')}>
              <ExternalLink size={13} /> Open the Issue Page
            </button>
            <button className="btn" onClick={A.closeDialog}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

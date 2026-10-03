import { useEffect, useState } from 'react'
import { Bot, Check, Copy, RefreshCw, X } from 'lucide-react'
import * as A from '../core/actions'
import { type AgentStatus, bridge } from '../platform'
import { shortcutLabel } from './shortcuts'
import { useAgentActivity } from '../agent/host'

function CopyBox({ label, text }: { label: string; text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <div className="agent-copy">
      <div className="agent-copy-head">
        <span>{label}</span>
        <button className="btn small" onClick={copy}>
          {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>{text}</pre>
    </div>
  )
}

const time = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** Options > AI Agents: lets MCP clients use the editor with the user's own plan. */
export function AgentDialog(): React.JSX.Element {
  const [status, setStatus] = useState<AgentStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [showToken, setShowToken] = useState(false)
  const log = useAgentActivity((s) => s.log)

  useEffect(() => {
    if (!bridge) return
    void bridge.agentStatus().then(setStatus)
    const timer = setInterval(() => void bridge?.agentStatus().then(setStatus), 3000)
    return () => clearInterval(timer)
  }, [])

  const toggle = async (enabled: boolean): Promise<void> => {
    if (!bridge) return
    setBusy(true)
    setStatus(await bridge.agentSetEnabled(enabled))
    setBusy(false)
  }

  const renew = async (): Promise<void> => {
    if (!bridge || !window.confirm('Make a new token? Agents set up with the old one must be set up again.')) return
    setStatus(await bridge.agentNewToken())
  }

  const token = status?.token ?? ''
  const bridgeArg = status?.bridgePath ?? ''
  const command = status?.bridgeCommand ?? 'node'
  const env = status?.bridgeEnv ?? {}
  const hasEnv = Object.keys(env).length > 0
  const httpConfig = JSON.stringify(
    { mcpServers: { boar: { type: 'http', url: status?.url ?? '', headers: { Authorization: `Bearer ${token}` } } } },
    null,
    2
  )
  const commandConfig = JSON.stringify({ mcpServers: { boar: { command, args: [bridgeArg], ...(hasEnv ? { env } : {}) } } }, null, 2)
  const tomlConfig = [
    '[mcp_servers.boar]',
    `command = '${command}'`,
    `args = ['${bridgeArg}']`,
    ...(hasEnv ? [`env = { ${Object.entries(env).map(([k, v]) => `${k} = "${v}"`).join(', ')} }`] : [])
  ].join('\n')

  return (
    <div className="modal-backdrop">
      <div className="modal agent-dialog" style={{ width: 720 }} role="dialog" aria-label="AI agents">
        <div className="modal-title">
          <span>AI Agents (MCP)</span>
          <button className="tool-btn" title="Close (Esc)" onClick={A.closeDialog}>
            <X size={14} />
          </button>
        </div>
        <div className="modal-body">
          <p className="dim">
            Let the AI agents you already use (desktop assistants, coding agents, AI editors) edit with Boar through the
            Model Context Protocol, with your own plan: no API keys or paid tokens here. Agents read the timeline and the
            transcripts (text), look at frames and make edits such as cutting fillers, captions, Shorts and chapters. Video and
            audio never leave this PC except the frames an agent asks to see; every edit can be undone with {shortcutLabel('undo')}.
          </p>
          {!bridge ? (
            <div className="render-result error">AI agents connect to the desktop app (npm run dev), not to the browser preview.</div>
          ) : (
            <>
              <label className="te-check agent-toggle">
                <input type="checkbox" checked={!!status?.enabled} disabled={busy || !status} onChange={(e) => void toggle(e.target.checked)} />
                <Bot size={15} /> Allow AI agents to use Boar
              </label>
              {status?.enabled && (
                <div className={`render-result ${status.listening ? 'ok' : 'error'}`}>
                  {status.listening
                    ? `Listening on ${status.url} (this PC only)${status.client ? ` · last agent: ${status.client}` : ''}`
                    : `Not running: ${status.error || 'unknown error'}`}
                </div>
              )}
              {status?.enabled && (
                <>
                  <div className="agent-token">
                    <span className="dim">Token</span>
                    <code>{showToken ? token : `${token.slice(0, 6)}${'•'.repeat(18)}`}</code>
                    <button className="btn small" onClick={() => setShowToken(!showToken)}>
                      {showToken ? 'Hide' : 'Show'}
                    </button>
                    <button className="btn small" title="Make a new token (agents must be set up again)" onClick={() => void renew()}>
                      <RefreshCw size={13} /> New
                    </button>
                  </div>
                  <CopyBox label="Agents that connect to a URL (HTTP): add to their MCP configuration" text={httpConfig} />
                  <CopyBox label="Agents that start a command (JSON configuration)" text={commandConfig} />
                  <CopyBox label="Agents with a TOML configuration" text={tomlConfig} />
                  <p className="dim agent-note">
                    Command-based agents start a small bridge{' '}
                    {hasEnv ? 'with Boar itself (no Node.js needed)' : 'with Node.js (node must be installed)'}; it reads the
                    port and token from {status.configPath}. Keep Boar open while the agent works. Try asking: "Remove the
                    fillers and add captions", or use the prompts make_shorts, clean_up_talking_head and youtube_chapters.
                  </p>
                </>
              )}
              <div className="agent-log">
                <div className="agent-log-title">Activity</div>
                {log.length === 0 ? (
                  <p className="dim">No requests yet.</p>
                ) : (
                  log.map((entry) => (
                    <div key={`${entry.id}-${entry.time}`} className={`agent-log-row${entry.ok ? '' : ' error'}`} title={entry.result}>
                      <span className="dim">{time(entry.time)}</span>
                      <b>{entry.tool}</b>
                      <span className="agent-log-args">{entry.args === '{}' ? '' : entry.args}</span>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
          <div className="modal-actions">
            <button className="btn" onClick={A.closeDialog}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

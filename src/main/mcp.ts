import { app, type BrowserWindow, ipcMain } from 'electron'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { allowMediaPaths } from './media-protocol'
import { isMediaFile } from './library'

// MCP server (Streamable HTTP, stateless, JSON responses) on 127.0.0.1 with a
// bearer token, off by default. The tools run in the renderer (agent/tools.ts);
// this file relays the JSON-RPC messages to the window.

const DEFAULT_PORT = 47811
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const MAX_BODY = 8 * 1024 * 1024

interface McpConfig {
  enabled: boolean
  port: number
  token: string
}

export interface McpStatus {
  enabled: boolean
  listening: boolean
  port: number
  url: string
  token: string
  error: string
  /** Name of the last agent that connected (from its initialize request). */
  client: string
  /** The stdio bridge for agents that launch servers as commands: command, args and environment. */
  bridgePath: string
  bridgeCommand: string
  bridgeEnv: Record<string, string>
  configPath: string
}

const INSTRUCTIONS =
  'Boar is a video editor with a multitrack timeline. Times are in seconds. ' +
  'Start with get_project; use get_transcript to read what is said (transcribe first if needed) and get_frame to see the picture. ' +
  'Every edit is one undo step in the editor (undo tool or Ctrl+Z). Prefer few, precise edits; tell the user what you changed.'

const newToken = (): string => randomBytes(24).toString('hex')
const configPath = (): string => join(app.getPath('userData'), 'mcp.json')

let config: McpConfig = { enabled: false, port: DEFAULT_PORT, token: newToken() }
let server: Server | null = null
let listening = false
let lastError = ''
let lastClient = ''
let mainWindow: () => BrowserWindow | null = () => null

async function loadConfig(): Promise<void> {
  try {
    const data = JSON.parse(await readFile(configPath(), 'utf8')) as Partial<McpConfig>
    config = {
      enabled: data.enabled === true,
      port: Number.isInteger(data.port) && (data.port as number) > 1024 && (data.port as number) < 65536 ? (data.port as number) : DEFAULT_PORT,
      token: typeof data.token === 'string' && data.token.length >= 32 ? data.token : newToken()
    }
  } catch {
    config = { enabled: false, port: DEFAULT_PORT, token: newToken() }
  }
}

async function saveConfig(): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(configPath(), JSON.stringify(config, null, 1), 'utf8')
}

// Renderer link

let nextRequest = 1
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()

/** Asks the editor window (tools/prompts) and waits for its answer. */
function askEditor(kind: 'list' | 'call' | 'prompts' | 'prompt', payload: unknown, timeoutMs: number): Promise<unknown> {
  const win = mainWindow()
  if (!win || win.isDestroyed()) return Promise.reject(new Error('The Boar window is not open'))
  const id = nextRequest++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('The editor did not answer in time'))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    win.webContents.send('agent:request', { id, kind, payload, client: lastClient })
  })
}

// JSON-RPC

type RpcId = string | number | null
interface RpcMessage {
  jsonrpc?: string
  id?: RpcId
  method?: string
  params?: Record<string, unknown>
}

const result = (id: RpcId, value: unknown): object => ({ jsonrpc: '2.0', id, result: value })
const failure = (id: RpcId, code: number, message: string): object => ({ jsonrpc: '2.0', id, error: { code, message } })

async function handleRpc(message: RpcMessage): Promise<object | null> {
  const id = message.id ?? null
  const isRequest = message.id !== undefined && message.id !== null
  if (!message || typeof message.method !== 'string') return isRequest ? failure(id, -32600, 'Invalid request') : null
  const params = message.params ?? {}
  try {
    switch (message.method) {
      case 'initialize': {
        const info = params.clientInfo as { name?: string; title?: string } | undefined
        lastClient = String(info?.title ?? info?.name ?? 'AI agent').slice(0, 60)
        const requested = String(params.protocolVersion ?? '')
        return result(id, {
          protocolVersion: PROTOCOLS.includes(requested) ? requested : PROTOCOLS[1],
          capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
          serverInfo: { name: 'boar', title: 'Boar', version: app.getVersion() },
          instructions: INSTRUCTIONS
        })
      }
      case 'ping':
        return result(id, {})
      case 'tools/list':
        return result(id, { tools: await askEditor('list', null, 15_000) })
      case 'tools/call': {
        // Files an agent imports by path (import_media, add_media) may be read by
        // the editor: the agent acts for the user, who gave it the token.
        const args = (params.arguments ?? {}) as Record<string, unknown>
        if (params.name === 'import_media' || params.name === 'add_media') {
          const paths = [...(Array.isArray(args.paths) ? args.paths : []), args.path]
          allowMediaPaths(paths.filter((p): p is string => typeof p === 'string' && isAbsolute(p) && isMediaFile(p) && existsSync(p)))
        }
        // Long tools (transcription, analysis) may take minutes.
        return result(id, await askEditor('call', { name: params.name, arguments: args }, 20 * 60_000))
      }
      case 'prompts/list':
        return result(id, { prompts: await askEditor('prompts', null, 15_000) })
      case 'prompts/get':
        return result(id, await askEditor('prompt', { name: params.name, arguments: params.arguments ?? {} }, 15_000))
      default:
        // Notifications (initialized, cancelled, ...) need no answer.
        return isRequest ? failure(id, -32601, `Method not found: ${message.method}`) : null
    }
  } catch (err) {
    return isRequest ? failure(id, -32603, err instanceof Error ? err.message : String(err)) : null
  }
}

// HTTP

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end()
    return
  }
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('Request too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const LOCAL = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/

async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Only local MCP clients: a local Host (no DNS rebinding), no web page origin, the token.
  if (!LOCAL.test(req.headers.host ?? '')) return send(res, 403, { error: 'forbidden host' })
  const origin = req.headers.origin
  if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) return send(res, 403, { error: 'forbidden origin' })
  if (req.headers.authorization !== `Bearer ${config.token}`) return send(res, 401, { error: 'missing or wrong token (see Options › AI Agents in Boar)' })
  const path = new URL(req.url ?? '/', 'http://localhost').pathname
  if (path !== '/mcp') return send(res, 404, { error: 'not found' })
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' }).end()
    return
  }
  let message: unknown
  try {
    message = JSON.parse(await readBody(req))
  } catch {
    return send(res, 400, failure(null, -32700, 'Parse error'))
  }
  if (Array.isArray(message)) {
    const answers = (await Promise.all(message.map((m) => handleRpc(m as RpcMessage)))).filter((a) => a !== null)
    return answers.length ? send(res, 200, answers) : send(res, 202)
  }
  const answer = await handleRpc(message as RpcMessage)
  return answer ? send(res, 200, answer) : send(res, 202)
}

function stop(): Promise<void> {
  const current = server
  server = null
  listening = false
  return new Promise((resolve) => (current ? current.close(() => resolve()) : resolve()))
}

async function start(): Promise<void> {
  await stop()
  lastError = ''
  const created = createServer((req, res) => {
    onRequest(req, res).catch((err: unknown) => {
      if (!res.headersSent) send(res, 500, { error: err instanceof Error ? err.message : String(err) })
    })
  })
  server = created
  await new Promise<void>((resolve) => {
    created.once('error', (err: NodeJS.ErrnoException) => {
      lastError = err.code === 'EADDRINUSE' ? `Port ${config.port} is already in use` : err.message
      listening = false
      resolve()
    })
    created.listen(config.port, '127.0.0.1', () => {
      listening = true
      resolve()
    })
  })
}

let bridgeFile = ''

/** The stdio bridge script. An AppImage is mounted in a new temporary folder at each start, so it uses a copy. */
async function prepareBridge(): Promise<void> {
  if (!app.isPackaged) {
    bridgeFile = join(app.getAppPath(), 'scripts', 'boar-mcp.mjs')
    return
  }
  const bundled = join(process.resourcesPath, 'boar-mcp.mjs')
  bridgeFile = bundled
  if (!process.env.APPIMAGE) return
  const copy = join(app.getPath('userData'), 'boar-mcp.mjs')
  try {
    await mkdir(app.getPath('userData'), { recursive: true })
    await copyFile(bundled, copy)
    bridgeFile = copy
  } catch {
    // Keep the bundled path: it works until the app restarts.
  }
}

function status(): McpStatus {
  return {
    enabled: config.enabled,
    listening,
    port: config.port,
    url: `http://127.0.0.1:${config.port}/mcp`,
    token: config.token,
    error: lastError,
    client: lastClient,
    // Installed app: the bridge sits next to app.asar and runs with this executable in Node mode,
    // so agents need no Node.js. From the sources it runs with node.
    bridgePath: bridgeFile,
    bridgeCommand: app.isPackaged ? (process.env.APPIMAGE ?? process.execPath) : 'node',
    bridgeEnv: app.isPackaged ? { ELECTRON_RUN_AS_NODE: '1' } : {},
    configPath: configPath()
  }
}

export async function registerMcp(window: () => BrowserWindow | null): Promise<void> {
  mainWindow = window
  await prepareBridge()
  ipcMain.on('agent:response', (_event, id: number, ok: boolean, value: unknown) => {
    const request = pending.get(id)
    if (!request) return
    clearTimeout(request.timer)
    pending.delete(id)
    if (ok) request.resolve(value)
    else request.reject(new Error(String(value)))
  })
  ipcMain.handle('agent:status', () => status())
  ipcMain.handle('agent:setEnabled', async (_event, enabled: boolean) => {
    config.enabled = enabled === true
    await saveConfig()
    if (config.enabled) await start()
    else await stop()
    return status()
  })
  ipcMain.handle('agent:newToken', async () => {
    config.token = newToken()
    await saveConfig()
    return status()
  })
  await loadConfig()
  // The bridge needs the token even before the first start.
  await saveConfig()
  if (config.enabled) await start()
}

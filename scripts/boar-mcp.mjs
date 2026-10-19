#!/usr/bin/env node
// stdio bridge for MCP clients that start servers as a command. Each JSON-RPC
// message is forwarded to the editor's local endpoint with the port and token
// from mcp.json in the app's user data folder.
//
//   node scripts/boar-mcp.mjs
//
// BOAR_MCP_CONFIG overrides the path of mcp.json.
//
// When the editor is closed, the bridge still answers the handshake and lists
// the tools from the copy the editor keeps next to mcp.json (mcp-tools.json),
// so clients started before Boar know its tools. The first tool call then
// opens Boar (installed copies write their executable into mcp.json) and waits
// for it.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

function configFile() {
  if (process.env.BOAR_MCP_CONFIG) return process.env.BOAR_MCP_CONFIG
  const home = homedir()
  const base =
    process.platform === 'win32'
      ? (process.env.APPDATA ?? join(home, 'AppData', 'Roaming'))
      : process.platform === 'darwin'
        ? join(home, 'Library', 'Application Support')
        : (process.env.XDG_CONFIG_HOME ?? join(home, '.config'))
  return join(base, 'Boar', 'mcp.json')
}

const NOT_RUNNING = 'Boar is not reachable. Open Boar and turn on Options › AI Agents (MCP), then try again.'
const TURNED_OFF = 'AI agents are turned off in Boar: turn on Options › AI Agents (MCP), then try again.'
/** How long a tool call waits for Boar to open. */
const START_WAIT_MS = 45_000

const failure = (id, message) => ({ jsonrpc: '2.0', id, error: { code: -32000, message } })
const toolError = (id, text) => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } })

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** Tools and prompts of the last Boar that ran, written by the editor. */
const cachedLists = () => readJson(join(dirname(configFile()), 'mcp-tools.json')) ?? {}

/** The tool list was answered from the copy: the client is told when Boar's own list arrives. */
let listedOffline = false
/** The running start of Boar, shared by tool calls that arrive meanwhile. */
let starting = null
let launched = 0

function offlineAnswer(message, config) {
  const lists = cachedLists()
  switch (message.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: { listChanged: true }, prompts: { listChanged: false } },
          serverInfo: { name: 'boar', title: 'Boar', version: lists.version ?? 'bridge' },
          instructions: lists.instructions ?? NOT_RUNNING
        }
      }
    case 'ping':
      return { jsonrpc: '2.0', id: message.id, result: {} }
    case 'tools/list':
      listedOffline = true
      return { jsonrpc: '2.0', id: message.id, result: { tools: Array.isArray(lists.tools) ? lists.tools : [] } }
    case 'prompts/list':
      return { jsonrpc: '2.0', id: message.id, result: { prompts: Array.isArray(lists.prompts) ? lists.prompts : [] } }
    case 'tools/call':
      return toolError(message.id, config && config.enabled === false ? TURNED_OFF : NOT_RUNNING)
    default:
      return failure(message.id, config && config.enabled === false ? TURNED_OFF : NOT_RUNNING)
  }
}

/** Sends one message to the editor; null when it cannot be reached. */
async function post(config, message) {
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${config.token}`
      },
      body: JSON.stringify(message)
    })
    return { status: response.status, ok: response.ok, text: await response.text() }
  } catch {
    return null
  }
}

/** Opens the installed Boar and waits until it answers (at most once per wait). */
function startBoar(config) {
  if (starting) return starting
  if (!config.app || !existsSync(config.app) || Date.now() - launched < START_WAIT_MS) return Promise.resolve(false)
  starting = launchAndWait(config).finally(() => {
    starting = null
  })
  return starting
}

async function launchAndWait(config) {
  launched = Date.now()
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    spawn(config.app, [], { detached: true, stdio: 'ignore', env }).unref()
  } catch {
    return false
  }
  while (Date.now() - launched < START_WAIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const fresh = readJson(configFile()) ?? config
    const reply = await post(fresh, { jsonrpc: '2.0', id: 0, method: 'ping' })
    if (reply?.ok) return true
  }
  return false
}

/** When Boar last could not be reached: a refused local connection can take seconds on some systems. */
let unreachableAt = 0

async function forward(message) {
  const isRequest = message && message.id !== undefined && message.id !== null
  let config = readJson(configFile())
  // The handshake and lists right after a failed try are answered at once; tool calls always try.
  const retry = message?.method === 'tools/call' || Date.now() - unreachableAt > 5000
  let reply = config && config.enabled !== false && retry ? await post(config, message) : null
  if (!reply && retry) unreachableAt = Date.now()
  if (!reply && isRequest && message.method === 'tools/call' && config && config.enabled !== false && (await startBoar(config))) {
    config = readJson(configFile()) ?? config
    reply = await post(config, message)
  }
  if (!reply) return isRequest ? offlineAnswer(message, config) : null
  unreachableAt = 0
  if (listedOffline) {
    // Boar answered: its own tool list may differ from the copy.
    listedOffline = false
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n`)
  }
  if (reply.status === 202) return null
  if (!reply.ok) return isRequest ? failure(message.id, `Boar answered ${reply.status}: ${reply.text.slice(0, 300)}`) : null
  let answer
  try {
    answer = JSON.parse(reply.text)
  } catch {
    return isRequest ? failure(message.id, 'Boar sent an answer that is not JSON') : null
  }
  // The bridge tells the client when the tool list changes (Boar opened after it).
  if (message.method === 'initialize' && answer?.result?.capabilities?.tools) answer.result.capabilities.tools.listChanged = true
  return answer
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', (line) => {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    process.stdout.write(`${JSON.stringify(failure(null, 'Parse error'))}\n`)
    return
  }
  void forward(message).then((reply) => {
    if (reply !== null) process.stdout.write(`${JSON.stringify(reply)}\n`)
  })
})

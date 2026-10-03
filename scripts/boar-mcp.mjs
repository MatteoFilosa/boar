#!/usr/bin/env node
// stdio bridge for MCP clients that start servers as a command. Each JSON-RPC
// message is forwarded to the editor's local endpoint with the port and token
// from mcp.json in the app's user data folder.
//
//   node scripts/boar-mcp.mjs
//
// BOAR_MCP_CONFIG overrides the path of mcp.json.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
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

const NOT_RUNNING =
  'Boar is not reachable. Open Boar and turn on Options › AI Agents (MCP), then try again.'

const failure = (id, message) => ({ jsonrpc: '2.0', id, error: { code: -32000, message } })

/** Answers the handshake itself when the editor is closed, so the agent still connects and shows the hint. */
function offlineAnswer(message) {
  if (message.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: { name: 'boar', title: 'Boar', version: 'bridge' },
        instructions: NOT_RUNNING
      }
    }
  }
  if (message.method === 'ping') return { jsonrpc: '2.0', id: message.id, result: {} }
  return failure(message.id, NOT_RUNNING)
}

async function forward(message) {
  const isRequest = message && message.id !== undefined && message.id !== null
  let config
  try {
    config = JSON.parse(readFileSync(configFile(), 'utf8'))
  } catch {
    return isRequest ? offlineAnswer(message) : null
  }
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
    if (response.status === 202) return null
    const text = await response.text()
    if (!response.ok) return isRequest ? failure(message.id, `Boar answered ${response.status}: ${text.slice(0, 300)}`) : null
    return JSON.parse(text)
  } catch {
    return isRequest ? offlineAnswer(message) : null
  }
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

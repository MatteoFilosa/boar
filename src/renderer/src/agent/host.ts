import { create } from 'zustand'
import * as A from '../core/actions'
import { type AgentRequest, bridge } from '../platform'
import { callTool, isReadOnly, listTools } from './tools'
import { getPrompt, listPrompts } from './prompts'

// Answers the MCP server's requests (src/main/mcp.ts) and keeps a log of what
// agents did, shown in Options › AI Agents.

export interface AgentActivity {
  id: number
  time: number
  client: string
  tool: string
  args: string
  ok: boolean
  result: string
}

export const useAgentActivity = create<{ log: AgentActivity[] }>()(() => ({ log: [] }))

const short = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

async function answer(request: AgentRequest): Promise<unknown> {
  const payload = (request.payload ?? {}) as { name?: string; arguments?: Record<string, unknown> }
  switch (request.kind) {
    case 'list':
      return listTools()
    case 'prompts':
      return listPrompts()
    case 'prompt':
      return getPrompt(String(payload.name ?? ''), payload.arguments ?? {})
    case 'call': {
      const name = String(payload.name ?? '')
      const result = await callTool(name, payload.arguments ?? {})
      const text = result.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join(' ')
      useAgentActivity.setState((s) => ({
        log: [
          {
            id: request.id,
            time: Date.now(),
            client: request.client || 'AI agent',
            tool: name,
            args: short(JSON.stringify(payload.arguments ?? {}), 140),
            ok: !result.isError,
            result: short(text, 200)
          },
          ...s.log
        ].slice(0, 100)
      }))
      if (!isReadOnly(name)) A.setStatus(`${request.client || 'AI agent'}: ${result.isError ? `${name} failed` : short(text, 90)}`)
      return result
    }
  }
}

let started = false

/** Starts answering agents (desktop app only). */
export function startAgentHost(): void {
  if (!bridge || started) return
  started = true
  const link = bridge
  link.onAgentRequest((request) => {
    answer(request).then(
      (value) => link.agentRespond(request.id, true, value),
      (err: unknown) => link.agentRespond(request.id, false, err instanceof Error ? err.message : String(err))
    )
  })
}

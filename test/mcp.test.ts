import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { crc32, inflateRawSync } from 'node:zlib'
import { bundleManifest, mcpBundle } from '../src/main/mcpBundle'

/** Entries of a zip file, read through its central directory. */
function unzip(file: Buffer): Map<string, Buffer> {
  const end = file.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  const count = file.readUInt16LE(end + 10)
  let at = file.readUInt32LE(end + 16)
  const out = new Map<string, Buffer>()
  for (let i = 0; i < count; i++) {
    expect(file.readUInt32LE(at)).toBe(0x02014b50)
    const crc = file.readUInt32LE(at + 16)
    const packed = file.readUInt32LE(at + 20)
    const nameLength = file.readUInt16LE(at + 28)
    const extra = file.readUInt16LE(at + 30) + file.readUInt16LE(at + 32)
    const local = file.readUInt32LE(at + 42)
    const name = file.subarray(at + 46, at + 46 + nameLength).toString('utf8')
    const dataAt = local + 30 + file.readUInt16LE(local + 26) + file.readUInt16LE(local + 28)
    const data = inflateRawSync(file.subarray(dataAt, dataAt + packed))
    expect(crc32(data)).toBe(crc)
    out.set(name, data)
    at += 46 + nameLength + extra
  }
  return out
}

const TOOLS = [{ name: 'get_project', description: 'What is on the timeline. Tracks, events and markers.' }]

describe('MCP bundle', () => {
  test('a zip with the manifest, the bridge and the icon', () => {
    const file = mcpBundle({ version: '1.2.3', bridge: 'console.log(1)\n', configPath: '', tools: TOOLS, icon: new Uint8Array([1, 2, 3]) })
    const entries = unzip(file)
    expect([...entries.keys()]).toEqual(['manifest.json', 'server/boar-mcp.mjs', 'icon.png'])
    expect(entries.get('server/boar-mcp.mjs')?.toString()).toBe('console.log(1)\n')
    const manifest = JSON.parse(entries.get('manifest.json')!.toString()) as Record<string, any>
    expect(manifest).toMatchObject({ manifest_version: '0.3', name: 'boar', version: '1.2.3', icon: 'icon.png' })
    expect(manifest.server).toEqual({
      type: 'node',
      entry_point: 'server/boar-mcp.mjs',
      mcp_config: { command: 'node', args: ['${__dirname}/server/boar-mcp.mjs'] }
    })
    expect(manifest.tools).toEqual([{ name: 'get_project', description: 'What is on the timeline.' }])
  })

  test('mcp.json outside the usual place is passed to the bridge', () => {
    const manifest = bundleManifest({ version: '1.0.0', configPath: 'D:\\Boar\\mcp.json', tools: [], icon: false }) as Record<string, any>
    expect(manifest.server.mcp_config.env).toEqual({ BOAR_MCP_CONFIG: 'D:\\Boar\\mcp.json' })
    expect(manifest.icon).toBeUndefined()
  })
})

/** The stdio bridge with its own mcp.json: send lines, read the answers. */
class Bridge {
  readonly child: ChildProcessWithoutNullStreams
  private buffer = ''
  private readonly waiting: ((line: unknown) => void)[] = []
  private readonly lines: unknown[] = []

  constructor(config: string) {
    this.child = spawn(process.execPath, [resolve(__dirname, '../scripts/boar-mcp.mjs')], { env: { ...process.env, BOAR_MCP_CONFIG: config } })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk
      let end
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(this.buffer.slice(0, end)) as unknown
        this.buffer = this.buffer.slice(end + 1)
        const next = this.waiting.shift()
        if (next) next(message)
        else this.lines.push(message)
      }
    })
  }

  send(message: object): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  next(): Promise<any> {
    const ready = this.lines.shift()
    return ready ? Promise.resolve(ready) : new Promise((resolve) => this.waiting.push(resolve))
  }

  async ask(id: number, method: string, params: object = {}): Promise<any> {
    this.send({ jsonrpc: '2.0', id, method, params })
    return this.next()
  }
}

// A refused local connection takes about two seconds on some systems.
describe('stdio bridge', { timeout: 30_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'boar-bridge-'))
  const config = join(dir, 'mcp.json')
  let server: Server
  let calls: string[] = []
  const bridges: Bridge[] = []

  beforeAll(async () => {
    // A stand-in for the editor's endpoint, closed until a test opens it.
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => (body += c))
      req.on('end', () => {
        if (req.headers.authorization !== 'Bearer t0ken') return res.writeHead(401).end()
        const message = JSON.parse(body) as { id: number; method: string }
        calls.push(message.method)
        const result =
          message.method === 'initialize'
            ? { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'boar' } }
            : message.method === 'tools/list'
              ? { tools: [{ name: 'get_project' }, { name: 'render' }] }
              : { content: [{ type: 'text', text: 'done' }] }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
      })
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    writeFileSync(
      join(dir, 'mcp-tools.json'),
      JSON.stringify({ version: '0.9.0', instructions: 'Boar is a video editor.', tools: [{ name: 'get_project' }], prompts: [{ name: 'edit_in_boar' }] })
    )
  })

  afterAll(() => {
    for (const b of bridges) b.child.kill()
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const port = (): number => (server.address() as AddressInfo).port

  test('with Boar closed it lists the kept tools and explains tool calls', async () => {
    writeFileSync(config, JSON.stringify({ enabled: true, port: 1, token: 't0ken' }))
    const bridge = new Bridge(config)
    bridges.push(bridge)
    const hello = await bridge.ask(1, 'initialize', { protocolVersion: '2025-06-18' })
    expect(hello.result.serverInfo).toMatchObject({ name: 'boar', version: '0.9.0' })
    expect(hello.result.capabilities.tools.listChanged).toBe(true)
    expect(hello.result.instructions).toBe('Boar is a video editor.')
    expect((await bridge.ask(2, 'tools/list')).result.tools).toEqual([{ name: 'get_project' }])
    expect((await bridge.ask(3, 'prompts/list')).result.prompts).toEqual([{ name: 'edit_in_boar' }])
    const call = await bridge.ask(4, 'tools/call', { name: 'get_project', arguments: {} })
    expect(call.result.isError).toBe(true)
    expect(call.result.content[0].text).toMatch(/not reachable/)
  })

  test('turned off in Boar: tool calls say so', async () => {
    writeFileSync(config, JSON.stringify({ enabled: false, port: port(), token: 't0ken' }))
    const bridge = new Bridge(config)
    bridges.push(bridge)
    const call = await bridge.ask(1, 'tools/call', { name: 'get_project', arguments: {} })
    expect(call.result.content[0].text).toMatch(/turned off/)
    expect(calls).toEqual([])
  })

  test('once Boar answers, the client hears that the tool list changed', async () => {
    writeFileSync(config, JSON.stringify({ enabled: true, port: 1, token: 't0ken' }))
    const bridge = new Bridge(config)
    bridges.push(bridge)
    expect((await bridge.ask(1, 'tools/list')).result.tools).toHaveLength(1)
    writeFileSync(config, JSON.stringify({ enabled: true, port: port(), token: 't0ken' }))
    calls = []
    bridge.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_project', arguments: {} } })
    expect(await bridge.next()).toEqual({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    expect((await bridge.next()).result.content[0].text).toBe('done')
    expect((await bridge.ask(3, 'tools/list')).result.tools).toHaveLength(2)
    expect((await bridge.ask(4, 'initialize')).result.capabilities.tools.listChanged).toBe(true)
    expect(calls).toEqual(['tools/call', 'tools/list', 'initialize'])
  })
})

import { app, ipcMain } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, open, readdir, rename, stat, unlink, utimes, type FileHandle } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { allowMediaDir } from './media-protocol'

// Proxies: light copies of videos that are slow to seek, made by the renderer
// (WebCodecs) and stored in the app's own folder. A proxy is named after the
// source's path, size and modification time, so an edited file gets a new one.

const proxyDir = (): string => join(app.getPath('userData'), 'Proxies')

/** Proxies not used for this long are deleted at startup. */
const KEEP_DAYS = 30

async function proxyPath(source: string): Promise<string> {
  if (!isAbsolute(source)) throw new Error('Not a file path')
  const s = await stat(source)
  const key = createHash('sha1').update(`${source}|${s.size}|${s.mtimeMs}`).digest('hex').slice(0, 24)
  return join(proxyDir(), `${key}.mp4`)
}

// Reversed copies (Reverse): a range of a media file played backwards, made by
// the renderer like proxies. Projects use them as media, so they are never
// pruned. Each one sits in a folder named after the source's path, size,
// modification time and range, so asking again finds the same file.

const reversedDir = (): string => join(app.getPath('userData'), 'Reversed Media')

async function reversedPath(source: string, range: string, name: string): Promise<string> {
  if (!isAbsolute(source)) throw new Error('Not a file path')
  const s = await stat(source)
  const key = createHash('sha1').update(`${source}|${s.size}|${s.mtimeMs}|${range}`).digest('hex').slice(0, 16)
  const ext = extname(name).toLowerCase() === '.m4a' ? '.m4a' : '.mp4'
  const stem = basename(name, extname(name)).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 120) || 'Reversed'
  return join(reversedDir(), key, `${stem}${ext}`)
}

const writing = new Map<number, { handle: FileHandle; part: string; path: string }>()
let nextId = 1

async function prune(): Promise<void> {
  const dir = proxyDir()
  const names = await readdir(dir).catch(() => [] as string[])
  const limit = Date.now() - KEEP_DAYS * 86_400_000
  for (const name of names) {
    const path = join(dir, name)
    const s = await stat(path).catch(() => null)
    if (s && (name.endsWith('.part') || s.mtimeMs < limit)) await unlink(path).catch(() => undefined)
  }
}

export function registerProxyIpc(): void {
  allowMediaDir(proxyDir())
  allowMediaDir(reversedDir())
  void prune()

  /** The proxy of a source file, if it exists (and marks it as used). */
  ipcMain.handle('proxy:find', async (_event, source: string) => {
    const path = await proxyPath(source).catch(() => null)
    if (!path || !existsSync(path)) return null
    const now = new Date()
    await utimes(path, now, now).catch(() => undefined)
    return path
  })
  ipcMain.handle('proxy:create', async (_event, source: string) => {
    const path = await proxyPath(source)
    await mkdir(proxyDir(), { recursive: true })
    const part = `${path}.part`
    const handle = await open(part, 'w')
    const id = nextId++
    writing.set(id, { handle, part, path })
    return id
  })
  /** A reversed copy made earlier for this source and range, if it exists. */
  ipcMain.handle('reverse:find', async (_event, source: string, range: string, name: string) => {
    const path = await reversedPath(source, range, name).catch(() => null)
    return path && existsSync(path) ? path : null
  })
  /** Starts writing a reversed copy; written and finished like a proxy. */
  ipcMain.handle('reverse:create', async (_event, source: string, range: string, name: string) => {
    const path = await reversedPath(source, range, name)
    await mkdir(dirname(path), { recursive: true })
    const part = `${path}.part`
    const handle = await open(part, 'w')
    const id = nextId++
    writing.set(id, { handle, part, path })
    return id
  })
  ipcMain.handle('proxy:write', async (_event, id: number, position: number, data: Uint8Array) => {
    const file = writing.get(id)
    if (!file) throw new Error('Proxy is not open')
    await file.handle.write(data, 0, data.byteLength, position)
  })
  ipcMain.handle('proxy:finish', async (_event, id: number) => {
    const file = writing.get(id)
    if (!file) throw new Error('Proxy is not open')
    writing.delete(id)
    await file.handle.close()
    await rename(file.part, file.path)
    return file.path
  })
  ipcMain.handle('proxy:abort', async (_event, id: number) => {
    const file = writing.get(id)
    if (!file) return
    writing.delete(id)
    await file.handle.close().catch(() => undefined)
    await unlink(file.part).catch(() => undefined)
  })
  ipcMain.handle('proxy:delete', async (_event, source: string) => {
    const path = await proxyPath(source).catch(() => null)
    if (path) await unlink(path).catch(() => undefined)
  })
}

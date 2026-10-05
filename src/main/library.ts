import { app, BrowserWindow, clipboard, dialog, ipcMain, net, shell, type WebContents } from 'electron'
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { allowMediaDir, allowMediaPaths } from './media-protocol'
import { mergeVideoAudio } from './remux'

// Media library: folders the user picked (Explorer tab) and the app's own
// folders (pasted images, downloads, saved sound effects). The renderer can only
// list, read and write inside them.

const MEDIA_EXT = new Set([
  'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'mts', 'm2ts', 'ts', 'wmv', 'mpg', 'mpeg', '3gp',
  'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'wma', 'aif', 'aiff',
  'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'avif'
])

/** A media file Boar can import (by its extension). */
export const isMediaFile = (path: string): boolean => MEDIA_EXT.has(extname(path).slice(1).toLowerCase())

const settingsFile = (): string => join(app.getPath('userData'), 'library.json')
const pastedDir = (): string => join(app.getPath('userData'), 'Pasted Media')
const binDir = (): string => join(app.getPath('userData'), 'bin')

let folders: string[] = []

async function loadFolders(): Promise<void> {
  try {
    const data = JSON.parse(await readFile(settingsFile(), 'utf8')) as { folders?: unknown }
    folders = Array.isArray(data.folders) ? data.folders.filter((f): f is string => typeof f === 'string' && isAbsolute(f)) : []
  } catch {
    folders = []
  }
  for (const f of folders) allowMediaDir(f)
}

async function saveFolders(): Promise<void> {
  await mkdir(dirname(settingsFile()), { recursive: true })
  await writeFile(settingsFile(), JSON.stringify({ folders }, null, 1), 'utf8')
}

/** True when `path` is one of the library folders or inside one. */
function inLibrary(path: string): boolean {
  if (!isAbsolute(path)) return false
  const full = resolve(path)
  return folders.some((f) => {
    const rel = relative(resolve(f), full)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  })
}

async function folderList(): Promise<{ path: string; name: string; exists: boolean }[]> {
  return Promise.all(folders.map(async (path) => ({ path, name: basename(path) || path, exists: !!(await stat(path).catch(() => null)) })))
}

export interface LibraryEntry {
  name: string
  path: string
  dir: boolean
  size: number
  modified: number
}

async function listDir(dir: string): Promise<LibraryEntry[]> {
  if (!inLibrary(dir)) throw new Error('Folder is not in the library')
  const entries = await readdir(dir, { withFileTypes: true })
  const out: LibraryEntry[] = []
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const path = join(dir, e.name)
    if (e.isDirectory()) {
      out.push({ name: e.name, path, dir: true, size: 0, modified: 0 })
    } else if (e.isFile() && MEDIA_EXT.has(extname(e.name).slice(1).toLowerCase())) {
      const st = await stat(path).catch(() => null)
      out.push({ name: e.name, path, dir: false, size: st?.size ?? 0, modified: st?.mtimeMs ?? 0 })
    }
  }
  out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.dir ? -1 : 1))
  return out
}

/** File name without characters Windows rejects. */
const safeName = (name: string): string =>
  name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 120) || 'untitled'

async function uniquePath(dir: string, name: string, ext: string): Promise<string> {
  let path = join(dir, `${name}.${ext}`)
  for (let i = 2; existsSync(path); i++) path = join(dir, `${name} (${i}).${ext}`)
  return path
}

// Download from Link (yt-dlp, optional)

const YTDLP_RELEASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/'

function ytDlpAsset(): string | null {
  if (process.platform === 'win32') return 'yt-dlp.exe'
  if (process.platform === 'darwin') return 'yt-dlp_macos'
  if (process.platform === 'linux' && process.arch === 'x64') return 'yt-dlp_linux'
  if (process.platform === 'linux' && process.arch === 'arm64') return 'yt-dlp_linux_aarch64'
  return null
}

function run(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolvePromise) => {
    let out = ''
    const child = spawn(cmd, args, { windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' } })
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (out += d.toString('utf8')))
    child.on('error', () => resolvePromise({ code: -1, out }))
    child.on('close', (code) => resolvePromise({ code: code ?? -1, out }))
  })
}

/** yt-dlp from PATH, else the copy downloaded into the app's bin folder. */
async function findYtDlp(): Promise<{ path: string; version: string } | null> {
  const local = join(binDir(), process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
  for (const candidate of [local, 'yt-dlp']) {
    if (candidate === local && !existsSync(local)) continue
    const r = await run(candidate, ['--version'])
    if (r.code === 0) return { path: candidate, version: r.out.trim().split(/\r?\n/)[0] }
  }
  return null
}

async function installYtDlp(sender: WebContents): Promise<void> {
  const asset = ytDlpAsset()
  if (!asset) throw new Error('Install yt-dlp with your package manager')
  await mkdir(binDir(), { recursive: true })
  const target = join(binDir(), process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
  const partial = `${target}.part`
  const response = await net.fetch(YTDLP_RELEASE + asset)
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status})`)
  const total = Number(response.headers.get('content-length')) || 18 * 1024 * 1024
  const file = createWriteStream(partial)
  const reader = response.body.getReader()
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (!file.write(value)) await new Promise<void>((r) => file.once('drain', () => r()))
      sender.send('youtube:progress', { phase: 'install', progress: received / total, text: 'Downloading yt-dlp' })
    }
    await new Promise<void>((r, reject) => file.end((err?: Error | null) => (err ? reject(err) : r())))
    if (process.platform !== 'win32') await chmod(partial, 0o755)
    await rename(partial, target)
  } catch (err) {
    file.destroy()
    await rm(partial, { force: true })
    throw err
  }
}

export interface YoutubeRequest {
  url: string
  /** Video with sound (MP4), or the sound alone in its original format (usually M4A). */
  format: 'mp4' | 'audio'
  /** Max video height (mp4), 0 = best available. */
  maxHeight: number
  folder: string
}

let activeDownload: ReturnType<typeof spawn> | null = null

/** Runs yt-dlp; returns the paths of the files it wrote, or the reason it failed. */
async function runYtDlp(tool: string, args: string[], sender: WebContents): Promise<{ paths: string[]; error: string }> {
  const paths: string[] = []
  let log = ''
  const code = await new Promise<number>((resolvePromise) => {
    const child = spawn(tool, args, { windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' } })
    activeDownload = child
    let buffer = ''
    const line = (raw: string): void => {
      const text = raw.trim()
      const m = /\[download\]\s+([\d.]+)%/.exec(text)
      if (m) sender.send('youtube:progress', { phase: 'download', progress: Number(m[1]) / 100, text: text.replace('[download]', '').trim() })
      else if (isAbsolute(text) && existsSync(text) && !paths.includes(text)) paths.push(text)
    }
    child.stdout.on('data', (d: Buffer) => {
      buffer += d.toString('utf8')
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      lines.forEach(line)
    })
    child.stderr.on('data', (d: Buffer) => (log = (log + d.toString('utf8')).slice(-3000)))
    child.on('error', () => resolvePromise(-1))
    child.on('close', (exit) => {
      line(buffer)
      resolvePromise(exit ?? -1)
    })
  })
  activeDownload = null
  const reason = log.split(/\r?\n/).reverse().find((l) => /ERROR/i.test(l))
  return { paths: code === 0 ? paths : [], error: code === 0 ? '' : reason?.replace(/^ERROR:\s*/, '') || 'Download failed (try "Update yt-dlp")' }
}

/**
 * Downloads with yt-dlp into a library folder. Sites usually serve video and
 * sound as separate streams: both are downloaded and Boar joins them itself
 * (no FFmpeg needed); a site that only has single files gets the best one.
 */
async function downloadYoutube(req: YoutubeRequest, sender: WebContents): Promise<string> {
  if (!/^https?:\/\//i.test(req.url)) throw new Error('Paste a full link (https://…)')
  if (!inLibrary(req.folder)) throw new Error('Pick a library folder for the download')
  const tool = await findYtDlp()
  if (!tool) throw new Error('yt-dlp is not installed')
  const common = ['--no-playlist', '--quiet', '--progress', '--newline', '--no-mtime', '--windows-filenames', '--print', 'after_move:filepath']
  const name = '%(title).110B [%(id)s]'
  let result: { paths: string[]; error: string }
  if (req.format === 'audio') {
    // The original sound, not converted (M4A from most sites).
    result = await runYtDlp(tool.path, [...common, '-f', 'ba[ext=m4a]/ba/b', '-o', join(req.folder, `${name}.%(ext)s`), req.url], sender)
  } else {
    const h = req.maxHeight > 0 ? `[height<=${req.maxHeight}]` : ''
    // H.264 + AAC first: decoded in hardware everywhere and fine for WebCodecs.
    result = await runYtDlp(
      tool.path,
      [...common, '-f', `(bv*${h}[vcodec^=avc1]/bv*${h}),(ba[ext=m4a]/ba)`, '-o', join(req.folder, `${name}.f%(format_id)s.%(ext)s`), req.url],
      sender
    )
    if (result.paths.length === 2) {
      sender.send('youtube:progress', { phase: 'convert', progress: 1, text: 'Joining video and sound…' })
      const [videoPath, audioPath] = result.paths
      const finalPath = await uniquePath(dirname(videoPath), basename(videoPath).replace(/\.f[^.]+\.[^.]+$/, ''), 'mp4')
      try {
        await mergeVideoAudio(videoPath, audioPath, finalPath)
      } catch (err) {
        await rm(finalPath, { force: true })
        throw err
      }
      await rm(videoPath, { force: true })
      await rm(audioPath, { force: true })
      result = { paths: [finalPath], error: '' }
    } else if (result.paths.length === 0) {
      // Only single files on this site (or one with sound already in it).
      result = await runYtDlp(tool.path, [...common, '-f', `b${h}[ext=mp4]/b${h}/b`, '-o', join(req.folder, `${name}.%(ext)s`), req.url], sender)
    }
  }
  const finalPath = result.paths[result.paths.length - 1]
  if (!finalPath) throw new Error(result.error || 'Download failed (try "Update yt-dlp")')
  allowMediaPaths([finalPath])
  return finalPath
}

// IPC

export function registerLibraryIpc(): void {
  void loadFolders()
  allowMediaDir(pastedDir())

  ipcMain.handle('library:folders', () => folderList())
  ipcMain.handle('library:addFolder', async (event) => {
    const options = { title: 'Add a media folder to the library', properties: ['openDirectory' as const, 'createDirectory' as const] }
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    const path = result.filePaths[0]
    if (result.canceled || !path) return null
    if (!folders.includes(path)) {
      folders.push(path)
      allowMediaDir(path)
      await saveFolders()
    }
    return path
  })
  ipcMain.handle('library:removeFolder', async (_event, path: string) => {
    folders = folders.filter((f) => f !== path)
    await saveFolders()
  })
  ipcMain.handle('library:list', (_event, dir: string) => listDir(dir))
  ipcMain.handle('library:reveal', (_event, path: string) => {
    if (inLibrary(path) || path.startsWith(pastedDir())) shell.showItemInFolder(path)
  })
  /** Writes a new file (e.g. a sound effect) into a library folder; never overwrites. */
  ipcMain.handle('library:save', async (_event, dir: string, name: string, ext: string, data: Uint8Array) => {
    if (!inLibrary(dir)) throw new Error('Pick a library folder')
    if (!/^[a-z0-9]{1,5}$/i.test(ext)) throw new Error('Invalid extension')
    const path = await uniquePath(dir, safeName(name), ext)
    await writeFile(path, data)
    allowMediaPaths([path])
    return path
  })

  // Clipboard: images (screenshots, "Copy image" in the browser) become files.
  ipcMain.handle('clipboard:image', async () => {
    const items = await clipboard.read().catch(() => [])
    for (const item of items) {
      const type = item.types.find((t) => t === 'image/png' || t === 'image/jpeg' || t === 'image/webp')
      if (!type) continue
      const blob = (await item.getType(type)) as Blob
      await mkdir(pastedDir(), { recursive: true })
      const now = new Date()
      const two = (n: number): string => String(n).padStart(2, '0')
      const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`
      const path = await uniquePath(pastedDir(), `Pasted ${stamp}`, type === 'image/jpeg' ? 'jpg' : type.slice(6))
      await writeFile(path, Buffer.from(await blob.arrayBuffer()))
      allowMediaPaths([path])
      return path
    }
    return null
  })
  /**
   * A file dropped without a path on disk (an image dragged out of a web page)
   * is kept in the pasted media folder, so the project can open it again.
   */
  ipcMain.handle('media:keep', async (_event, name: string, data: Uint8Array) => {
    const ext = extname(String(name)).slice(1).toLowerCase()
    if (!MEDIA_EXT.has(ext)) throw new Error('Unsupported file type')
    if (!(data instanceof Uint8Array) || data.byteLength === 0) throw new Error('Empty file')
    await mkdir(pastedDir(), { recursive: true })
    const path = await uniquePath(pastedDir(), safeName(basename(String(name), extname(String(name)))), ext)
    await writeFile(path, data)
    allowMediaPaths([path])
    return path
  })
  /** Copying events replaces an older image on the system clipboard, so Ctrl+V pastes the events. */
  ipcMain.handle('clipboard:claim', () => clipboard.writeText('Boar events'))

  ipcMain.handle('youtube:status', async () => ({ ytdlp: await findYtDlp() }))
  ipcMain.handle('youtube:install', (event) => installYtDlp(event.sender))
  ipcMain.handle('youtube:update', async () => {
    const tool = await findYtDlp()
    if (!tool) throw new Error('yt-dlp is not installed')
    const r = await run(tool.path, ['-U'])
    return r.out.trim().split(/\r?\n/).pop() ?? ''
  })
  ipcMain.handle('youtube:download', (event, req: YoutubeRequest) => downloadYoutube(req, event.sender))
  ipcMain.handle('youtube:cancel', () => {
    activeDownload?.kill()
    activeDownload = null
  })
}

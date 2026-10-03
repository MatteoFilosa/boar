import { app, BrowserWindow, clipboard, dialog, ipcMain, net, shell, type WebContents } from 'electron'
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { allowMediaDir, allowMediaPaths } from './media-protocol'

// Media library: folders the user picked (Explorer tab) and the app's own
// folders (pasted images, downloads, saved sound effects). The renderer can only
// list, read and write inside them.

const MEDIA_EXT = new Set([
  'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'mts', 'm2ts', 'ts', 'wmv', 'mpg', 'mpeg', '3gp',
  'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'wma', 'aif', 'aiff',
  'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'avif'
])

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
  format: 'mp4' | 'mp3'
  /** Max video height (mp4), 0 = best available. */
  maxHeight: number
  folder: string
}

let activeDownload: ReturnType<typeof spawn> | null = null

async function downloadYoutube(req: YoutubeRequest, sender: WebContents): Promise<string> {
  if (!/^https?:\/\//i.test(req.url)) throw new Error('Paste a full link (https://…)')
  if (!inLibrary(req.folder)) throw new Error('Pick a library folder for the download')
  const tool = await findYtDlp()
  if (!tool) throw new Error('yt-dlp is not installed')
  const h = req.maxHeight > 0 ? `[height<=${req.maxHeight}]` : ''
  const args = [
    '--no-playlist',
    '--quiet',
    '--progress',
    '--newline',
    '--no-mtime',
    '--windows-filenames',
    '-o',
    join(req.folder, '%(title).110B [%(id)s].%(ext)s'),
    '--print',
    'after_move:filepath',
    ...(req.format === 'mp3'
      ? ['-x', '--audio-format', 'mp3', '--audio-quality', '0']
      : [
          // H.264 + AAC first: decoded in hardware everywhere and fine for WebCodecs.
          '-f',
          `bv*${h}[vcodec^=avc1]+ba[ext=m4a]/bv*${h}+ba/b${h}/b`,
          '--merge-output-format',
          'mp4'
        ]),
    req.url
  ]
  let finalPath = ''
  let log = ''
  const code = await new Promise<number>((resolvePromise) => {
    const child = spawn(tool.path, args, { windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' } })
    activeDownload = child
    let buffer = ''
    child.stdout.on('data', (d: Buffer) => {
      buffer += d.toString('utf8')
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const raw of lines) {
        const line = raw.trim()
        const m = /\[download\]\s+([\d.]+)%/.exec(line)
        if (m) sender.send('youtube:progress', { phase: 'download', progress: Number(m[1]) / 100, text: line.replace('[download]', '').trim() })
        else if (/^\[(ExtractAudio|Merger|VideoConvertor|FixupM3u8)\]/.test(line)) sender.send('youtube:progress', { phase: 'convert', progress: 1, text: 'Converting…' })
        else if (isAbsolute(line) && existsSync(line)) finalPath = line
      }
    })
    child.stderr.on('data', (d: Buffer) => (log = (log + d.toString('utf8')).slice(-3000)))
    child.on('error', () => resolvePromise(-1))
    child.on('close', (exit) => {
      const rest = buffer.trim()
      if (rest && isAbsolute(rest) && existsSync(rest)) finalPath = rest
      resolvePromise(exit ?? -1)
    })
  })
  activeDownload = null
  if (code !== 0 || !finalPath) {
    const reason = log.split(/\r?\n/).reverse().find((l) => /ERROR/i.test(l))
    throw new Error(reason?.replace(/^ERROR:\s*/, '') || 'Download failed (try "Update yt-dlp")')
  }
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
  /** Copying events replaces an older image on the system clipboard, so Ctrl+V pastes the events. */
  ipcMain.handle('clipboard:claim', () => clipboard.writeText('Boar events'))

  ipcMain.handle('youtube:status', async () => ({ ytdlp: await findYtDlp(), ffmpeg: (await run('ffmpeg', ['-version'])).code === 0 }))
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

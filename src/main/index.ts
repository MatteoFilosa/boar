import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync } from 'node:fs'
import { open, readFile, unlink, writeFile, type FileHandle } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { allowMediaPaths, handleMediaProtocol, registerMediaScheme } from './media-protocol'
import { registerCaptionIpc } from './captions'
import { registerLibraryIpc } from './library'
import { registerMcp } from './mcp'

// `--smoke`: load the UI hidden, report renderer errors, exit. Used to verify builds.
const smoke = process.argv.includes('--smoke')

registerMediaScheme()
// Own taskbar identity on Windows (icon and grouping), instead of Electron's.
if (process.platform === 'win32') app.setAppUserModelId('io.github.matteofilosa.boar')

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1600,
    height: 940,
    minWidth: 1100,
    minHeight: 680,
    show: false,
    backgroundColor: '#1c1c1f',
    title: 'Boar',
    icon: join(app.getAppPath(), 'resources', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  })
  win.setMenu(null)
  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // A file dropped outside a drop zone must not navigate away from the editor.
  win.webContents.on('will-navigate', (event) => event.preventDefault())

  if (smoke) runSmokeTest(win)
  else win.once('ready-to-show', () => win.show())

  // Ask before closing with unsaved changes.
  let closing = false
  win.on('close', (event) => {
    if (closing || smoke) return
    event.preventDefault()
    void win.webContents
      .executeJavaScript('Boolean(window.__boarDirty)')
      .catch(() => false)
      .then(async (dirty: boolean) => {
        if (dirty) {
          const { response } = await dialog.showMessageBox(win, {
            type: 'warning',
            buttons: ['Close without saving', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
            message: 'The project has unsaved changes.',
            detail: 'Close Boar anyway?'
          })
          if (response !== 0) return
        }
        closing = true
        win.close()
      })
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

// Render output files
// The renderer may only write to files the user picked in a save dialog.

const userChosenPaths = new Set<string>()
const openFiles = new Map<number, FileHandle>()
let nextFileId = 1

function registerIpc(): void {
  ipcMain.handle('export:pick', async (event, suggestedName: string) => {
    const options = {
      title: 'Render As',
      defaultPath: join(app.getPath('videos'), suggestedName),
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }]
    }
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    userChosenPaths.add(result.filePath)
    return result.filePath
  })
  ipcMain.handle('export:open', async (_event, path: string) => {
    if (!userChosenPaths.has(path)) throw new Error('Path was not chosen by the user')
    const handle = await open(path, 'w')
    const id = nextFileId++
    openFiles.set(id, handle)
    return id
  })
  ipcMain.handle('export:write', async (_event, id: number, position: number, data: Uint8Array) => {
    const handle = openFiles.get(id)
    if (!handle) throw new Error('File is not open')
    await handle.write(data, 0, data.byteLength, position)
  })
  ipcMain.handle('export:close', async (_event, id: number) => {
    await openFiles.get(id)?.close()
    openFiles.delete(id)
  })
  ipcMain.handle('export:discard', async (_event, path: string) => {
    if (userChosenPaths.has(path)) await unlink(path).catch(() => undefined)
  })
  ipcMain.handle('shell:reveal', (_event, path: string) => {
    if (userChosenPaths.has(path)) shell.showItemInFolder(path)
  })

  // Bundled assets (AI models, wasm) for the packaged app, whose pages are
  // file:// and cannot fetch() them. Only files inside the app are readable.
  ipcMain.handle('app:readAsset', async (_event, url: string) => {
    if (!url.startsWith('file:')) throw new Error('Not a file URL')
    const path = fileURLToPath(url)
    const rel = relative(app.getAppPath(), path)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Asset outside the app')
    return new Uint8Array(await readFile(path))
  })

  // Projects (.boar JSON). Saving without a dialog is only allowed to a
  // project path the user already picked or opened.
  const projectPaths = new Set<string>()
  const filters = [{ name: 'Boar project', extensions: ['boar'] }]
  ipcMain.handle('project:save', async (event, json: string, currentPath: string | null, saveAs: boolean) => {
    let path = currentPath && projectPaths.has(currentPath) && !saveAs ? currentPath : null
    if (!path) {
      const options = {
        title: 'Save Project',
        defaultPath: currentPath ?? join(app.getPath('documents'), 'Untitled.boar'),
        filters
      }
      const win = BrowserWindow.fromWebContents(event.sender)
      const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return null
      path = result.filePath
    }
    await writeFile(path, json, 'utf8')
    projectPaths.add(path)
    return path
  })
  ipcMain.handle('project:open', async (event) => {
    const options = { title: 'Open Project', properties: ['openFile' as const], filters: [...filters, { name: 'All files', extensions: ['*'] }] }
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    const path = result.filePaths[0]
    if (result.canceled || !path) return null
    const json = await readFile(path, 'utf8')
    try {
      const data = JSON.parse(json) as { media?: { path?: string }[] }
      allowMediaPaths((data.media ?? []).map((m) => m.path ?? ''))
    } catch {
      // Invalid file: the renderer reports it.
    }
    projectPaths.add(path)
    return { path, json }
  })
}

function runSmokeTest(win: BrowserWindow): void {
  const errors: string[] = []
  win.webContents.on('console-message', (event) => {
    const { level, message } = event as unknown as { level: string | number; message: string }
    if (level === 'error' || level === 3) errors.push(message)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    console.log(`[smoke] renderer gone: ${details.reason}`)
    app.exit(1)
  })
  win.webContents.once('did-fail-load', (_event, code, description) => {
    console.log(`[smoke] load failed: ${code} ${description}`)
    app.exit(1)
  })
  win.webContents.once('did-finish-load', async () => {
    await new Promise((resolve) => setTimeout(resolve, 2500))
    const ready = await win.webContents
      .executeJavaScript('Boolean(window.__boarReady)')
      .catch(() => false)
    const api = await win.webContents
      .executeJavaScript('typeof window.boar?.pickExportPath === "function"')
      .catch(() => false)
    // Which encoders WebCodecs can run in hardware on this GPU (informational).
    const encoders = await win.webContents
      .executeJavaScript(
        `Promise.all([['H.264', 'avc1.640028'], ['HEVC', 'hvc1.1.6.L120.B0'], ['AV1', 'av01.0.08M.08'], ['VP9', 'vp09.00.40.08']].map(async ([name, codec]) => {
          try {
            const r = await VideoEncoder.isConfigSupported({ codec, width: 1920, height: 1080, bitrate: 8e6, framerate: 30, hardwareAcceleration: 'prefer-hardware' })
            return name + '=' + (r.supported ? 'hw' : 'no')
          } catch { return name + '=error' }
        })).then((list) => list.join(' '))`
      )
      .catch(() => 'unknown')
    console.log(`[smoke] hardware encoders: ${encoders}`)
    // Media protocol: range request + <video> metadata, using a demo file when present.
    const sample = join(app.getAppPath(), 'dev-samples', 'demo-16x9.mp4')
    if (existsSync(sample)) {
      allowMediaPaths([sample])
      const url = `boar-media://local/${encodeURIComponent(sample)}`
      const media = await win.webContents
        .executeJavaScript(
          `(async () => {
            const r = await fetch(${JSON.stringify(url)}, { headers: { Range: 'bytes=100-199' } })
            const bytes = (await r.arrayBuffer()).byteLength
            const v = document.createElement('video')
            v.muted = true
            v.src = ${JSON.stringify(url)}
            const duration = await new Promise((resolve) => {
              v.onloadedmetadata = () => resolve(v.duration)
              v.onerror = () => resolve('error')
              setTimeout(() => resolve('timeout'), 5000)
            })
            return 'range=' + r.status + '/' + bytes + 'B video=' + duration
          })()`
        )
        .catch((err: unknown) => `failed: ${String(err)}`)
      console.log(`[smoke] media protocol: ${media}`)
    }
    console.log(`[smoke] ready=${ready} bridge=${api} consoleErrors=${errors.length}`)
    for (const message of errors) console.log(`[smoke] error: ${message}`)
    app.exit(ready && api && errors.length === 0 ? 0 : 1)
  })
}

app.whenReady().then(() => {
  handleMediaProtocol()
  registerIpc()
  registerCaptionIpc()
  registerLibraryIpc()
  // AI agents (MCP): not in smoke runs, which may overlap a running editor.
  if (!smoke) void registerMcp(() => mainWindow)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

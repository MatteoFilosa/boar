import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { existsSync } from 'node:fs'
import { open, readFile, unlink, writeFile, type FileHandle } from 'node:fs/promises'
import { extname, join, relative, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { allowMediaPaths, handleMediaProtocol, registerMediaScheme } from './media-protocol'
import { registerCaptionIpc, whisperPath, whisperRuns } from './captions'
import { registerLibraryIpc } from './library'
import { registerMcp } from './mcp'
import { extendToolPath } from './toolPath'
import { registerUpdateIpc } from './updates'
import { blockExternalRequests, disableBackgroundNetworking } from './privacy'
import { registerProxyIpc } from './proxies'
import { abandonAutosaveSession, endAutosaveSession, registerAutosaveIpc } from './autosave'
import { addRecentProject, clearRecentProjects, findRecentProject, keepRecentProjects, recentProjects } from './recent'
import { log, registerLogIpc, setCrashNotice, startLog, watchWindow } from './log'

// `--smoke`: load the UI hidden, report renderer errors, exit. Used to verify builds.
const smoke = process.argv.includes('--smoke')

registerMediaScheme()
extendToolPath()
disableBackgroundNetworking()
// Own taskbar identity on Windows (icon and grouping), instead of Electron's.
if (process.platform === 'win32') app.setAppUserModelId('io.github.matteofilosa.boar')

/** Editor windows, each with its own project. Agents (MCP) work in the one used last. */
const windows = new Set<BrowserWindow>()
let lastWindow: BrowserWindow | null = null
const editorWindow = (): BrowserWindow | null => lastWindow ?? [...windows].at(-1) ?? null

let quitting = false
app.on('before-quit', () => (quitting = true))

// Projects opened from the file manager (double click, Open with, drag onto
// the app icon): the path comes in the command line on Windows and Linux, or
// as an open-file event on macOS. The window's page takes it when it is ready.

/** The project the first window opens. */
let startProject: string | null = null
/** Projects waiting for their window's page (webContents id → path). */
const launchPaths = new Map<number, string>()

const isProjectFile = (path: string): boolean => extname(path).toLowerCase() === '.boar' && existsSync(path)

/** The project file in a command line, if any (the app's own arguments come after the executable, or after the app folder in development). */
function projectInArgs(argv: string[], workingDir = process.cwd()): string | null {
  for (const arg of argv.slice(app.isPackaged ? 1 : 2)) {
    if (arg.startsWith('-')) continue
    const path = resolve(workingDir, arg)
    if (isProjectFile(path)) return path
  }
  return null
}

function showWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore()
  win.focus()
}

/** Opens a project in the window used last when it shows an empty untitled project, else in a new window. */
async function requestProjectOpen(path: string): Promise<void> {
  // Starting: the first window takes it.
  if (!app.isReady()) {
    startProject = path
    return
  }
  const win = editorWindow()
  const idle = win ? await win.webContents.executeJavaScript('window.__boarIdle === true').catch(() => false) : false
  if (!win || win.isDestroyed() || !idle) {
    createWindow(path)
    return
  }
  launchPaths.set(win.webContents.id, path)
  showWindow(win)
  win.webContents.send('project:launch')
}

startProject = projectInArgs(process.argv)
app.on('open-file', (event, path) => {
  event.preventDefault()
  if (isProjectFile(path)) void requestProjectOpen(path)
})

// One process, several windows: they share settings and caches, which a second
// process could not use (its storage would stay locked by the first). Opening
// Boar again opens another window; a project goes to an empty window or a new
// one. Development and smoke runs are left alone so they can run next to an
// installed copy.
let secondInstance = false
if (app.isPackaged && !smoke) {
  if (!app.requestSingleInstanceLock()) {
    secondInstance = true
    app.exit(0)
  } else {
    app.on('second-instance', (_event, argv, workingDir) => {
      const path = projectInArgs(argv, workingDir)
      if (path) void requestProjectOpen(path)
      else createWindow()
    })
  }
}

// The problem log (Help › Problem Log); a second instance only hands its project over.
if (!secondInstance) startLog(smoke)

/** A new editor window, opening `project` when given; placed a little below and right of the window used last. */
function createWindow(project: string | null = null): void {
  const near = editorWindow()
  const bounds = near && !near.isDestroyed() && !near.isMaximized() && !near.isFullScreen() ? near.getBounds() : null
  const win = new BrowserWindow({
    ...(bounds ? { x: bounds.x + 32, y: bounds.y + 32 } : {}),
    width: bounds?.width ?? 1600,
    height: bounds?.height ?? 940,
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
      // The spellchecker would download dictionaries from Google.
      spellcheck: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  })
  win.setMenu(null)
  windows.add(win)
  lastWindow = win
  const pageId = win.webContents.id
  if (project) launchPaths.set(pageId, project)
  win.on('focus', () => (lastWindow = win))
  win.on('closed', () => {
    windows.delete(win)
    if (lastWindow === win) lastWindow = null
    launchPaths.delete(pageId)
    // Closed normally (unsaved changes were asked about): no copy to recover.
    endAutosaveSession(pageId)
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // A file dropped outside a drop zone must not navigate away from the editor.
  win.webContents.on('will-navigate', (event) => event.preventDefault())

  if (smoke) runSmokeTest(win)
  else {
    win.once('ready-to-show', () => win.show())
    watchWindow(win)
  }

  // The page crashed or was killed: offer to start it again, which offers the autosaved project back.
  win.webContents.on('render-process-gone', (_event, details) => {
    if (smoke || details.reason === 'clean-exit') return
    log('error', 'app', `The editor page stopped: ${details.reason}, exit code ${details.exitCode}`)
    setCrashNotice(`The editor stopped unexpectedly (${details.reason}).`)
    abandonAutosaveSession(pageId)
    // Other windows keep working: only this one closes.
    const others = windows.size > 1
    void dialog
      .showMessageBox(win, {
        type: 'error',
        buttons: ['Reload', others ? 'Close' : 'Quit'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        message: 'The editor stopped unexpectedly.',
        detail: `Reason: ${details.reason}. Reload it to get back the changes autosaved before it stopped.`
      })
      .then(({ response }) => {
        if (win.isDestroyed()) return
        if (response === 0) win.webContents.reload()
        else {
          // No page left to ask about unsaved changes: they wait in the autosave.
          win.destroy()
          if (!others) app.quit()
        }
      })
  })

  // Unsaved changes (the renderer gives the project name): save, discard or stay.
  let closing = false
  let asking = false
  win.on('close', (event) => {
    if (closing || smoke) return
    event.preventDefault()
    if (asking) return
    asking = true
    void win.webContents
      .executeJavaScript('window.__boarUnsaved ?? null')
      .catch(() => null)
      .then(async (name: string | null) => {
        if (name !== null) {
          const { response } = await dialog.showMessageBox(win, {
            type: 'warning',
            buttons: ['Save', "Don't Save", 'Cancel'],
            defaultId: 0,
            cancelId: 2,
            noLink: true,
            message: `Do you want to save the changes to “${name}”?`,
            detail: "Your changes are lost if you don't save them."
          })
          const saved =
            response === 0 &&
            (await win.webContents.executeJavaScript('window.__boarSave ? window.__boarSave() : false').catch(() => false))
          if (response === 2 || (response === 0 && !saved)) {
            quitting = false
            return
          }
        }
        closing = true
        win.close()
        // A quit (Cmd+Q) was interrupted by the question: finish it.
        if (quitting) app.quit()
      })
      .finally(() => (asking = false))
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

// Render output files
// The renderer may only write to files the user picked in a save dialog.

/** Render As file types by extension: the save dialog's filter and the folder it opens in. */
const RENDER_TYPES: Record<string, { name: string; folder: 'videos' | 'music' | 'pictures' }> = {
  mp4: { name: 'MP4 video', folder: 'videos' },
  gif: { name: 'Animated GIF', folder: 'pictures' },
  mp3: { name: 'MP3 audio', folder: 'music' },
  wav: { name: 'WAV audio', folder: 'music' },
  flac: { name: 'FLAC audio', folder: 'music' },
  m4a: { name: 'M4A audio', folder: 'music' },
  ogg: { name: 'OGG audio', folder: 'music' }
}

const userChosenPaths = new Set<string>()
/** Project files the user opened or saved: saving writes back to them without a dialog. */
const projectPaths = new Set<string>()
const openFiles = new Map<number, FileHandle>()
let nextFileId = 1

function registerIpc(): void {
  ipcMain.handle('export:pick', async (event, suggestedName: string) => {
    const extension = extname(String(suggestedName)).slice(1).toLowerCase()
    const type = RENDER_TYPES[extension] ?? RENDER_TYPES.mp4
    const options = {
      title: 'Render As',
      defaultPath: join(app.getPath(type.folder), suggestedName),
      filters: [{ name: type.name, extensions: [RENDER_TYPES[extension] ? extension : 'mp4'] }]
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

  // Progress of long tasks on the taskbar button: 0..1, above 1 indeterminate, below 0 hidden.
  ipcMain.on('app:progress', (event, value: unknown) => {
    if (typeof value === 'number' && Number.isFinite(value)) BrowserWindow.fromWebContents(event.sender)?.setProgressBar(value)
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

  // Help › Report a Problem shows these for the user to copy; nothing is sent.
  ipcMain.handle('app:systemInfo', () => {
    const names: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }
    return {
      os: `${names[process.platform] ?? process.platform} ${process.getSystemVersion()} ${process.arch}`,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      packaged: app.isPackaged
    }
  })

  // Theme files: written only where the user picks in the save dialog.
  ipcMain.handle('theme:save', async (event, json: unknown, name: unknown) => {
    if (typeof json !== 'string' || json.length > 200_000) throw new Error('Not a theme')
    const safeName = (typeof name === 'string' ? name : 'Theme').replace(/[^\w\- ]+/g, '').trim() || 'Theme'
    const options = {
      title: 'Export Theme',
      defaultPath: join(app.getPath('documents'), `${safeName}.boartheme.json`),
      filters: [{ name: 'Boar theme', extensions: ['json'] }]
    }
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, json, 'utf8')
    return result.filePath
  })

  // Projects (.boar JSON). Saving without a dialog is only allowed to a
  // project path the user already picked or opened.
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
    void addRecentProject(path)
    return path
  })
  // A project the user opened: its media may be served, and saving writes back to it.
  const readProject = async (path: string): Promise<{ path: string; json: string }> => {
    const json = await readFile(path, 'utf8')
    try {
      const data = JSON.parse(json) as { media?: { path?: string; convertedFrom?: string }[] }
      allowMediaPaths((data.media ?? []).flatMap((m) => [m.path ?? '', m.convertedFrom ?? '']))
    } catch {
      // Invalid file: the renderer reports it.
    }
    projectPaths.add(path)
    void addRecentProject(path)
    return { path, json }
  }
  ipcMain.handle('project:open', async (event) => {
    const options = { title: 'Open Project', properties: ['openFile' as const], filters: [...filters, { name: 'All files', extensions: ['*'] }] }
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    const path = result.filePaths[0]
    if (result.canceled || !path) return null
    return readProject(path)
  })
  // The project this window was opened for (Boar started with it, or the file manager sent it).
  ipcMain.handle('project:takeLaunch', async (event) => {
    const path = launchPaths.get(event.sender.id)
    launchPaths.delete(event.sender.id)
    return path ? readProject(path) : null
  })
  // File › New Window.
  ipcMain.on('app:newWindow', () => createWindow())
  // A .boar file dropped on the window.
  ipcMain.handle('project:openDropped', async (_event, path: unknown) => {
    if (typeof path !== 'string' || !isProjectFile(path)) throw new Error('Not a Boar project')
    return readProject(path)
  })
  // File › Open Recent: only projects on the list open without the dialog.
  ipcMain.handle('project:recent', () => recentProjects())
  ipcMain.handle('project:openRecent', async (_event, path: unknown) => {
    const known = typeof path === 'string' ? await findRecentProject(path) : null
    if (!known) throw new Error('Not a recent project')
    if (!existsSync(known)) throw new Error('The file was moved or deleted')
    return readProject(known)
  })
  ipcMain.handle('project:clearRecent', () => clearRecentProjects())
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
    // The bundled speech engine must start (CI builds always include it).
    const engine = existsSync(whisperPath()) ? ((await whisperRuns()) ? 'ok' : 'fails to start') : 'missing'
    const engineOk = engine === 'ok' || (engine === 'missing' && !process.env.CI)
    console.log(`[smoke] speech engine: ${engine}${engine === 'missing' ? ' (npm run whisper)' : ''}`)
    // A small generated project rendered and compared with what it must look and sound like (renderCheck.ts).
    const render = (await win.webContents
      .executeJavaScript('window.__boarRenderCheck ? window.__boarRenderCheck() : null')
      .catch((err: unknown) => ({ ok: false, codec: '', failures: [String(err)], skipped: [], audioOffsetMs: null, audioCodec: '', encoderDelay: 0, formats: [], ms: 0 }))) as {
      ok: boolean
      codec: string
      failures: string[]
      skipped: string[]
      audioOffsetMs: number | null
      audioCodec: string
      encoderDelay: number
      formats: string[]
      ms: number
    } | null
    if (!render) console.log('[smoke] render check: missing')
    else {
      const skipped = render.skipped.length ? ` (skipped: ${render.skipped.join(', ')})` : ''
      const sync = render.audioOffsetMs === null ? '' : `, sound ${render.audioOffsetMs} ms after the picture`
      const delay = render.encoderDelay ? ` (${render.encoderDelay} samples of encoder delay taken out)` : ''
      const others = render.formats.length ? `, also ${render.formats.join(', ')}` : ''
      console.log(`[smoke] render check: ${render.ok ? 'ok' : 'FAILED'} with ${render.codec}/${render.audioCodec}${others}${sync}${delay} in ${render.ms} ms${skipped}`)
      for (const failure of render.failures) console.log(`[smoke] render: ${failure}`)
    }
    console.log(`[smoke] ready=${ready} bridge=${api} consoleErrors=${errors.length}`)
    for (const message of errors) console.log(`[smoke] error: ${message}`)
    app.exit(ready && api && engineOk && render?.ok && errors.length === 0 ? 0 : 1)
  })
}

app.whenReady().then(() => {
  // The editor has its own menu bar; macOS still needs the standard app, edit
  // (copy and paste in text fields) and window menus.
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]))
  }
  blockExternalRequests()
  handleMediaProtocol()
  keepRecentProjects(!smoke)
  registerIpc()
  registerCaptionIpc()
  registerLibraryIpc()
  registerUpdateIpc()
  registerProxyIpc()
  registerAutosaveIpc(projectPaths, smoke)
  registerLogIpc()
  // AI agents (MCP): not in smoke runs, which may overlap a running editor.
  if (!smoke) void registerMcp(editorWindow)
  createWindow(startProject)
  startProject = null
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

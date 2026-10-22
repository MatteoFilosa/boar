import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Problem log: what Boar did and what went wrong (render settings and stalls,
// crashes of the page or the graphics process, errors and warnings of the
// page), kept in userData/logs/boar.log for Help › Problem Log. The user
// copies it into a problem report: nothing is sent anywhere. Paths in the
// home folder are written as ~. Each run leaves a marker file that a normal
// quit deletes, so the next start knows the last one ended badly.

export type LogLevel = 'info' | 'warn' | 'error'

/** Past this size the log moves to boar.old.log when Boar starts. */
const MAX_BYTES = 1_000_000
/** Lines one run may write (a page stuck in a loop of errors must not fill the disk). */
const MAX_LINES = 4000
/** The same message more often than this in one run is left out. */
const MAX_REPEATS = 5
/** Lines shown by Help › Problem Log. */
const SHOWN_LINES = 400

const folder = (): string => join(app.getPath('userData'), 'logs')
const logPath = (): string => join(folder(), 'boar.log')
const markerPath = (pid = process.pid): string => join(folder(), `running-${pid}.json`)

/** Where lines go; null in smoke runs (they keep nothing) or when the folder cannot be written. */
let file: string | null = null
let written = 0
const repeats = new Map<string, number>()
/** Why the last run or the page ended badly, for the page to show once. */
let notice: string | null = null

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const home = homedir()
const homePattern = home
  ? new RegExp([home, home.replace(/\\/g, '/'), encodeURIComponent(home)].map(escapeRegExp).join('|'), process.platform === 'linux' ? 'g' : 'gi')
  : null

/** The text with the home folder written as ~ (log lines hold file paths, which hold the user's name). */
const withoutHome = (text: string): string => (homePattern ? text.replace(homePattern, '~') : text)

/** Writes a line (more lines of a message, like a stack, are indented under it). */
export function log(level: LogLevel, source: string, message: string): void {
  const text = withoutHome(message.trim()).replace(/\r?\n/g, '\n    ')
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${source}] ${text}`
  if (!file) {
    if (level !== 'info') console.log(line)
    return
  }
  const seen = (repeats.get(text) ?? 0) + 1
  repeats.set(text, seen)
  if (seen > MAX_REPEATS || written > MAX_LINES) return
  written++
  const extra =
    written > MAX_LINES ? '\n(log limit for this run reached: later lines are left out)' : seen === MAX_REPEATS ? ' (repeated: left out from now on)' : ''
  try {
    appendFileSync(file, `${line}${extra}\n`)
  } catch {
    // A full or read-only disk: the log is a help, never a reason to fail.
  }
}

/** Sets a message the page shows (with the log) when it starts or reloads. */
export function setCrashNotice(message: string): void {
  notice = message
}

const SYSTEMS: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }

/** Graphics card, driver and video acceleration: the first things to know about render and preview problems. */
async function logGraphics(): Promise<void> {
  try {
    const info = (await app.getGPUInfo('complete')) as {
      gpuDevice?: { deviceString?: string; vendorId?: number; deviceId?: number; driverVersion?: string; active?: boolean }[]
      auxAttributes?: { glRenderer?: string }
    }
    for (const d of info.gpuDevice ?? []) {
      const id = `${(d.vendorId ?? 0).toString(16).padStart(4, '0')}:${(d.deviceId ?? 0).toString(16).padStart(4, '0')}`
      log('info', 'gpu', `${d.deviceString || 'Graphics device'} (${id})${d.driverVersion ? `, driver ${d.driverVersion}` : ''}${d.active ? ', active' : ''}`)
    }
    if (info.auxAttributes?.glRenderer) log('info', 'gpu', `Renderer: ${info.auxAttributes.glRenderer}`)
    const status = app.getGPUFeatureStatus()
    log('info', 'gpu', `Video decode: ${status.video_decode}, video encode: ${status.video_encode}, WebGL: ${status.webgl}, compositing: ${status.gpu_compositing}`)
  } catch (err) {
    log('warn', 'gpu', `No graphics information: ${String(err)}`)
  }
}

/**
 * Opens the log for this run (call once, before the app is ready). In smoke
 * runs lines only go to the console.
 */
export function startLog(smoke: boolean): void {
  process.on('uncaughtException', (err) => {
    log('error', 'main', `Uncaught exception: ${err.stack ?? String(err)}`)
    console.error(err)
    if (!smoke) dialog.showErrorBox('Boar: an error in the main process', `${err.message}

The details are in Help › Problem Log.`)
  })
  process.on('unhandledRejection', (reason) => {
    log('error', 'main', `Unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`)
  })
  if (smoke) return
  try {
    mkdirSync(folder(), { recursive: true })
    if (existsSync(logPath()) && statSync(logPath()).size > MAX_BYTES) renameSync(logPath(), join(folder(), 'boar.old.log'))
    file = logPath()
    // Markers of runs whose process is gone: they did not quit normally.
    for (const name of readdirSync(folder())) {
      const pid = Number(/^running-(\d+)\.json$/.exec(name)?.[1])
      if (!pid || pid === process.pid || isRunning(pid)) continue
      let started = ''
      try {
        started = String((JSON.parse(readFileSync(join(folder(), name), 'utf8')) as { started?: string }).started ?? '')
      } catch {
        // Damaged marker: still a run that did not quit.
      }
      unlinkSync(join(folder(), name))
      const when = started ? ` (it started ${new Date(started).toLocaleString()})` : ''
      notice = `Boar closed unexpectedly last time${when}: it crashed, was ended from outside, or the computer turned off.`
    }
    writeFileSync(markerPath(), JSON.stringify({ started: new Date().toISOString(), version: app.getVersion() }))
  } catch {
    file = null
  }
  log(
    'info',
    'app',
    `Boar ${app.getVersion()}${app.isPackaged ? '' : ' (from the sources)'} on ${SYSTEMS[process.platform] ?? process.platform} ${process.getSystemVersion()} ${process.arch}, Electron ${process.versions.electron}, Chromium ${process.versions.chrome}`
  )
  if (notice) log('error', 'app', 'The previous run did not close normally')

  app.on('will-quit', () => {
    log('info', 'app', 'Closed')
    try {
      unlinkSync(markerPath())
    } catch {
      // Not written.
    }
  })
  // The graphics, network or utility processes: a GPU crash takes the preview and renders with it.
  app.on('child-process-gone', (_event, d) => {
    if (d.reason === 'clean-exit') return
    const name = d.name || d.serviceName || d.type
    log('error', d.type.toLowerCase(), `${name} process stopped: ${d.reason}, exit code ${d.exitCode}`)
    if (d.type === 'GPU') {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('log:problem', `The graphics process stopped (${d.reason}) and was restarted: see Help › Problem Log`)
      }
    }
  })
  void app.whenReady().then(logGraphics)
}

/** Browser hints that say nothing about a problem. */
const NOISE = [/^Canvas2D: Multiple readback operations/, /Electron Security Warning/]

/** Writes the page's warnings and errors to the log, and notes when it stops answering. */
export function watchWindow(win: BrowserWindow): void {
  win.webContents.on('console-message', (event) => {
    const { level, message, sourceId, lineNumber } = event as unknown as { level: string | number; message: string; sourceId?: string; lineNumber?: number }
    const kind = level === 'error' || level === 3 ? 'error' : level === 'warning' || level === 2 ? 'warn' : null
    // Uncaught errors are logged by the page itself, with their stack.
    if (!kind || message.startsWith('Uncaught ') || NOISE.some((r) => r.test(message))) return
    const where = sourceId ? ` (${sourceId.replace(/^.*\/(?=[^/]+$)/, '')}:${lineNumber ?? 0})` : ''
    log(kind, 'page', `${message}${where}`)
  })
  win.webContents.on('preload-error', (_event, path, error) => log('error', 'preload', `${path}: ${error.stack ?? error.message}`))
  win.on('unresponsive', () => log('warn', 'app', 'The editor stopped responding'))
  win.on('responsive', () => log('info', 'app', 'The editor responds again'))
}

export function registerLogIpc(): void {
  ipcMain.on('log:write', (_event, level: unknown, message: unknown) => {
    if (typeof message !== 'string') return
    const kind: LogLevel = level === 'error' || level === 'warn' ? level : 'info'
    log(kind, 'editor', message.slice(0, 20_000))
  })
  ipcMain.handle('log:read', async () => {
    let text = ''
    try {
      text = await readFile(logPath(), 'utf8')
    } catch {
      // No log yet.
    }
    const lines = text.split('\n')
    // Whole entries only: never start in the middle of a stack.
    let from = Math.max(0, lines.length - SHOWN_LINES)
    while (from > 0 && lines[from].startsWith(' ')) from--
    return { text: lines.slice(from).join('\n').trimEnd(), path: withoutHome(logPath()) }
  })
  ipcMain.handle('log:reveal', () => {
    if (existsSync(logPath())) shell.showItemInFolder(logPath())
    else void shell.openPath(folder())
  })
  ipcMain.handle('log:crashNotice', () => {
    const text = notice
    notice = null
    return text
  })
}

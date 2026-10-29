import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { randomBytes } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { allowMediaPaths } from './media-protocol'

// Crash recovery. While the project has unsaved changes the renderer sends a
// copy of it now and then (core/autosave.ts), kept in userData/Autosave as
// <pid>-<session>.boar with a small <pid>-<session>.json beside it. Closing the
// window deletes it, so a copy is left only when Boar did not close: the
// process is gone (crash, power cut, killed) or the page stopped (renderer
// crash, then Reload). The next start offers it back.

interface AutosaveMeta {
  /** The project's own file, when it has one the user opened or saved. */
  projectPath: string | null
  savedAt: number
  version: string
}

export interface RecoveredProject {
  path: string | null
  json: string
  savedAt: number
}

/** Copies left this long are not offered any more (and are deleted). */
const KEEP_DAYS = 30

const folder = (): string => join(app.getPath('userData'), 'Autosave')

/** Session of each page (webContents id → file name without extension). A reload starts a new one. */
const sessions = new Map<number, string>()

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const removeCopy = (name: string): Promise<unknown> =>
  Promise.all([unlink(join(folder(), `${name}.boar`)), unlink(join(folder(), `${name}.json`))].map((p) => p.catch(() => undefined)))

/** Copies no running page writes to: their process is gone, or their page of this process stopped. Newest first. */
async function leftCopies(): Promise<{ name: string; meta: AutosaveMeta }[]> {
  let files: string[]
  try {
    files = await readdir(folder())
  } catch {
    return []
  }
  const live = new Set(sessions.values())
  const found: { name: string; meta: AutosaveMeta }[] = []
  for (const file of files) {
    const match = /^(\d+)-[0-9a-f]+\.json$/.exec(file)
    if (!match) continue
    const name = file.slice(0, -'.json'.length)
    const pid = Number(match[1])
    // Another Boar that is still open (a development run next to an installed copy).
    if (live.has(name) || (pid !== process.pid && isRunning(pid))) continue
    try {
      const meta = JSON.parse(await readFile(join(folder(), file), 'utf8')) as AutosaveMeta
      if (!files.includes(`${name}.boar`) || !Number.isFinite(meta.savedAt) || Date.now() - meta.savedAt > KEEP_DAYS * 86_400_000) {
        await removeCopy(name)
        continue
      }
      found.push({ name, meta: { ...meta, projectPath: typeof meta.projectPath === 'string' ? meta.projectPath : null } })
    } catch {
      await removeCopy(name)
    }
  }
  return found.sort((a, b) => b.meta.savedAt - a.meta.savedAt)
}

/** Deletes the copy of a page whose window closed normally. */
export function endAutosaveSession(webContentsId: number): void {
  const name = sessions.get(webContentsId)
  if (!name) return
  sessions.delete(webContentsId)
  for (const ext of ['.boar', '.json']) {
    try {
      unlinkSync(join(folder(), name + ext))
    } catch {
      // Never written.
    }
  }
}

/** The page stopped: its copy is kept and offered when the page starts again. */
export function abandonAutosaveSession(webContentsId: number): void {
  sessions.delete(webContentsId)
}

/**
 * @param projectPaths project files the user opened or saved in this run (saving writes back to them)
 * @param smoke smoke-test run: no questions
 */
export function registerAutosaveIpc(projectPaths: Set<string>, smoke: boolean): void {
  let asking = false

  // Called once by each page when it starts: a new session, and the copies left by earlier ones.
  ipcMain.handle('autosave:recover', async (event): Promise<RecoveredProject | null> => {
    // Smoke runs keep nothing: their render check must not leave a copy to recover.
    if (smoke) return null
    const id = event.sender.id
    const session = `${process.pid}-${randomBytes(6).toString('hex')}`
    sessions.set(id, session)
    if (asking) return null
    const win = BrowserWindow.fromWebContents(event.sender)
    asking = true
    try {
      for (const { name, meta } of await leftCopies()) {
        const title = meta.projectPath ? basename(meta.projectPath).replace(/\.boar$/i, '') : 'Untitled'
        const options = {
          type: 'question' as const,
          buttons: ['Recover', 'Not Now', 'Discard'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
          message: `Boar closed without saving “${title}”.`,
          detail: `The changes autosaved on ${new Date(meta.savedAt).toLocaleString()} can be recovered. Discard deletes them.`
        }
        const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
        if (response === 1) return null
        if (response === 2) {
          await removeCopy(name)
          continue
        }
        const json = await readFile(join(folder(), `${name}.boar`), 'utf8')
        try {
          const data = JSON.parse(json) as { media?: { path?: string; convertedFrom?: string }[] }
          allowMediaPaths((data.media ?? []).flatMap((m) => [m.path ?? '', m.convertedFrom ?? '']))
        } catch {
          // Damaged copy: the renderer reports it.
        }
        if (meta.projectPath) projectPaths.add(meta.projectPath)
        // The copy becomes this page's own: kept until the next autosave replaces it.
        if (sessions.get(id) === session) {
          await rename(join(folder(), `${name}.boar`), join(folder(), `${session}.boar`)).catch(() => undefined)
          await rename(join(folder(), `${name}.json`), join(folder(), `${session}.json`)).catch(() => undefined)
        }
        return { path: meta.projectPath, json, savedAt: meta.savedAt }
      }
      return null
    } finally {
      asking = false
    }
  })

  ipcMain.handle('autosave:write', async (event, json: unknown, projectPath: unknown) => {
    const session = sessions.get(event.sender.id)
    if (!session || typeof json !== 'string') return
    await mkdir(folder(), { recursive: true })
    const base = join(folder(), session)
    // Write beside and rename, so a crash during the write keeps the previous copy.
    await writeFile(`${base}.boar.tmp`, json, 'utf8')
    await rename(`${base}.boar.tmp`, `${base}.boar`).catch(() => writeFile(`${base}.boar`, json, 'utf8'))
    const meta: AutosaveMeta = {
      projectPath: typeof projectPath === 'string' && projectPaths.has(projectPath) ? projectPath : null,
      savedAt: Date.now(),
      version: app.getVersion()
    }
    await writeFile(`${base}.json`, JSON.stringify(meta), 'utf8')
  })

  // Nothing unsaved any more (saved, or undone back to the saved state).
  ipcMain.handle('autosave:clear', async (event) => {
    const session = sessions.get(event.sender.id)
    if (session) await removeCopy(session)
  })
}

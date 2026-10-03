import { app, ipcMain, net, shell, type WebContents } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, copyFile, mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

// Updates from the GitHub releases of the repository. The installer for this
// system is downloaded, checked against the SHA-256 that GitHub publishes for
// it, and run when Boar closes (Windows) or put in place of the AppImage. A dmg
// or deb is opened for the user to install.

const REPO = 'MatteoFilosa/boar'

export interface UpdateInfo {
  current: string
  latest: string
  available: boolean
  page: string
  /** Installer of the release for this system, null when there is none. */
  file: { name: string; size: number } | null
  /** restart: Boar installs it and starts again; open: the file opens for the user to install. */
  mode: 'restart' | 'open'
}

interface Asset {
  name: string
  size: number
  browser_download_url: string
  digest?: string | null
}

let release: { info: UpdateInfo; asset: Asset | null } | null = null
let downloaded: { version: string; path: string } | null = null
let downloading: Promise<void> | null = null
let abort: AbortController | null = null
let installOnQuit: { path: string; restart: boolean } | null = null
let relaunchAppImage = false

const versionParts = (v: string): number[] =>
  v
    .replace(/^v/, '')
    .split(/[.-]/)
    .slice(0, 3)
    .map((n) => Number.parseInt(n, 10) || 0)

function isNewer(a: string, b: string): boolean {
  const x = versionParts(a)
  const y = versionParts(b)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}

const appImage = (): string | undefined => process.env.APPIMAGE

function pickAsset(assets: Asset[]): Asset | null {
  const find = (pattern: RegExp): Asset | null => assets.find((a) => pattern.test(a.name)) ?? null
  if (process.platform === 'win32') return find(/^Boar-Setup-.*\.exe$/)
  if (process.platform === 'darwin') return find(process.arch === 'arm64' ? /-arm64\.dmg$/ : /-x64\.dmg$/)
  if (process.platform === 'linux') return appImage() ? find(/\.AppImage$/) : find(/\.deb$/)
  return null
}

async function check(): Promise<UpdateInfo | null> {
  // Builds run from the sources do not update; BOAR_UPDATE_FROM sets the version to compare (tests).
  const current = process.env.BOAR_UPDATE_FROM ?? (app.isPackaged ? app.getVersion() : null)
  if (!current) return null
  const response = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Boar' }
  })
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`)
  const data = (await response.json()) as { tag_name: string; html_url: string; assets: Asset[] }
  const latest = data.tag_name.replace(/^v/, '')
  const asset = pickAsset(data.assets ?? [])
  const info: UpdateInfo = {
    current,
    latest,
    available: isNewer(latest, current),
    page: data.html_url,
    file: asset && { name: asset.name, size: asset.size },
    mode: process.platform === 'win32' || appImage() ? 'restart' : 'open'
  }
  release = { info, asset }
  return info
}

async function fetchAsset(asset: Asset, version: string, sender: WebContents): Promise<void> {
  const dir = join(app.getPath('temp'), 'boar-update')
  await mkdir(dir, { recursive: true })
  const target = join(dir, asset.name)
  const partial = `${target}.part`
  abort = new AbortController()
  const response = await net.fetch(asset.browser_download_url, { signal: abort.signal })
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status})`)
  const hash = createHash('sha256')
  const file = createWriteStream(partial)
  const reader = response.body.getReader()
  let received = 0
  let reported = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      hash.update(value)
      received += value.byteLength
      if (!file.write(value)) await new Promise<void>((r) => file.once('drain', () => r()))
      const progress = received / asset.size
      if (progress - reported >= 0.005) {
        reported = progress
        sender.send('update:progress', progress)
      }
    }
    await new Promise<void>((r, reject) => file.end((err?: Error | null) => (err ? reject(err) : r())))
    const expected = asset.digest?.replace(/^sha256:/, '')
    if (expected && hash.digest('hex') !== expected) throw new Error('The download is damaged (checksum mismatch)')
    await rename(partial, target)
    downloaded = { version, path: target }
  } catch (err) {
    file.destroy()
    await rm(partial, { force: true })
    throw err
  } finally {
    abort = null
  }
}

function download(sender: WebContents): Promise<void> {
  const asset = release?.asset
  if (!release || !asset) return Promise.reject(new Error('No update to download'))
  if (downloaded?.version === release.info.latest) return Promise.resolve()
  downloading ??= fetchAsset(asset, release.info.latest, sender).finally(() => (downloading = null))
  return downloading
}

/** now: install and start again; otherwise when Boar closes. */
async function install(now: boolean): Promise<void> {
  if (!downloaded || !release) throw new Error('Download the update first')
  const target = appImage()
  if (release.info.mode === 'open') {
    const error = await shell.openPath(downloaded.path)
    if (error) throw new Error(error)
    return
  }
  if (target) {
    // The running AppImage stays mounted: the new file takes its place for the next start.
    const next = `${target}.new`
    await copyFile(downloaded.path, next)
    await chmod(next, 0o755)
    await rename(next, target)
    relaunchAppImage = now
  } else {
    installOnQuit = { path: downloaded.path, restart: now }
  }
  if (now) app.quit()
}

export function registerUpdateIpc(): void {
  ipcMain.handle('update:check', () => check())
  ipcMain.handle('update:download', (event) => download(event.sender))
  ipcMain.handle('update:cancel', () => abort?.abort())
  ipcMain.handle('update:install', (_event, now: boolean) => install(now))
  ipcMain.handle('update:page', () => {
    const page = release?.info.page
    if (page?.startsWith(`https://github.com/${REPO}/`)) void shell.openExternal(page)
  })
  app.on('will-quit', () => {
    if (installOnQuit) {
      // NSIS: silent update into the installed folder; --force-run starts Boar afterwards.
      const args = ['--updated', '/S', ...(installOnQuit.restart ? ['--force-run'] : [])]
      spawn(installOnQuit.path, args, { detached: true, stdio: 'ignore' }).unref()
    } else if (relaunchAppImage && appImage()) {
      spawn(appImage()!, [], { detached: true, stdio: 'ignore' }).unref()
    }
  })
}

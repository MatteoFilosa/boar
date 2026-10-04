import { app, session } from 'electron'

// Boar sends nothing anywhere: no usage logs, no analytics, no telemetry. The
// only connections it makes are downloads the user asks for, from the main
// process: the update check and installer (GitHub), speech models (Hugging
// Face) and yt-dlp (GitHub). Every other request is cancelled here, whatever
// makes it (the editor page, a library inside it, Chromium), and the Chromium
// features that may contact servers on their own are turned off.

/** Hosts the main process may download from, with their subdomains (CDN redirects). */
const DOWNLOAD_HOSTS = ['github.com', 'githubusercontent.com', 'huggingface.co', 'hf.co']

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

const isLocalHost = (host: string): boolean => LOCAL_HOSTS.has(host)
const isDownloadHost = (host: string): boolean => DOWNLOAD_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))

/** Before the app is ready: no background networking, pings, field trials or component updates. */
export function disableBackgroundNetworking(): void {
  for (const flag of ['disable-background-networking', 'disable-component-update', 'disable-domain-reliability', 'no-pings', 'disable-breakpad']) {
    app.commandLine.appendSwitch(flag)
  }
  app.commandLine.appendSwitch(
    'disable-features',
    ['AutofillServerCommunication', 'MediaRouter', 'OptimizationHints', 'NetworkTimeServiceQuerying', 'Translate', 'SpellcheckService'].join(',')
  )
}

/** Once the app is ready: cancel every request to other hosts except the user's downloads. */
export function blockExternalRequests(): void {
  const ses = session.defaultSession
  ses.setSpellCheckerEnabled(false)
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
    let host = ''
    try {
      host = new URL(details.url).hostname
    } catch {
      callback({ cancel: true })
      return
    }
    // Pages (the editor) never go online; the main process only downloads from known hosts.
    const fromPage = details.webContentsId !== undefined
    const allowed = isLocalHost(host) || (!fromPage && isDownloadHost(host))
    if (!allowed) console.warn(`[privacy] blocked ${fromPage ? 'page' : 'app'} request to ${host}`)
    callback({ cancel: !allowed })
  })
}

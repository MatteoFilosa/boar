// The editor never talks to the internet: no usage logs, no analytics, no
// telemetry from libraries (MediaPipe, for one, tries to send usage logs to
// Google every minute). Requests to other hosts are refused here before they
// are made; the Content Security Policy and the main process block them too.
// Downloads the user asks for (updates, speech models) run in the main process.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** True for the app's own files and the dev server; false for any other host. */
function isLocal(target: string | URL): boolean {
  let url: URL
  try {
    url = new URL(target, location.href)
  } catch {
    return true
  }
  if (!/^(https?|wss?):$/.test(url.protocol)) return true
  return url.origin === location.origin || LOCAL_HOSTS.has(url.hostname)
}

const refused = (url: string): TypeError => new TypeError(`Boar does not connect to other hosts (${new URL(url, location.href).host})`)

const originalFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  return isLocal(url) ? originalFetch(input, init) : Promise.reject(refused(url))
}

const originalOpen = XMLHttpRequest.prototype.open
XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
  if (!isLocal(url)) throw refused(String(url))
  return (originalOpen as (...args: unknown[]) => void).call(this, method, url, ...rest)
} as typeof XMLHttpRequest.prototype.open

const originalBeacon = navigator.sendBeacon?.bind(navigator)
if (originalBeacon) navigator.sendBeacon = (url: string | URL, data?: BodyInit | null): boolean => isLocal(url) && originalBeacon(url, data)

export {}

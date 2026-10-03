import { net, protocol } from 'electron'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'

// Media referenced by a saved project is streamed to the renderer through
// boar-media://local/<encoded absolute path>, with HTTP Range support so
// <video> seeking and WebCodecs demuxing read only what they need.
// Only files listed in a project the user opened, files inside media library
// folders the user picked, and files the app created itself are served.

export const MEDIA_SCHEME = 'boar-media'

const allowed = new Set<string>()

const allowedDirs = new Set<string>()

export function allowMediaPaths(paths: Iterable<string>): void {
  for (const path of paths) if (path) allowed.add(path)
}

/** Serves every file inside a folder (library folders picked by the user, the app's own folders). */
export function allowMediaDir(dir: string): void {
  if (dir && isAbsolute(dir)) allowedDirs.add(resolve(dir))
}

function isAllowed(path: string): boolean {
  if (allowed.has(path)) return true
  if (!isAbsolute(path)) return false
  const full = resolve(path)
  for (const dir of allowedDirs) {
    const rel = relative(dir, full)
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return true
  }
  return false
}

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp'
}

// The renderer page (http://localhost in dev, file:// when packaged) is another
// origin: without CORS headers Web Audio would play these files as silence and
// canvases drawing them would become unreadable (no Video FX).
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges'
}

export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }
  ])
}

export function handleMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const url = new URL(request.url)
    const path = decodeURIComponent(url.pathname.slice(1))
    if (!isAllowed(path)) return new Response('Forbidden', { status: 403, headers: CORS })
    let size: number
    try {
      size = (await stat(path)).size
    } catch {
      return new Response('Not found', { status: 404, headers: CORS })
    }
    const type = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
    const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') ?? '')
    if (!range) {
      // Whole file: let Electron's file loader stream it.
      const response = await net.fetch(pathToFileURL(path).toString())
      return new Response(response.body, {
        status: 200,
        headers: { ...CORS, 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' }
      })
    }
    let start = range[1] ? Number(range[1]) : 0
    let end = range[2] ? Number(range[2]) : size - 1
    if (!range[1] && range[2]) {
      // Suffix range: last N bytes.
      start = Math.max(0, size - Number(range[2]))
      end = size - 1
    }
    end = Math.min(end, size - 1)
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { ...CORS, 'Content-Range': `bytes */${size}` } })
    }
    const stream = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream<Uint8Array>
    return new Response(stream, {
      status: 206,
      headers: {
        ...CORS,
        'Content-Type': type,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes'
      }
    })
  })
}

// Builds the app icons from resources/icon.svg (rendered with Electron), or from
// resources/icon-source.png cut to a circle (--square keeps it square):
//   resources/icon.png                 512 px, window icon
//   resources/icon.ico                 16-256 px, taskbar and installer
//   src/renderer/src/assets/logo.png   128 px, shown in the UI
// Needs FFmpeg in PATH.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const svg = join(root, 'resources', 'icon.svg')
const work = mkdtempSync(join(tmpdir(), 'boar-icons-'))
let source = join(root, 'resources', 'icon-source.png')
let square = process.argv.includes('--square')
if (existsSync(svg)) {
  const electron = (await import('electron')).default
  source = join(work, 'svg.png')
  execFileSync(electron, [join(root, 'scripts', 'render-svg.cjs'), svg, source, '1024'], { stdio: 'ignore' })
  square = true
}

const ffmpeg = (args) => execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' })

try {
  const master = join(work, 'master.png')
  // Anti-aliased circular mask: alpha falls from 255 to 0 across one pixel at the edge.
  const mask = square ? '' : ",geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*clip(512-hypot(X-511.5,Y-511.5),0,1)'"
  ffmpeg(['-i', source, '-vf', `scale=1024:1024:flags=lanczos,format=rgba${mask}`, master])

  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const pngs = sizes.map((size) => {
    const out = join(work, `${size}.png`)
    ffmpeg(['-i', master, '-vf', `scale=${size}:${size}:flags=lanczos`, out])
    return readFileSync(out)
  })

  // ICO with PNG-compressed entries (supported since Windows Vista).
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(sizes.length, 4)
  const entries = Buffer.alloc(16 * sizes.length)
  let offset = 6 + entries.length
  sizes.forEach((size, i) => {
    const e = i * 16
    entries.writeUInt8(size >= 256 ? 0 : size, e)
    entries.writeUInt8(size >= 256 ? 0 : size, e + 1)
    entries.writeUInt8(0, e + 2)
    entries.writeUInt8(0, e + 3)
    entries.writeUInt16LE(1, e + 4)
    entries.writeUInt16LE(32, e + 6)
    entries.writeUInt32LE(pngs[i].length, e + 8)
    entries.writeUInt32LE(offset, e + 12)
    offset += pngs[i].length
  })
  writeFileSync(join(root, 'resources', 'icon.ico'), Buffer.concat([header, entries, ...pngs]))

  ffmpeg(['-i', master, '-vf', 'scale=512:512:flags=lanczos', join(root, 'resources', 'icon.png')])
  mkdirSync(join(root, 'src', 'renderer', 'src', 'assets'), { recursive: true })
  ffmpeg(['-i', master, '-vf', 'scale=128:128:flags=lanczos', join(root, 'src', 'renderer', 'src', 'assets', 'logo.png')])
  console.log('Icons written: resources/icon.ico, resources/icon.png, src/renderer/src/assets/logo.png')
} finally {
  rmSync(work, { recursive: true, force: true })
}

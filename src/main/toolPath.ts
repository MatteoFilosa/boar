import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/**
 * Apps started from the Finder or a desktop launcher get a minimal PATH,
 * without the folders where package managers put FFmpeg and yt-dlp.
 */
export function extendToolPath(): void {
  if (process.platform === 'win32') return
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', '/usr/bin', '/bin', '/snap/bin', join(homedir(), '.local', 'bin')]
  const current = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  process.env.PATH = [...current, ...extra.filter((dir) => !current.includes(dir))].join(delimiter)
}

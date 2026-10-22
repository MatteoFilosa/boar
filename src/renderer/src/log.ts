import { bridge } from './platform'

// Problem log: what the editor did and what went wrong, written by the main
// process (src/main/log.ts) for Help › Problem Log. Nothing is sent anywhere.

export type LogLevel = 'info' | 'warn' | 'error'

/** One line in the problem log (the browser console when the UI runs without the desktop app). */
export function logLine(level: LogLevel, message: string): void {
  if (bridge) bridge.log(level, message)
  else if (level === 'info') console.info(`[boar] ${message}`)
  else console.warn(`[boar] ${message}`)
}

/** An error with its stack, for the log. */
export const describeError = (err: unknown): string =>
  err instanceof Error ? (err.stack && err.stack.includes(err.message) ? err.stack : `${err.message}\n${err.stack ?? ''}`.trim()) : String(err)

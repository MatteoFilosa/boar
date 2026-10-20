import { app } from 'electron'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// File › Open Recent: the projects the user opened or saved last, newest
// first, in userData/recent.json. Only paths on this list can be reopened
// without the open dialog.

const MAX = 10

let list: string[] | null = null
let enabled = true

const file = (): string => join(app.getPath('userData'), 'recent.json')

/** Windows and macOS file systems ignore case. */
const same = (a: string, b: string): boolean => (process.platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase())

async function load(): Promise<string[]> {
  if (list) return list
  try {
    const data: unknown = JSON.parse(await readFile(file(), 'utf8'))
    list = Array.isArray(data) ? data.filter((p): p is string => typeof p === 'string').slice(0, MAX) : []
  } catch {
    list = []
  }
  return list
}

async function save(paths: string[]): Promise<void> {
  list = paths
  await writeFile(file(), JSON.stringify(paths, null, 2), 'utf8').catch(() => undefined)
}

/** Smoke runs keep nothing. */
export function keepRecentProjects(keep: boolean): void {
  enabled = keep
}

/** Puts a project the user opened or saved at the top of the list (and in the system's recent documents). */
export async function addRecentProject(path: string): Promise<void> {
  if (!enabled) return
  const full = resolve(path)
  const paths = await load()
  await save([full, ...paths.filter((p) => !same(p, full))].slice(0, MAX))
  if (process.platform !== 'linux') app.addRecentDocument(full)
}

export async function recentProjects(): Promise<{ path: string; missing: boolean }[]> {
  return (await load()).map((path) => ({ path, missing: !existsSync(path) }))
}

/** The path as stored, when it is on the list. */
export async function findRecentProject(path: string): Promise<string | null> {
  return (await load()).find((p) => same(p, path)) ?? null
}

export async function clearRecentProjects(): Promise<void> {
  await save([])
  if (process.platform !== 'linux') app.clearRecentDocuments()
}

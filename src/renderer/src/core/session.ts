import { create } from 'zustand'
import { setStatus, updateMedia } from './actions'
import { parseProject, serializeProject } from './projectFile'
import { adoptRecoveredCopy } from './autosave'
import { emptyProject, hasUnsavedChanges, mediaKey, useEditor } from './store'
import type { MediaItem } from './types'
import { dropMediaCache } from '../media/cache'
import { track } from '../media/importer'
import { canRead } from '../media/source'
import { bridge, mediaPathUrl } from '../platform'
import { getEngine } from '../engine/preview'

const get = useEditor.getState
const set = useEditor.setState

export const isDirty = (): boolean => hasUnsavedChanges(get())

export function projectName(path: string | null): string {
  if (!path) return 'Untitled'
  return (path.split(/[\\/]/).pop() ?? path).replace(/\.boar$/i, '')
}

/** Saves the project (Ctrl+S). In the browser the .boar file is downloaded instead. */
export async function saveProject(saveAs = false): Promise<boolean> {
  const { project, media, projectPath, transcripts, shorts } = get()
  const json = serializeProject(project, media, transcripts, shorts)
  if (bridge) {
    try {
      const path = await bridge.saveProject(json, projectPath, saveAs)
      if (!path) return false
      set({ projectPath: path, savedProject: project, savedTranscripts: transcripts, savedShorts: shorts, savedMediaKey: mediaKey(media) })
      setStatus(`Saved ${path}`)
      void refreshRecentProjects()
      return true
    } catch (err) {
      setStatus(`Save failed: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }
  const name = `${projectName(projectPath)}.boar`
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  set({ projectPath: name, savedProject: project, savedTranscripts: transcripts, savedShorts: shorts, savedMediaKey: mediaKey(media) })
  setStatus(`Downloaded ${name} (only the desktop app keeps media paths)`)
  return true
}

function pickProjectInBrowser(): Promise<{ path: string; json: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.boar,application/json'
    input.onchange = async () => {
      const file = input.files?.[0]
      resolve(file ? { path: file.name, json: await file.text() } : null)
    }
    input.click()
  })
}

/** Opens a .boar project (Ctrl+O) and reconnects its media files. */
export async function openProject(): Promise<void> {
  if (get().playing) return
  if (isDirty() && !window.confirm('The project has unsaved changes. Discard them?')) return
  const opened = bridge ? await bridge.openProject() : await pickProjectInBrowser()
  if (opened) loadProject(opened)
}

/** A project file dropped on the window. */
export async function openDroppedProject(file: File): Promise<void> {
  const path = bridge?.pathForFile(file)
  getEngine().pause()
  if (isDirty() && !window.confirm(`The project has unsaved changes. Discard them and open ${file.name}?`)) return
  try {
    loadProject(bridge && path ? await bridge.openDroppedProject(path) : { path: file.name, json: await file.text() })
  } catch (err) {
    setStatus(`Cannot open ${file.name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// File › Open Recent (the main process keeps the list)

export interface RecentProject {
  path: string
  /** Shown in the menu: the file name, with its folder when two have the same name. */
  label: string
  missing: boolean
}

export const useRecentProjects = create<{ list: RecentProject[] }>()(() => ({ list: [] }))

export async function refreshRecentProjects(): Promise<void> {
  if (!bridge) return
  const entries = await bridge.recentProjects().catch(() => [])
  const names = entries.map((e) => projectName(e.path))
  const folder = (path: string): string => path.split(/[\\/]/).slice(-2, -1)[0] ?? ''
  useRecentProjects.setState({
    list: entries.map((e, i) => ({
      path: e.path,
      label: names.indexOf(names[i]) !== names.lastIndexOf(names[i]) ? `${names[i]} (${folder(e.path)})` : names[i],
      missing: e.missing
    }))
  })
}

export async function openRecentProject(path: string): Promise<void> {
  if (!bridge || get().playing) return
  if (isDirty() && !window.confirm(`The project has unsaved changes. Discard them and open ${projectName(path)}?`)) return
  try {
    loadProject(await bridge.openRecentProject(path))
  } catch (err) {
    setStatus(`Cannot open ${path}: ${err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err)}`)
    void refreshRecentProjects()
  }
}

export async function clearRecentProjects(): Promise<void> {
  await bridge?.clearRecentProjects()
  await refreshRecentProjects()
}

let recovery: Promise<void> | null = null

/** Offers back the project a crash left unsaved (the main process asks); once per page. */
export function recoverAutosave(): Promise<void> {
  if (!bridge) return Promise.resolve()
  recovery ??= bridge
    .recoverAutosave()
    .then((copy) => {
      if (!copy) return
      adoptRecoveredCopy()
      loadProject(copy, copy.savedAt)
    })
    .catch((err: unknown) => setStatus(`Cannot recover the project: ${err instanceof Error ? err.message : String(err)}`))
  return recovery
}

let launchStarted = false

/** Opens the project Boar was started with, and the ones the file manager sends later. */
export function startLaunchProjects(): void {
  if (!bridge || launchStarted) return
  launchStarted = true
  void refreshRecentProjects()
  const take = async (): Promise<void> => {
    const opened = await bridge!.takeLaunchProject().catch((err: unknown) => {
      setStatus(`Cannot open the project: ${err instanceof Error ? err.message : String(err)}`)
      return null
    })
    if (!opened) return
    getEngine().pause()
    if (isDirty() && !window.confirm(`The project has unsaved changes. Discard them and open ${projectName(opened.path)}?`)) return
    loadProject(opened)
  }
  bridge.onLaunchProject(() => void take())
  void take()
}

/** Shows a project file; `recoveredAt` marks an autosaved copy, which opens with unsaved changes. */
function loadProject(opened: { path: string | null; json: string }, recoveredAt?: number): void {
  let parsed: ReturnType<typeof parseProject>
  try {
    parsed = parseProject(opened.json)
  } catch (err) {
    setStatus(`Cannot open ${opened.path ?? 'the project'}: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  for (const m of get().media) {
    if (m.url.startsWith('blob:')) URL.revokeObjectURL(m.url)
    dropMediaCache(m.id)
  }
  const media: MediaItem[] = parsed.media.map((saved) => ({
    id: saved.id,
    name: saved.name,
    kind: saved.kind,
    file: null,
    url: saved.path && bridge ? mediaPathUrl(saved.path) : '',
    path: saved.path,
    size: saved.size,
    status: 'analyzing',
    error: '',
    duration: 0,
    hasVideo: saved.kind !== 'audio',
    hasAudio: false,
    width: 0,
    height: 0,
    fps: 0,
    videoCodec: '',
    audioCodec: '',
    sampleRate: 0,
    channels: 0,
    poster: '',
    reverseOf: saved.reverseOf
  }))
  const recovered = recoveredAt !== undefined
  set({
    project: parsed.project,
    // A recovered copy differs from its file (or has none): it opens as unsaved.
    savedProject: recovered ? emptyProject() : parsed.project,
    past: [],
    future: [],
    media,
    selection: [],
    selectedTrackId: null,
    timeSelection: null,
    cursor: 0,
    dialog: null,
    projectPath: opened.path,
    transcripts: parsed.transcripts,
    savedTranscripts: parsed.transcripts,
    shorts: parsed.shorts,
    savedShorts: parsed.shorts,
    savedMediaKey: mediaKey(media),
    longVideo: null
  })
  setStatus(
    recovered
      ? `Recovered ${projectName(opened.path)} as autosaved on ${new Date(recoveredAt).toLocaleString()}: save it to keep it`
      : `Opened ${opened.path}`
  )
  if (!recovered) void refreshRecentProjects()
  for (const m of media) {
    if (!canRead(m)) {
      updateMedia(m.id, { status: 'error', error: 'file not available — import it again to relink' })
      continue
    }
    void track(m)
  }
}

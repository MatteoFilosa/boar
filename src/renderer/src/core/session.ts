import { setStatus, updateMedia } from './actions'
import { parseProject, serializeProject } from './projectFile'
import { useEditor } from './store'
import type { MediaItem } from './types'
import { dropMediaCache } from '../media/cache'
import { track } from '../media/importer'
import { canRead } from '../media/source'
import { bridge, mediaPathUrl } from '../platform'

const get = useEditor.getState
const set = useEditor.setState

export const isDirty = (): boolean => {
  const s = get()
  return s.project !== s.savedProject || s.transcripts !== s.savedTranscripts || s.shorts !== s.savedShorts
}

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
      set({ projectPath: path, savedProject: project, savedTranscripts: transcripts, savedShorts: shorts })
      setStatus(`Saved ${path}`)
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
  set({ projectPath: name, savedProject: project, savedTranscripts: transcripts, savedShorts: shorts })
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
  if (!opened) return
  let parsed: ReturnType<typeof parseProject>
  try {
    parsed = parseProject(opened.json)
  } catch (err) {
    setStatus(`Cannot open ${opened.path}: ${err instanceof Error ? err.message : String(err)}`)
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
    poster: ''
  }))
  set({
    project: parsed.project,
    savedProject: parsed.project,
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
    longVideo: null
  })
  setStatus(`Opened ${opened.path}`)
  for (const m of media) {
    if (!canRead(m)) {
      updateMedia(m.id, { status: 'error', error: 'file not available — import it again to relink' })
      continue
    }
    void track(m)
  }
}

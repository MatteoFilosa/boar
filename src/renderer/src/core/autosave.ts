import { serializeProject } from './projectFile'
import { hasUnsavedChanges, useEditor } from './store'
import { bridge } from '../platform'

// Crash recovery: while there are unsaved changes, a copy of the project goes
// to the main process (src/main/autosave.ts) a few seconds after editing
// stops, and at least once a minute while it goes on. Saving, or undoing back
// to the saved state, deletes it. Recovery at startup is in core/session.ts.

/** Quiet time after the last change before the copy is written. */
const QUIET_MS = 5_000
/** Longest wait for a copy while changes keep coming. */
const MAX_WAIT_MS = 60_000
/** During playback the copy waits (serializing can drop a frame), but not longer than this. */
const PLAYING_MAX_WAIT_MS = 180_000

let started = false
let timer = 0
/** When the oldest change not in the copy was made (0: the copy is current). */
let pendingSince = 0
/** A copy exists in the main process. */
let written = false
/** Bridge calls in order, so a clear never overtakes a write. */
let queue: Promise<unknown> = Promise.resolve()

const enqueue = (task: () => Promise<unknown>): Promise<unknown> => (queue = queue.then(task).catch(() => undefined))

/** The recovered copy became this page's own (src/main/autosave.ts): saving deletes it. */
export function adoptRecoveredCopy(): void {
  written = true
}

export function startAutosave(): void {
  if (!bridge || started) return
  started = true
  useEditor.subscribe((s, p) => {
    if (
      s.project === p.project &&
      s.savedProject === p.savedProject &&
      s.transcripts === p.transcripts &&
      s.savedTranscripts === p.savedTranscripts &&
      s.shorts === p.shorts &&
      s.savedShorts === p.savedShorts &&
      s.media === p.media &&
      s.savedMediaKey === p.savedMediaKey &&
      s.projectPath === p.projectPath
    ) {
      return
    }
    changed()
  })
}

function changed(): void {
  window.clearTimeout(timer)
  timer = 0
  if (!hasUnsavedChanges(useEditor.getState())) {
    pendingSince = 0
    if (written) {
      written = false
      void enqueue(() => bridge!.clearAutosave())
    }
    return
  }
  const now = Date.now()
  if (!pendingSince) pendingSince = now
  timer = window.setTimeout(write, Math.max(0, Math.min(QUIET_MS, pendingSince + MAX_WAIT_MS - now)))
}

function write(): void {
  timer = 0
  const s = useEditor.getState()
  if (!hasUnsavedChanges(s)) return
  if (s.playing && Date.now() - pendingSince < PLAYING_MAX_WAIT_MS) {
    timer = window.setTimeout(write, QUIET_MS)
    return
  }
  pendingSince = 0
  const json = serializeProject(s.project, s.media, s.transcripts, s.shorts)
  written = true
  void enqueue(() => bridge!.writeAutosave(json, s.projectPath))
}

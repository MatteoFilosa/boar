import { openDialog, setStatus } from '../core/actions'
import { useEditor } from '../core/store'
import { bridge } from '../platform'

/**
 * Looks for a newer release. At startup (manual = false) only an available
 * update shows, and never over another window; Help › Check for Updates
 * always answers.
 */
export async function checkForUpdates(manual: boolean): Promise<void> {
  if (!bridge) {
    if (manual) setStatus('Updates are installed by the desktop app')
    return
  }
  try {
    const info = await bridge.checkUpdate()
    if (!manual && (!info?.available || useEditor.getState().dialog)) return
    openDialog({ kind: 'update', info })
  } catch (err) {
    if (manual) openDialog({ kind: 'update', info: null, error: err instanceof Error ? err.message : String(err) })
  }
}

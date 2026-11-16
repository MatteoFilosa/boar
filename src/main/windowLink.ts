import { BrowserWindow, clipboard, ipcMain, screen, type WebContents } from 'electron'

// Editor windows share copied events (Ctrl+C in one, Ctrl+V in another) and
// take drags from each other. A drag that leaves its window keeps reporting
// to the main process, which shows it to the editor window under the pointer
// and hands it over on release. The payload is the renderer's own data
// (events, media paths that window could already read): nothing new is
// allowed through the media protocol here.

/** Events copied last, in any window. */
let shared: unknown = null

interface OutsideDrag {
  from: WebContents
  item: unknown
  /** The window shown the drag, and whether it was given the item yet. */
  target: BrowserWindow | null
}

let drag: OutsideDrag | null = null

/**
 * `windows`: the editor windows, the one focused last first (when windows
 * overlap under the pointer, that is most likely the one on top).
 */
export function registerWindowLink(windows: () => BrowserWindow[]): void {
  ipcMain.handle('clipboard:share', (event, clip: unknown) => {
    shared = clip
    // An image copied earlier must not win over these events on the next Ctrl+V.
    clipboard.writeText('Boar events')
    for (const win of windows()) if (!win.isDestroyed() && win.webContents !== event.sender) win.webContents.send('clipboard:shared', clip)
  })
  ipcMain.handle('clipboard:shared', () => shared)

  /** The editor window under the pointer (not the one dragging) and the pointer in its page coordinates. */
  const windowAtPointer = (from: WebContents): { win: BrowserWindow; x: number; y: number } | null => {
    const p = screen.getCursorScreenPoint()
    for (const win of windows()) {
      if (win.isDestroyed() || win.webContents === from || !win.isVisible() || win.isMinimized()) continue
      const b = win.getContentBounds()
      if (p.x < b.x || p.y < b.y || p.x >= b.x + b.width || p.y >= b.y + b.height) continue
      const zoom = win.webContents.getZoomFactor() || 1
      return { win, x: (p.x - b.x) / zoom, y: (p.y - b.y) / zoom }
    }
    return null
  }
  const leave = (): void => {
    const target = drag?.target
    if (target && !target.isDestroyed()) target.webContents.send('drag:over', null)
    if (drag) drag.target = null
  }

  ipcMain.on('drag:outside', (event, item: unknown) => {
    if (item !== null) {
      leave()
      drag = { from: event.sender, item, target: null }
    }
    const current = drag
    if (current?.from !== event.sender) return
    const hit = windowAtPointer(event.sender)
    const entering = current.target !== (hit?.win ?? null)
    if (entering) leave()
    if (!hit) return
    current.target = hit.win
    hit.win.webContents.send('drag:over', { x: hit.x, y: hit.y, ...(entering ? { item: current.item } : {}) })
  })
  ipcMain.on('drag:end', (event) => {
    if (drag?.from !== event.sender) return
    leave()
    drag = null
  })
  ipcMain.handle('drag:drop', (event) => {
    const current = drag
    if (current?.from !== event.sender) return false
    const { item } = current
    const hit = windowAtPointer(event.sender)
    if (hit?.win !== current.target) leave()
    drag = null
    if (!hit) return false
    hit.win.webContents.send('drag:drop', { x: hit.x, y: hit.y, item })
    hit.win.focus()
    return true
  })
}

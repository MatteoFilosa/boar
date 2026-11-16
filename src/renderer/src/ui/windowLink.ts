import * as A from '../core/actions'
import type { EventClipboard } from '../core/clipboard'
import { useEditor } from '../core/store'
import { importPaths, track } from '../media/importer'
import { canRead } from '../media/source'
import { bridge, type WindowDragItem } from '../platform'
import { dropMedia, setOutsideDrag, useMediaDrag } from './mediaDrag'

// Editor windows share copied events and take drags from each other
// (src/main/windowLink.ts passes them on).

/**
 * Pastes copied events (`clip`: from a drag; default: the clipboard) and
 * analyzes the files they brought into Project Media.
 */
export function pasteEvents(place?: A.PastePlace, clip?: EventClipboard): string[] {
  const { ids, added } = A.pasteClipboard(place, clip)
  for (const m of added) {
    if (canRead(m)) void track(m)
    else A.updateMedia(m.id, { status: 'error', error: 'file not available — import it again to relink' })
  }
  return ids
}

// The window a drag starts in.

let outside = false

export const isOutside = (x: number, y: number): boolean => x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight

/**
 * Call at each pointer move of a drag other windows can take. True while the
 * pointer is outside this window: the drag is then shown to the editor window
 * under it, and the local drag should wait. `item` is asked for once, on the
 * way out (null: this drag stays in its window).
 */
export function followOutside(x: number, y: number, item: () => WindowDragItem | null): boolean {
  if (!bridge) return false
  if (!isOutside(x, y)) {
    if (outside) {
      outside = false
      bridge.endDragOutside()
    }
    return false
  }
  if (!outside) {
    const it = item()
    if (!it) return false
    outside = true
    bridge.dragOutside(it)
    A.setStatus('Release over another Boar window to copy it there')
    return true
  }
  bridge.dragOutside(null)
  return true
}

/** The drag ended: true when it ended outside this window (handed to the window under the pointer, if any). */
export function finishOutside(cancelled: boolean): boolean {
  if (!outside) return false
  outside = false
  if (cancelled) bridge?.endDragOutside()
  else
    void bridge?.dropOutside().then((taken) => {
      A.setStatus(taken ? 'Copied to the other window' : 'Release over another Boar window to copy it there')
    })
  return true
}

// The window a drag arrives in.

let incoming: WindowDragItem | null = null

/** The drag from another window shown over this one (Timeline reads its events and length). */
export const incomingDrag = (): WindowDragItem | null => incoming

export const dragLabel = (item: WindowDragItem): string => {
  const n = item.clip?.events.length ?? 0
  return n ? `${n} event${n > 1 ? 's' : ''}` : ''
}

/** Dropped outside the timeline: events go to the cursor, files to Project Media. */
function dropElsewhere(item: WindowDragItem): void {
  if (item.id === 'clip' && item.clip) pasteEvents({}, item.clip)
  else if (item.id.startsWith('path:')) void importPaths([item.id.slice(5)])
  else A.setStatus('Drop it on the timeline')
}

/** Copied events and drags from the other editor windows (once, at start). */
export function linkWindows(): () => void {
  if (!bridge) return () => {}
  const b = bridge
  setOutsideDrag({ follow: followOutside, finish: finishOutside, item: mediaDragItem })
  void b.sharedEvents().then((clip) => {
    // Events copied here meanwhile are newer.
    if (clip && !A.clipboardContent()) A.receiveClipboard(clip)
  })
  const offShared = b.onSharedEvents(A.receiveClipboard)
  const offDrag = b.onWindowDrag((drag) => {
    if (drag?.item) incoming = drag.item
    if (!drag || !incoming) {
      incoming = null
      useMediaDrag.setState({ drag: null })
      return
    }
    useMediaDrag.setState({ drag: { mediaId: incoming.id, x: drag.x, y: drag.y, label: dragLabel(incoming) } })
  })
  const offDrop = b.onWindowDrop(({ x, y, item }) => {
    incoming = item
    useMediaDrag.setState({ drag: null })
    try {
      if (!dropMedia(item.id, x, y)) dropElsewhere(item)
    } finally {
      incoming = null
    }
  })
  return () => {
    offShared()
    offDrag()
    offDrop()
  }
}

/** What a Project Media or Explorer drag carries to another window (null: it cannot leave). */
export function mediaDragItem(mediaId: string): WindowDragItem | null {
  if (!mediaId.includes(':')) {
    // A file of this project: the other window imports it by path.
    const m = useEditor.getState().media.find((o) => o.id === mediaId)
    const path = m?.convertedFrom || m?.path
    if (!m || !path) return null
    return { id: `path:${path}`, length: m.kind === 'image' ? A.IMAGE_DEFAULT_LENGTH : m.duration }
  }
  const length = mediaId.startsWith('text:') ? A.TEXT_DEFAULT_LENGTH : mediaId.startsWith('shape:') ? A.SHAPE_DEFAULT_LENGTH : 0
  return { id: mediaId, length }
}

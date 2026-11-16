import { create } from 'zustand'
import type { WindowDragItem } from '../platform'

// Dragging media from Project Media onto the timeline. Uses pointer events
// rather than HTML5 drag and drop so the drop position can be previewed and
// the gesture behaves the same everywhere. Released over another editor
// window, the drag goes there (ui/windowLink.ts); drags from other windows
// show up here the same way.

export interface MediaDrag {
  mediaId: string
  x: number
  y: number
  /** Shown by the ghost instead of the media name (drags from another window). */
  label?: string
}

export const useMediaDrag = create<{ drag: MediaDrag | null }>()(() => ({ drag: null }))

type DropHandler = (mediaId: string, clientX: number, clientY: number) => boolean
const dropHandlers = new Set<DropHandler>()

export function registerMediaDrop(handler: DropHandler): () => void {
  dropHandlers.add(handler)
  return () => dropHandlers.delete(handler)
}

/** Drops on the first handler that takes it; false when none did. */
export function dropMedia(mediaId: string, clientX: number, clientY: number): boolean {
  for (const handler of dropHandlers) if (handler(mediaId, clientX, clientY)) return true
  return false
}

/** Links to the other windows, set by ui/windowLink.ts (kept apart so this module stays small). */
export interface OutsideDrag {
  follow(x: number, y: number, item: () => WindowDragItem | null): boolean
  finish(cancelled: boolean): boolean
  item(mediaId: string): WindowDragItem | null
}

let outsideDrag: OutsideDrag | null = null
export const setOutsideDrag = (link: OutsideDrag): void => {
  outsideDrag = link
}

export function startMediaDrag(mediaId: string, startX: number, startY: number): void {
  let active = false
  const move = (e: PointerEvent): void => {
    if (!active && Math.hypot(e.clientX - startX, e.clientY - startY) < 5) return
    active = true
    if (outsideDrag?.follow(e.clientX, e.clientY, () => outsideDrag?.item(mediaId) ?? null)) {
      useMediaDrag.setState({ drag: null })
      return
    }
    useMediaDrag.setState({ drag: { mediaId, x: e.clientX, y: e.clientY } })
  }
  const stop = (): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', finish)
    window.removeEventListener('pointercancel', cancel)
    useMediaDrag.setState({ drag: null })
  }
  const finish = (e: PointerEvent): void => {
    stop()
    if (!active || outsideDrag?.finish(false)) return
    dropMedia(mediaId, e.clientX, e.clientY)
  }
  const cancel = (): void => {
    stop()
    outsideDrag?.finish(true)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', finish)
  window.addEventListener('pointercancel', cancel)
}

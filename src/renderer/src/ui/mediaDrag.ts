import { create } from 'zustand'

// Dragging media from Project Media onto the timeline. Uses pointer events
// rather than HTML5 drag and drop so the drop position can be previewed and
// the gesture behaves the same everywhere.

export interface MediaDrag {
  mediaId: string
  x: number
  y: number
}

export const useMediaDrag = create<{ drag: MediaDrag | null }>()(() => ({ drag: null }))

type DropHandler = (mediaId: string, clientX: number, clientY: number) => boolean
const dropHandlers = new Set<DropHandler>()

export function registerMediaDrop(handler: DropHandler): () => void {
  dropHandlers.add(handler)
  return () => dropHandlers.delete(handler)
}

export function startMediaDrag(mediaId: string, startX: number, startY: number): void {
  let active = false
  const move = (e: PointerEvent): void => {
    if (!active && Math.hypot(e.clientX - startX, e.clientY - startY) < 5) return
    active = true
    useMediaDrag.setState({ drag: { mediaId, x: e.clientX, y: e.clientY } })
  }
  const finish = (e: PointerEvent): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', finish)
    window.removeEventListener('pointercancel', cancel)
    useMediaDrag.setState({ drag: null })
    if (!active) return
    for (const handler of dropHandlers) if (handler(mediaId, e.clientX, e.clientY)) break
  }
  const cancel = (): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', finish)
    window.removeEventListener('pointercancel', cancel)
    useMediaDrag.setState({ drag: null })
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', finish)
  window.addEventListener('pointercancel', cancel)
}

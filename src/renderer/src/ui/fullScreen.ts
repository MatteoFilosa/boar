import { setStatus } from '../core/actions'

let host: HTMLElement | null = null

/** The element that goes full screen: the preview area (canvas and its controls). */
export function setFullScreenHost(element: HTMLElement | null): void {
  host = element
}

export function isPreviewFullScreen(): boolean {
  return host !== null && document.fullscreenElement === host
}

export function toggleFullScreenPreview(): void {
  if (document.fullscreenElement) {
    void document.exitFullscreen()
    return
  }
  if (!host) return
  // Keys must reach the shortcuts, not a text field left focused outside the preview.
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  host.requestFullscreen().catch(() => setStatus('Full screen preview is not available'))
}

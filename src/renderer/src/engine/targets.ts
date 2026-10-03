import { BufferTarget, StreamTarget, type StreamTargetChunk, type Target } from 'mediabunny'
import { bridge } from '../platform'

export interface ExportDestination {
  target: Target
  /** Where the file goes, for messages. */
  label: string
  /** Called after a successful render (browser fallback downloads here). */
  finish(): Promise<void>
  /** Removes a partial file after an error or cancel. */
  discard(): Promise<void>
  reveal?: () => void
}

interface SaveFilePickerWindow {
  showSaveFilePicker?: (options: {
    suggestedName: string
    types: { description: string; accept: Record<string, string[]> }[]
  }) => Promise<{ name: string; createWritable(): Promise<WritableStream<StreamTargetChunk>> }>
}

/** Asks where to save the render. Returns null if the user cancels. */
export async function chooseDestination(suggestedName: string): Promise<ExportDestination | null> {
  if (bridge) {
    const path = await bridge.pickExportPath(suggestedName)
    if (!path) return null
    const id = await bridge.openFile(path)
    let closed = false
    const close = async (): Promise<void> => {
      if (closed) return
      closed = true
      await bridge!.closeFile(id)
    }
    const writable = new WritableStream<StreamTargetChunk>({
      write: (chunk) => bridge!.writeFile(id, chunk.position, chunk.data),
      close,
      abort: close
    })
    return {
      target: new StreamTarget(writable, { chunked: true }),
      label: path,
      finish: close,
      discard: async () => {
        await close()
        await bridge!.discardFile(path)
      },
      reveal: () => void bridge!.revealFile(path)
    }
  }

  const picker = (window as unknown as SaveFilePickerWindow).showSaveFilePicker
  if (picker) {
    try {
      const handle = await picker({
        suggestedName,
        types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }]
      })
      const writable = await handle.createWritable()
      return {
        target: new StreamTarget(writable, { chunked: true }),
        label: handle.name,
        finish: async () => undefined,
        discard: async () => undefined
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return null
      throw err
    }
  }

  // Last resort: render in memory, then download.
  const target = new BufferTarget()
  return {
    target,
    label: suggestedName,
    finish: async () => {
      if (!target.buffer) return
      const url = URL.createObjectURL(new Blob([target.buffer], { type: 'video/mp4' }))
      const a = document.createElement('a')
      a.href = url
      a.download = suggestedName
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    },
    discard: async () => undefined
  }
}

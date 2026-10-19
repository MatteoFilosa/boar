import { BufferTarget, StreamTarget, type StreamTargetChunk, type Target } from 'mediabunny'
import { bridge } from '../platform'

export interface ExportDestination {
  target: Target
  /** Writes a whole file made without Mediabunny (GIF); use instead of `target`. */
  writeAll(data: Uint8Array<ArrayBuffer>): Promise<void>
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

/** What is being saved, for the save dialog's file type. */
export interface FileType {
  description: string
  mimeType: string
  extension: string
}

export const MP4_FILE: FileType = { description: 'MP4 video', mimeType: 'video/mp4', extension: 'mp4' }

/** Asks where to save the render. Returns null if the user cancels. */
export async function chooseDestination(suggestedName: string, type: FileType = MP4_FILE): Promise<ExportDestination | null> {
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
      writeAll: (data) => bridge!.writeFile(id, 0, data),
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
        types: [{ description: type.description, accept: { [type.mimeType]: [`.${type.extension}`] } }]
      })
      const writable = await handle.createWritable()
      return {
        target: new StreamTarget(writable, { chunked: true }),
        writeAll: async (data) => {
          const writer = writable.getWriter()
          await writer.write({ type: 'write', data, position: 0 })
          await writer.close()
        },
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
  let whole: Uint8Array<ArrayBuffer> | null = null
  return {
    target,
    writeAll: async (data) => {
      whole = data
    },
    label: suggestedName,
    finish: async () => {
      const data = whole ?? target.buffer
      if (!data) return
      const url = URL.createObjectURL(new Blob([data], { type: type.mimeType }))
      const a = document.createElement('a')
      a.href = url
      a.download = suggestedName
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    },
    discard: async () => undefined
  }
}

const RENDER_EXTENSIONS = ['mp4', 'gif', 'mp3', 'wav', 'flac', 'm4a', 'ogg']

/** `name` with the extension of the chosen format, replacing a render extension it already has. */
export function withExtension(name: string, extension: string): string {
  const trimmed = name.trim() || 'Boar render'
  const match = /\.([a-z0-9]+)$/i.exec(trimmed)
  const base = match && RENDER_EXTENSIONS.includes(match[1].toLowerCase()) ? trimmed.slice(0, -match[0].length) : trimmed
  return `${base || 'Boar render'}.${extension}`
}

import { BufferTarget, StreamTarget, type StreamTargetChunk, type Target } from 'mediabunny'
import { bridge } from '../platform'

export interface ExportDestination {
  /** Where Mediabunny writes; a new one after restart(). */
  target: Target
  /** Writes a whole file made without Mediabunny (GIF); use instead of `target`. */
  writeAll(data: Uint8Array<ArrayBuffer>): Promise<void>
  /** Where the file goes, for messages. */
  label: string
  /** Called after a successful render (browser fallback downloads here). */
  finish(): Promise<void>
  /** Removes a partial file after an error or cancel. */
  discard(): Promise<void>
  /** Starts the file over with a new `target` (rendering again after a stall). */
  restart(): Promise<void>
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
    // Opening the file again empties it: a restart writes it from the start.
    const open = async (): Promise<{ id: number; target: Target; close: () => Promise<void> }> => {
      const id = await bridge!.openFile(path)
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
      return { id, target: new StreamTarget(writable, { chunked: true }), close }
    }
    let file = await open()
    const destination: ExportDestination = {
      target: file.target,
      writeAll: (data) => bridge!.writeFile(file.id, 0, data),
      label: path,
      finish: () => file.close(),
      discard: async () => {
        await file.close()
        await bridge!.discardFile(path)
      },
      restart: async () => {
        await file.close()
        file = await open()
        destination.target = file.target
      },
      reveal: () => void bridge!.revealFile(path)
    }
    return destination
  }

  const picker = (window as unknown as SaveFilePickerWindow).showSaveFilePicker
  if (picker) {
    try {
      const handle = await picker({
        suggestedName,
        types: [{ description: type.description, accept: { [type.mimeType]: [`.${type.extension}`] } }]
      })
      let writable = await handle.createWritable()
      const destination: ExportDestination = {
        target: new StreamTarget(writable, { chunked: true }),
        writeAll: async (data) => {
          const writer = writable.getWriter()
          await writer.write({ type: 'write', data, position: 0 })
          await writer.close()
        },
        label: handle.name,
        finish: async () => undefined,
        discard: async () => undefined,
        restart: async () => {
          await writable.abort().catch(() => undefined)
          writable = await handle.createWritable()
          destination.target = new StreamTarget(writable, { chunked: true })
        }
      }
      return destination
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return null
      throw err
    }
  }

  // Last resort: render in memory, then download.
  let target = new BufferTarget()
  let whole: Uint8Array<ArrayBuffer> | null = null
  const destination: ExportDestination = {
    target,
    writeAll: async (data) => {
      whole = data
    },
    label: suggestedName,
    restart: async () => {
      target = new BufferTarget()
      destination.target = target
    },
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
  return destination
}

const RENDER_EXTENSIONS = ['mp4', 'gif', 'mp3', 'wav', 'flac', 'm4a', 'ogg']

/** `name` with the extension of the chosen format, replacing a render extension it already has. */
export function withExtension(name: string, extension: string): string {
  const trimmed = name.trim() || 'Boar render'
  const match = /\.([a-z0-9]+)$/i.exec(trimmed)
  const base = match && RENDER_EXTENSIONS.includes(match[1].toLowerCase()) ? trimmed.slice(0, -match[0].length) : trimmed
  return `${base || 'Boar render'}.${extension}`
}

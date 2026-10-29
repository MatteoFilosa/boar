import { setStatus, updateMedia } from '../core/actions'
import { mediaById, useEditor } from '../core/store'
import { logLine } from '../log'
import { bridge, mediaPathUrl } from '../platform'
import { takeTurns } from './turns'
import type { ConvertReply, ConvertRequest } from './convert.worker'
import ConvertWorker from './convert.worker?worker&inline'

// Camcorder files that Chromium cannot read (MPEG-1/2 program streams: .mpg,
// .mod, .vob from cameras that record standard definition on DVDs, hard disks
// and memory cards) get an editable copy on import, made by convert.worker.ts
// and kept in the app's folder (or in memory in the browser). The copy takes
// the original's place for everything (preview, renders, analysis); the
// project keeps the original's path to make it again when the copy is gone.

/** Two files at a time: each one keeps a processor core and the encoder busy. */
const turns = takeTurns(2)
/** Stops a conversion in progress, by media id. */
const running = new Map<string, () => void>()

class Cancelled extends Error {
  constructor() {
    super('cancelled')
  }
}

useEditor.subscribe((s, prev) => {
  // Media removed from the project: stop converting it.
  if (s.media === prev.media || running.size === 0) return
  for (const [id, cancel] of running) if (!mediaById(id)) cancel()
})

/**
 * Makes (or finds) the editable copy of a camcorder file and points the media
 * item at it. Resolves when the item can be analyzed like any other video,
 * with why its sound was left out when it was.
 */
export function convertCameraFile(mediaId: string): Promise<string | null> {
  updateMedia(mediaId, { convertProgress: 0 })
  return turns(() => convert(mediaId))
}

async function convert(mediaId: string): Promise<string | null> {
  const media = mediaById(mediaId)
  if (!media) throw new Cancelled()
  const source = media.convertedFrom || media.path
  if (bridge && source) {
    const existing = await bridge.findConverted(source).catch(() => null)
    if (existing) {
      updateMedia(mediaId, { path: existing, url: mediaPathUrl(existing), file: null, convertedFrom: source, convertProgress: undefined })
      return null
    }
  }
  setStatus(`Converting ${media.name} for editing (camcorder video)…`)
  const fileId = bridge && source ? await bridge.createConverted(source) : null
  const parts: { position: number; data: Uint8Array }[] = []
  const worker = new ConvertWorker()
  const started = performance.now()
  try {
    const summary = await new Promise<string>((resolve, reject) => {
      running.set(mediaId, () => {
        worker.terminate()
        reject(new Cancelled())
      })
      const request = (message: ConvertRequest): void => worker.postMessage(message)
      worker.onmessage = (event: MessageEvent<ConvertReply>) => {
        const m = event.data
        if (m.type === 'write') {
          const done = fileId !== null && bridge ? bridge.writeProxy(fileId, m.position, m.data) : Promise.resolve(void parts.push({ position: m.position, data: m.data }))
          done.then(() => request({ type: 'written', id: m.id }), reject)
        } else if (m.type === 'progress') {
          if (mediaById(mediaId)) updateMedia(mediaId, { convertProgress: m.value })
        } else if (m.type === 'done') resolve(m.summary)
        else if (m.type === 'failed') reject(new Error(m.error))
      }
      worker.onerror = (event) => reject(new Error(event.message || 'the converter stopped'))
      request({ type: 'start', file: media.file, url: media.file ? '' : media.url })
    })
    logLine('info', `Converted ${media.name} in ${((performance.now() - started) / 1000).toFixed(1)} s: ${summary}`)
    if (!mediaById(mediaId)) throw new Cancelled()
    if (fileId !== null && bridge) {
      const path = await bridge.finishProxy(fileId)
      updateMedia(mediaId, { path, url: mediaPathUrl(path), file: null, convertedFrom: source, convertProgress: undefined })
    } else {
      // In the browser the copy stays in memory.
      const size = parts.reduce((end, p) => Math.max(end, p.position + p.data.length), 0)
      const bytes = new Uint8Array(size)
      for (const p of parts) bytes.set(p.data, p.position)
      const name = `${media.name.replace(/\.[^.]*$/, '')}.mp4`
      const file = new File([bytes], name, { type: 'video/mp4' })
      if (media.url.startsWith('blob:')) URL.revokeObjectURL(media.url)
      updateMedia(mediaId, { file, url: URL.createObjectURL(file), convertedFrom: media.name, convertProgress: undefined })
    }
    return /no sound: ([^,]*)/.exec(summary)?.[1] ?? null
  } catch (err) {
    if (fileId !== null && bridge) await bridge.abortProxy(fileId).catch(() => undefined)
    if (mediaById(mediaId)) updateMedia(mediaId, { convertProgress: undefined })
    throw err
  } finally {
    worker.terminate()
    running.delete(mediaId)
  }
}

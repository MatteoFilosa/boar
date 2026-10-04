import {
  ALL_FORMATS,
  Conversion,
  EncodedPacketSink,
  Input,
  type InputVideoTrack,
  Mp4OutputFormat,
  Output,
  QUALITY_MEDIUM,
  StreamTarget,
  type StreamTargetChunk
} from 'mediabunny'
import { setStatus, updateMedia } from '../core/actions'
import { mediaById, useEditor } from '../core/store'
import type { MediaItem } from '../core/types'
import { bridge, mediaPathUrl } from '../platform'
import { inputSource } from './source'

// Proxies: a video that is slow to seek (keyframes seconds apart, as screen
// recordings have, or a picture bigger than 1440p) gets a light copy, 960 px
// wide with a keyframe every half second, that only the preview reads, so
// scrubbing and frame stepping stay instant. Renders always read the original.

const PROXY_WIDTH = 960
const KEYFRAME_INTERVAL = 0.5
/** Keyframes further apart than this (seconds) make every seek decode many frames. */
const SLOW_KEY_INTERVAL = 1.5

/** True when seeking the video decodes many frames: rare keyframes or a big picture. */
export async function isSlowToSeek(video: InputVideoTrack): Promise<boolean> {
  if (video.displayWidth * video.displayHeight > 2560 * 1440) return true
  const sink = new EncodedPacketSink(video)
  const first = await sink.getFirstPacket({ metadataOnly: true })
  if (!first) return false
  let key = first
  let count = 0
  while (count < 6) {
    const next = await sink.getNextKeyPacket(key, { metadataOnly: true })
    if (!next) break
    key = next
    count++
  }
  if (count === 0) return (await video.computeDuration()) - first.timestamp > SLOW_KEY_INTERVAL
  return (key.timestamp - first.timestamp) / count > SLOW_KEY_INTERVAL
}

/** What the preview plays: the proxy when there is one and proxies are on. */
export function previewUrl(media: MediaItem): string {
  return media.proxyUrl && useEditor.getState().options.proxies ? media.proxyUrl : media.url
}

interface ProxyJob {
  mediaId: string
  conversion: Conversion | null
  cancelled: boolean
}

const queue: string[] = []
let running: ProxyJob | null = null

/** After import: uses an existing proxy, or queues one when the video is slow to seek. */
export async function setUpProxy(media: MediaItem, slow: boolean): Promise<void> {
  if (!bridge || !media.path || media.kind !== 'video') return
  if (slow) updateMedia(media.id, { slowSeek: true })
  const existing = await bridge.findProxy(media.path).catch(() => null)
  if (existing) {
    updateMedia(media.id, { proxyUrl: mediaPathUrl(existing) })
    return
  }
  if (slow && useEditor.getState().options.proxies) createProxy(media.id)
}

/** Queues a proxy for a video (one is made at a time). */
export function createProxy(mediaId: string): void {
  const media = mediaById(mediaId)
  if (!bridge || !media?.path || media.kind !== 'video' || media.proxyUrl) return
  if (queue.includes(mediaId) || running?.mediaId === mediaId) return
  queue.push(mediaId)
  updateMedia(mediaId, { proxyProgress: 0 })
  void runQueue()
}

export async function deleteProxy(mediaId: string): Promise<void> {
  const media = mediaById(mediaId)
  if (!bridge || !media?.path) return
  cancelProxy(mediaId)
  updateMedia(mediaId, { proxyUrl: undefined })
  await bridge.deleteProxy(media.path)
  setStatus(`Deleted the proxy of ${media.name}`)
}

export function cancelProxy(mediaId: string): void {
  const i = queue.indexOf(mediaId)
  if (i >= 0) queue.splice(i, 1)
  if (running?.mediaId === mediaId) {
    running.cancelled = true
    void running.conversion?.cancel()
  }
  if (mediaById(mediaId)) updateMedia(mediaId, { proxyProgress: undefined })
}

useEditor.subscribe((s, prev) => {
  // Media removed from the project: stop working on its proxy.
  if (s.media !== prev.media) {
    const ids = new Set(s.media.map((m) => m.id))
    for (const id of [...queue, running?.mediaId ?? '']) if (id && !ids.has(id)) cancelProxy(id)
  }
  // Proxies turned on: make the missing ones; turned off: stop making them.
  if (s.options.proxies !== prev.options.proxies) {
    for (const m of s.media) {
      if (s.options.proxies && m.slowSeek && !m.proxyUrl) createProxy(m.id)
      if (!s.options.proxies && m.proxyProgress !== undefined) cancelProxy(m.id)
    }
  }
})

async function runQueue(): Promise<void> {
  if (running || !bridge) return
  const mediaId = queue.shift()
  if (!mediaId) return
  const media = mediaById(mediaId)
  if (!media?.path) return void runQueue()
  const job: ProxyJob = { mediaId, conversion: null, cancelled: false }
  running = job
  let fileId: number | null = null
  const input = new Input({ formats: ALL_FORMATS, source: inputSource(media) })
  try {
    fileId = await bridge.createProxy(media.path)
    const id = fileId
    // The hardware encoder first (several times faster), any encoder otherwise.
    const init = (hardwareAcceleration: 'prefer-hardware' | 'no-preference'): Promise<Conversion> => {
      const writable = new WritableStream<StreamTargetChunk>({ write: (chunk) => bridge!.writeProxy(id, chunk.position, chunk.data) })
      const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new StreamTarget(writable, { chunked: true }) })
      return Conversion.init({
        input,
        output,
        video: {
          width: Math.min(PROXY_WIDTH, media.width || PROXY_WIDTH),
          codec: 'avc',
          quality: QUALITY_MEDIUM,
          keyFrameInterval: KEYFRAME_INTERVAL,
          forceTranscode: true,
          hardwareAcceleration
        },
        audio: { discard: true },
        showWarnings: false
      })
    }
    let conversion = await init('prefer-hardware')
    if (!conversion.isValid) conversion = await init('no-preference')
    if (!conversion.isValid) throw new Error('this video cannot be encoded here')
    job.conversion = conversion
    if (job.cancelled) throw new Error('cancelled')
    let shown = 0
    conversion.onProgress = (p) => {
      // A few updates per percent are enough for the media panel.
      if (p - shown < 0.01 && p < 1) return
      shown = p
      updateMedia(mediaId, { proxyProgress: p })
    }
    setStatus(`Making a proxy of ${media.name} for smooth scrubbing…`)
    await conversion.execute()
    const path = await bridge.finishProxy(id)
    fileId = null
    if (mediaById(mediaId)) {
      updateMedia(mediaId, { proxyUrl: mediaPathUrl(path), proxyProgress: undefined })
      setStatus(`Proxy of ${media.name} ready: the preview now scrubs smoothly`)
    }
  } catch (err) {
    if (fileId !== null) await bridge.abortProxy(fileId).catch(() => undefined)
    if (mediaById(mediaId)) updateMedia(mediaId, { proxyProgress: undefined })
    if (!job.cancelled) setStatus(`No proxy for ${media.name}: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    input.dispose()
    running = null
    void runQueue()
  }
}

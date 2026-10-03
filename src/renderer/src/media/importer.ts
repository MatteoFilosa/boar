import {
  ALL_FORMATS,
  AudioBufferSink,
  CanvasSink,
  Input,
  type InputAudioTrack,
  type InputVideoTrack
} from 'mediabunny'
import { addMediaItem, setStatus, updateMedia } from '../core/actions'
import { mediaById, useEditor } from '../core/store'
import { canRead, inputSource } from './source'
import { uid } from '../core/ids'
import { secondsToFlicks } from '../core/time'
import type { MediaItem, MediaKind } from '../core/types'
import { bridge, mediaPathUrl } from '../platform'
import { imageCache, notifyMediaCache, peakCache, thumbCache, type Peaks, type ThumbStrip } from './cache'

const VIDEO_EXT = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'mts', 'm2ts', 'ts', 'wmv', 'mpg', 'mpeg', '3gp']
const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'wma', 'aif', 'aiff']
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'avif']

export const ACCEPT = [...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT].map((e) => `.${e}`).join(',')

function classify(file: File): MediaKind | null {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (file.type.startsWith('image/') || IMAGE_EXT.includes(ext)) return 'image'
  if (file.type.startsWith('video/') || VIDEO_EXT.includes(ext)) return 'video'
  if (file.type.startsWith('audio/') || AUDIO_EXT.includes(ext)) return 'audio'
  return null
}

/** Media kind from a file name (files referenced by path). */
export function kindOfName(name: string): MediaKind | null {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (IMAGE_EXT.includes(ext)) return 'image'
  if (VIDEO_EXT.includes(ext)) return 'video'
  if (AUDIO_EXT.includes(ext)) return 'audio'
  return null
}

/** Resolves when a media item finished analyzing (null if it failed or was removed). */
function whenReady(id: string): Promise<MediaItem | null> {
  return new Promise((resolve) => {
    const check = (): boolean => {
      const m = mediaById(id)
      if (m && m.status === 'analyzing') return false
      resolve(m && m.status === 'ready' ? m : null)
      return true
    }
    if (check()) return
    const off = useEditor.subscribe(() => {
      if (check()) off()
    })
  })
}

/**
 * Adds files by path (Explorer tab, downloads, pasted images; desktop
 * app only). A file already in Project Media is reused instead of duplicated.
 */
export function importPaths(paths: string[]): Promise<MediaItem | null>[] {
  return paths.map((path) => {
    const existing = useEditor.getState().media.find((m) => m.path === path && m.status !== 'error')
    if (existing) return whenReady(existing.id)
    const name = path.split(/[\\/]/).pop() ?? path
    const kind = kindOfName(name)
    if (!kind) {
      setStatus(`Unsupported file type: ${name}`)
      return Promise.resolve(null)
    }
    const url = mediaPathUrl(path)
    const item: MediaItem = {
      id: uid(),
      name,
      kind,
      file: null,
      url,
      path,
      size: 0,
      status: 'analyzing',
      error: '',
      duration: 0,
      hasVideo: kind !== 'audio',
      hasAudio: false,
      width: 0,
      height: 0,
      fps: 0,
      videoCodec: '',
      audioCodec: '',
      sampleRate: 0,
      channels: 0,
      poster: kind === 'image' ? url : ''
    }
    addMediaItem(item)
    return track(item)
  })
}

/**
 * Adds files to Project Media. Each returned promise resolves when that file is
 * ready to be placed on the timeline (null if it was rejected or failed).
 */
export function importFiles(files: Iterable<File>): Promise<MediaItem | null>[] {
  const pending: Promise<MediaItem | null>[] = []
  for (const file of files) {
    const kind = classify(file)
    if (!kind) {
      setStatus(`Unsupported file type: ${file.name}`)
      continue
    }
    const url = URL.createObjectURL(file)
    // A project opened without its files (browser, or moved files): importing a
    // file with the same name and size relinks it instead of adding a duplicate.
    const missing = useEditor
      .getState()
      .media.find((m) => !canRead(m) && m.name === file.name && (m.size === 0 || m.size === file.size))
    if (missing) {
      updateMedia(missing.id, { file, url, size: file.size, status: 'analyzing', error: '', path: bridge?.pathForFile(file) ?? '' })
      pending.push(track(mediaById(missing.id) as MediaItem))
      continue
    }
    const item: MediaItem = {
      id: uid(),
      name: file.name,
      kind,
      file,
      url,
      path: bridge?.pathForFile(file) ?? '',
      size: file.size,
      status: 'analyzing',
      error: '',
      duration: 0,
      hasVideo: kind !== 'audio',
      hasAudio: false,
      width: 0,
      height: 0,
      fps: 0,
      videoCodec: '',
      audioCodec: '',
      sampleRate: 0,
      channels: 0,
      poster: kind === 'image' ? url : ''
    }
    addMediaItem(item)
    pending.push(track(item))
  }
  return pending
}

/** Analyzes a media item and reports the outcome in the status bar. */
export function track(item: MediaItem): Promise<MediaItem | null> {
  setStatus(`Analyzing ${item.name}…`)
  return analyzeMedia(item).then(
    () => {
      const ready = mediaById(item.id)
      setStatus(`Imported ${item.name}`)
      return ready && ready.status === 'ready' ? ready : null
    },
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      updateMedia(item.id, { status: 'error', error: message })
      setStatus(`Cannot use ${item.name}: ${message}`)
      return null
    }
  )
}

async function analyzeMedia(item: MediaItem): Promise<void> {
  if (item.kind === 'image') {
    const blob = item.file ?? (await (await fetch(item.url)).blob())
    const bitmap = await createImageBitmap(blob)
    imageCache.set(item.id, bitmap)
    updateMedia(item.id, { status: 'ready', width: bitmap.width, height: bitmap.height, hasVideo: true })
    notifyMediaCache()
    return
  }

  const input = new Input({ formats: ALL_FORMATS, source: inputSource(item) })
  let keepInput = false
  try {
    if (!(await input.canRead())) throw new Error('container format not supported')
    const [video, audio] = await Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()])
    if (!video && !audio) throw new Error('no audio or video tracks')
    const videoOk = video ? await video.canDecode() : false
    const audioOk = audio ? await audio.canDecode() : false
    if (!videoOk && !audioOk) {
      const codec = video?.codec ?? audio?.codec ?? 'unknown'
      throw new Error(`codec "${codec}" cannot be decoded here (proxy support comes later)`)
    }
    const first = await input.getFirstTimestamp()
    const end = await input.computeDuration()
    const seconds = Math.max(0, end - Math.max(0, first))
    let measuredFps = 0
    if (video && videoOk) {
      const stats = await video.computePacketStats(120)
      measuredFps = stats.averagePacketRate
    }
    updateMedia(item.id, {
      status: 'ready',
      kind: videoOk ? 'video' : 'audio',
      hasVideo: videoOk,
      hasAudio: audioOk,
      duration: secondsToFlicks(seconds),
      width: video && videoOk ? video.displayWidth : 0,
      height: video && videoOk ? video.displayHeight : 0,
      fps: measuredFps,
      videoCodec: video?.codec ?? '',
      audioCodec: audio?.codec ?? '',
      sampleRate: audio?.sampleRate ?? 0,
      channels: audio?.numberOfChannels ?? 0
    })

    // Thumbnails and waveform keep loading in the background.
    const jobs: Promise<void>[] = []
    if (video && videoOk) jobs.push(buildThumbnails(item.id, video, Math.max(0, first), seconds))
    if (audio && audioOk) jobs.push(buildPeaks(item.id, audio, Math.max(0, first), seconds))
    keepInput = true
    void Promise.allSettled(jobs).then(() => input.dispose())
  } finally {
    if (!keepInput) input.dispose()
  }
}

async function canvasToUrl(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<string> {
  const blob =
    'convertToBlob' in canvas
      ? await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
      : await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))
  return blob ? URL.createObjectURL(blob) : ''
}

async function buildThumbnails(
  mediaId: string,
  video: InputVideoTrack,
  first: number,
  seconds: number
): Promise<void> {
  const aspect = video.displayWidth / video.displayHeight || 16 / 9
  const height = 72
  const width = Math.max(8, Math.round(height * aspect))
  const count = Math.min(60, Math.max(6, Math.ceil(seconds / 2)))
  const times = Array.from({ length: count }, (_, i) => first + (i * seconds) / count)
  const strip: ThumbStrip = { aspect, thumbs: [] }
  thumbCache.set(mediaId, strip)
  const sink = new CanvasSink(video, { width, height, fit: 'fill' })
  let produced = 0
  for await (const wrapped of sink.canvasesAtTimestamps(times)) {
    if (!thumbCache.has(mediaId)) return
    if (!wrapped) continue
    strip.thumbs.push({ time: Math.max(0, wrapped.timestamp - first), image: wrapped.canvas })
    if (++produced === 1) {
      const poster = await canvasToUrl(wrapped.canvas)
      if (poster) updateMedia(mediaId, { poster })
    }
    if (produced % 6 === 0) notifyMediaCache()
  }
  notifyMediaCache()
}

const PEAKS_PER_SECOND = 100

async function buildPeaks(mediaId: string, audio: InputAudioTrack, first: number, seconds: number): Promise<void> {
  const channelCount = Math.min(2, Math.max(1, audio.numberOfChannels))
  const total = Math.ceil(seconds * PEAKS_PER_SECOND) + 2
  const peaks: Peaks = {
    perSecond: PEAKS_PER_SECOND,
    channels: Array.from({ length: channelCount }, () => new Float32Array(total))
  }
  peakCache.set(mediaId, peaks)
  const sink = new AudioBufferSink(audio)
  let lastNotify = performance.now()
  for await (const { buffer, timestamp } of sink.buffers()) {
    if (!peakCache.has(mediaId)) return
    const rate = buffer.sampleRate
    const samplesPerBucket = rate / PEAKS_PER_SECOND
    const t0 = timestamp - first
    for (let c = 0; c < channelCount; c++) {
      const src = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1))
      const dst = peaks.channels[c]
      let bucket = Math.floor(t0 * PEAKS_PER_SECOND)
      let boundary = ((bucket + 1) / PEAKS_PER_SECOND - t0) * rate
      let max = 0
      for (let i = 0; i < src.length; i++) {
        if (i >= boundary) {
          if (bucket >= 0 && bucket < total && max > dst[bucket]) dst[bucket] = max
          bucket++
          boundary += samplesPerBucket
          max = 0
        }
        const v = src[i] < 0 ? -src[i] : src[i]
        if (v > max) max = v
      }
      if (bucket >= 0 && bucket < total && max > dst[bucket]) dst[bucket] = max
    }
    if (performance.now() - lastNotify > 300) {
      lastNotify = performance.now()
      notifyMediaCache()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
  notifyMediaCache()
}

let fileInput: HTMLInputElement | null = null

/** Opens the system file picker (works in the browser and in Electron). */
export function openImportDialog(onImported?: (pending: Promise<MediaItem | null>[]) => void): void {
  if (!fileInput) {
    fileInput = document.createElement('input')
    fileInput.type = 'file'
    fileInput.multiple = true
    fileInput.accept = ACCEPT
    fileInput.style.display = 'none'
    document.body.appendChild(fileInput)
  }
  const input = fileInput
  input.value = ''
  input.onchange = () => {
    const pending = importFiles(Array.from(input.files ?? []))
    onImported?.(pending)
  }
  input.click()
}

const DEMO_FILES = [
  { name: 'demo-16x9.mp4', type: 'video/mp4' },
  { name: 'demo-9x16.mp4', type: 'video/mp4' },
  { name: 'demo-music.m4a', type: 'audio/mp4' },
  { name: 'demo-image.png', type: 'image/png' }
]

/** Imports the files generated by `npm run samples` (served by the dev server only). */
export async function loadDemoMedia(): Promise<Promise<MediaItem | null>[]> {
  const files: File[] = []
  for (const demo of DEMO_FILES) {
    try {
      const response = await fetch(`./${demo.name}`)
      if (!response.ok) continue
      const blob = await response.blob()
      if (blob.size === 0 || blob.type.includes('text/html')) continue
      files.push(new File([blob], demo.name, { type: demo.type }))
    } catch {
      // Missing demo file: skipped.
    }
  }
  if (files.length === 0) {
    setStatus('Demo media not found. Run "npm run samples" and use the dev server.')
    return []
  }
  return importFiles(files)
}

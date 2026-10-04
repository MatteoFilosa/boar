import { useEditor, mediaById, type PreviewQuality } from '../core/store'
import { onUserSeek, setStatus } from '../core/actions'
import { type Flicks, flicksToSeconds, secondsToFlicks } from '../core/time'
import { audioGain, eventsByTrack, projectEnd, sourceTime } from '../core/timeline'
import type { MediaItem, TimelineEvent, Track } from '../core/types'
import { composeFrame } from './compose'
import { type AudioFxChain, audioFxKey, buildAudioFxChain, prepareAudioFx } from './audioFx'
import type { EventFx } from '../core/fx'
import { onFontLoaded } from '../core/fonts'
import { onSegmenterReady } from './vision'
import { previewUrl } from '../media/proxy'

/**
 * Preview engine: hidden <video>/<audio> elements decode, frames are composited
 * on a 2D canvas and sound is mixed with Web Audio.
 */

export const QUALITY_SCALE: Record<PreviewQuality, number> = {
  draft: 0.25,
  preview: 0.5,
  good: 1,
  best: 1
}

interface VideoSlot {
  el: HTMLVideoElement
  mediaId: string
  /** What the element plays: the media file or its proxy. */
  url: string
  pendingSeek: number | null
  lastUsed: number
  /** A frame was decoded once: while seeking the element still draws the last one. */
  hasFrame: boolean
}

interface AudioSlot {
  el: HTMLAudioElement
  source: MediaElementAudioSourceNode
  gain: GainNode
  mediaId: string
  trackId: string
  lastUsed: number
  /** Event FX chain between the source and the gain (null = direct). */
  chain: AudioFxChain | null
  fxKey: string
  fxRef: EventFx[] | null
}

interface AudioGraph {
  ctx: AudioContext
  master: GainNode
  analysers: [AnalyserNode, AnalyserNode]
  buses: Map<string, { gain: GainNode; pan: StereoPannerNode }>
}

const LOOKAHEAD = secondsToFlicks(0.75)
const RELEASE_AFTER_MS = 10_000
const dbToGain = (db: number): number => (db <= -60 ? 0 : Math.pow(10, db / 20))

class PreviewEngine {
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private readonly layer = document.createElement('canvas')
  private readonly layerCtx = this.layer.getContext('2d') as CanvasRenderingContext2D
  private readonly host = document.createElement('div')
  private readonly videos = new Map<string, VideoSlot>()
  private readonly audios = new Map<string, AudioSlot>()
  private audio: AudioGraph | null = null
  private dirty = true
  private playStartWall = 0
  private playStartTime: Flicks = 0
  private returnTo: Flicks | null = null
  private readonly meterBuffer = new Float32Array(1024)
  /** Peak level per channel (linear), with decay. Read by the master bus meters. */
  readonly meter: [number, number] = [0, 0]

  constructor() {
    this.host.style.cssText =
      'position:fixed;left:-4px;top:-4px;width:2px;height:2px;overflow:hidden;opacity:0;pointer-events:none'
    document.body.appendChild(this.host)
    useEditor.subscribe((s, prev) => {
      if (
        s.project !== prev.project ||
        s.cursor !== prev.cursor ||
        s.media !== prev.media ||
        s.options !== prev.options
      ) {
        this.dirty = true
      }
    })
    // Text drawn before its font finished loading is redrawn.
    onFontLoaded(() => (this.dirty = true))
    onSegmenterReady(() => (this.dirty = true))
    onUserSeek((t) => {
      if (useEditor.getState().playing) {
        this.playStartTime = t
        this.playStartWall = performance.now()
      }
    })
    requestAnimationFrame(this.tick)
  }

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d', { alpha: false })
    this.dirty = true
  }

  detach(canvas: HTMLCanvasElement): void {
    if (this.canvas === canvas) {
      this.canvas = null
      this.ctx = null
    }
  }

  invalidate(): void {
    this.dirty = true
  }

  // Transport

  /** What playback covers: the time selection when there is one, otherwise the project. */
  private playbackRange(): { start: Flicks; end: Flicks } {
    const s = useEditor.getState()
    return s.timeSelection ?? { start: 0, end: projectEnd(s.project) }
  }

  play(): void {
    const s = useEditor.getState()
    if (s.playing) return
    const graph = this.ensureAudio()
    void graph.ctx.resume()
    const range = this.playbackRange()
    const start = s.cursor < range.start || s.cursor >= range.end ? range.start : s.cursor
    this.returnTo = start
    this.playStartTime = start
    this.playStartWall = performance.now()
    useEditor.setState({ playing: true, cursor: start })
  }

  /** Stops playback where it is. */
  pause(): void {
    if (!useEditor.getState().playing) return
    useEditor.setState({ playing: false })
    this.dirty = true
  }

  /** Stops playback and returns the cursor to where playback started (Space). */
  stop(): void {
    const s = useEditor.getState()
    if (!s.playing) return
    useEditor.setState({ playing: false, cursor: this.returnTo ?? s.cursor })
    this.dirty = true
  }

  togglePlay(returnOnStop: boolean): void {
    if (!useEditor.getState().playing) this.play()
    else if (returnOnStop) this.stop()
    else this.pause()
  }

  playFromStart(): void {
    if (useEditor.getState().playing) this.pause()
    useEditor.setState({ cursor: 0 })
    this.play()
  }

  setMasterDb(db: number): void {
    if (this.audio) this.audio.master.gain.setTargetAtTime(dbToGain(db), this.audio.ctx.currentTime, 0.02)
  }

  // Main loop

  private readonly tick = (): void => {
    requestAnimationFrame(this.tick)
    const s = useEditor.getState()
    let t = s.cursor
    if (s.playing) {
      t = this.playStartTime + secondsToFlicks((performance.now() - this.playStartWall) / 1000)
      const range = this.playbackRange()
      if (t >= range.end) {
        if (s.options.loop && range.end > range.start) {
          t = range.start
          this.playStartTime = range.start
          this.playStartWall = performance.now()
        } else {
          useEditor.setState({ playing: false, cursor: range.end })
          this.syncMedia(range.end, false)
          this.render(range.end)
          return
        }
      }
      useEditor.setState({ cursor: t })
    }
    this.syncMedia(t, s.playing)
    if (s.playing || this.dirty) {
      this.dirty = false
      this.render(t)
    }
    this.updateMeters(s.playing)
  }

  // Media sync

  private syncMedia(t: Flicks, playing: boolean): void {
    const { project, options } = useEditor.getState()
    const now = performance.now()
    const wantVideo = new Set<string>()
    const wantAudio = new Set<string>()
    const tracks = new Map(project.tracks.map((tr) => [tr.id, tr]))
    const byTrack = eventsByTrack(project)
    const audioTracks = project.tracks.filter((tr) => tr.kind === 'audio')
    const anyAudioSolo = audioTracks.some((tr) => tr.solo)

    for (const ev of project.events) {
      const end = ev.start + ev.length
      const active = ev.start <= t && t < end
      const upcoming = playing && !active && ev.start > t && ev.start - t <= LOOKAHEAD
      if (!active && !upcoming) continue
      const media = mediaById(ev.mediaId)
      const track = tracks.get(ev.trackId)
      if (!media || media.status !== 'ready' || !track) continue
      const srcSeconds = flicksToSeconds(active ? sourceTime(ev, t) : ev.offset)

      if (ev.kind === 'video' && media.kind === 'video') {
        wantVideo.add(ev.id)
        const slot = this.videoSlot(ev, media)
        slot.lastUsed = now
        this.syncVideo(slot, srcSeconds, playing && active, media.fps, ev.rate)
      } else if (ev.kind === 'audio' && playing) {
        const audible = !track.muted && (!anyAudioSolo || track.solo)
        if (!audible) continue
        wantAudio.add(ev.id)
        const slot = this.audioSlot(ev, media, track)
        slot.lastUsed = now
        this.syncFx(slot, ev)
        const gain = active ? audioGain(ev, t, byTrack.get(ev.trackId) ?? [ev], options.autoCrossfade) : 0
        this.syncAudio(slot, srcSeconds, active, gain, ev.rate)
      }
    }

    for (const [id, slot] of this.videos) {
      if (wantVideo.has(id)) continue
      if (!slot.el.paused) slot.el.pause()
      if (now - slot.lastUsed > RELEASE_AFTER_MS) this.releaseVideo(id)
    }
    for (const [id, slot] of this.audios) {
      if (wantAudio.has(id)) continue
      if (!slot.el.paused) slot.el.pause()
      slot.gain.gain.value = 0
      if (now - slot.lastUsed > RELEASE_AFTER_MS) this.releaseAudio(id)
    }
    if (this.audio) this.updateBuses(audioTracks, anyAudioSolo)
  }

  private videoSlot(ev: TimelineEvent, media: MediaItem): VideoSlot {
    let slot = this.videos.get(ev.id)
    const url = previewUrl(media)
    if (slot && (slot.mediaId !== media.id || slot.url !== url)) {
      this.releaseVideo(ev.id)
      slot = undefined
    }
    if (!slot) {
      const el = document.createElement('video')
      el.muted = true
      el.preload = 'auto'
      el.playsInline = true
      el.disableRemotePlayback = true
      // Files read by path come from boar-media://: CORS keeps their frames usable by the canvas.
      el.crossOrigin = 'anonymous'
      el.src = url
      const created: VideoSlot = { el, mediaId: media.id, url, pendingSeek: null, lastUsed: 0, hasFrame: false }
      el.addEventListener('loadeddata', () => {
        created.hasFrame = true
        this.dirty = true
      })
      el.addEventListener('seeked', () => {
        created.hasFrame = true
        const pending = created.pendingSeek
        created.pendingSeek = null
        if (pending !== null && Math.abs(el.currentTime - pending) > 0.001) el.currentTime = pending
        this.dirty = true
      })
      el.addEventListener('error', () => setStatus(`Preview cannot decode ${media.name}`))
      this.host.appendChild(el)
      this.videos.set(ev.id, created)
      slot = created
    }
    return slot
  }

  private syncVideo(slot: VideoSlot, src: number, play: boolean, mediaFps: number, rate: number): void {
    const el = slot.el
    if (play) {
      if (el.playbackRate !== rate) el.playbackRate = rate
      if (el.paused) {
        if (Math.abs(el.currentTime - src) > 0.04) el.currentTime = src
        void el.play().catch(() => undefined)
      } else if (Math.abs(el.currentTime - src) > 0.2 * Math.max(1, rate)) {
        el.currentTime = src
      }
      return
    }
    if (!el.paused) el.pause()
    // Aim inside the frame so rounding never shows the previous one.
    const target = src + 0.001
    const halfFrame = 0.5 / (mediaFps || 30)
    if (el.seeking) {
      slot.pendingSeek = target
      return
    }
    if (Math.abs(el.currentTime - target) > halfFrame) el.currentTime = target
  }

  private releaseVideo(id: string): void {
    const slot = this.videos.get(id)
    if (!slot) return
    slot.el.pause()
    slot.el.removeAttribute('src')
    slot.el.load()
    slot.el.remove()
    this.videos.delete(id)
  }

  private ensureAudio(): AudioGraph {
    if (this.audio) return this.audio
    // 48 kHz like the export mix (and what the noise reduction models expect).
    const ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 })
    void prepareAudioFx(ctx)
    const master = ctx.createGain()
    master.gain.value = dbToGain(useEditor.getState().options.masterDb)
    const splitter = ctx.createChannelSplitter(2)
    const left = ctx.createAnalyser()
    const right = ctx.createAnalyser()
    left.fftSize = 1024
    right.fftSize = 1024
    master.connect(ctx.destination)
    master.connect(splitter)
    splitter.connect(left, 0)
    splitter.connect(right, 1)
    this.audio = { ctx, master, analysers: [left, right], buses: new Map() }
    return this.audio
  }

  private bus(trackId: string): { gain: GainNode; pan: StereoPannerNode } {
    const graph = this.ensureAudio()
    let bus = graph.buses.get(trackId)
    if (!bus) {
      const gain = graph.ctx.createGain()
      const pan = graph.ctx.createStereoPanner()
      gain.connect(pan)
      pan.connect(graph.master)
      bus = { gain, pan }
      graph.buses.set(trackId, bus)
    }
    return bus
  }

  private updateBuses(audioTracks: Track[], anySolo: boolean): void {
    const graph = this.audio
    if (!graph) return
    const now = graph.ctx.currentTime
    for (const track of audioTracks) {
      const bus = graph.buses.get(track.id)
      if (!bus) continue
      const audible = !track.muted && (!anySolo || track.solo)
      bus.gain.gain.setTargetAtTime(audible ? dbToGain(track.volumeDb) : 0, now, 0.02)
      bus.pan.pan.setTargetAtTime(track.pan, now, 0.02)
    }
  }

  private audioSlot(ev: TimelineEvent, media: MediaItem, track: Track): AudioSlot {
    const graph = this.ensureAudio()
    let slot = this.audios.get(ev.id)
    if (slot && slot.mediaId !== media.id) {
      this.releaseAudio(ev.id)
      slot = undefined
    }
    if (!slot) {
      const el = new Audio()
      el.preload = 'auto'
      // Without CORS, Web Audio outputs silence for boar-media:// files (Explorer, reopened projects).
      el.crossOrigin = 'anonymous'
      el.preservesPitch = true
      el.src = media.url
      const source = graph.ctx.createMediaElementSource(el)
      const gain = graph.ctx.createGain()
      gain.gain.value = 0
      source.connect(gain)
      slot = { el, source, gain, mediaId: media.id, trackId: '', lastUsed: 0, chain: null, fxKey: '', fxRef: null }
      this.audios.set(ev.id, slot)
    }
    if (slot.trackId !== track.id) {
      slot.gain.disconnect()
      slot.gain.connect(this.bus(track.id).gain)
      slot.trackId = track.id
    }
    return slot
  }

  /** Rebuilds the event's Audio FX chain when its structure changed, else updates parameters. */
  private syncFx(slot: AudioSlot, ev: TimelineEvent): void {
    const ctx = this.ensureAudio().ctx
    const key = audioFxKey(ctx, ev.fx)
    if (key !== slot.fxKey) {
      slot.source.disconnect()
      slot.chain?.dispose()
      slot.chain = key ? buildAudioFxChain(ctx, ev.fx) : null
      if (slot.chain) {
        slot.source.connect(slot.chain.input)
        slot.chain.output.connect(slot.gain)
      } else {
        slot.source.connect(slot.gain)
      }
      slot.fxKey = key
      slot.fxRef = ev.fx
      return
    }
    if (slot.chain && slot.fxRef !== ev.fx) slot.chain.update(ev.fx)
    slot.fxRef = ev.fx
  }

  private syncAudio(slot: AudioSlot, src: number, active: boolean, gain: number, rate: number): void {
    const el = slot.el
    const graph = this.ensureAudio()
    // Speed changes keep the pitch (Chromium time-stretches like the export does).
    if (el.playbackRate !== rate) el.playbackRate = rate
    if (!active) {
      if (!el.paused) el.pause()
      if (Math.abs(el.currentTime - src) > 0.05) el.currentTime = src
      slot.gain.gain.value = 0
      return
    }
    slot.gain.gain.setTargetAtTime(gain, graph.ctx.currentTime, 0.012)
    if (el.paused) {
      if (Math.abs(el.currentTime - src) > 0.04) el.currentTime = src
      void el.play().catch(() => undefined)
    } else if (Math.abs(el.currentTime - src) > 0.15 * Math.max(1, rate)) {
      el.currentTime = src
    }
  }

  private releaseAudio(id: string): void {
    const slot = this.audios.get(id)
    if (!slot) return
    slot.el.pause()
    slot.source.disconnect()
    slot.chain?.dispose()
    slot.gain.disconnect()
    slot.el.removeAttribute('src')
    slot.el.load()
    this.audios.delete(id)
  }

  private updateMeters(playing: boolean): void {
    for (let c = 0; c < 2; c++) {
      let peak = 0
      if (this.audio && playing) {
        const analyser = this.audio.analysers[c]
        analyser.getFloatTimeDomainData(this.meterBuffer)
        for (let i = 0; i < this.meterBuffer.length; i++) {
          const v = Math.abs(this.meterBuffer[i])
          if (v > peak) peak = v
        }
      }
      this.meter[c] = Math.max(peak, this.meter[c] * 0.9)
    }
  }

  // Compositing

  private render(t: Flicks): void {
    const canvas = this.canvas
    const ctx = this.ctx
    if (!canvas || !ctx) return
    const { project, options } = useEditor.getState()
    const scale = QUALITY_SCALE[options.previewQuality]
    const width = Math.max(2, Math.round(project.settings.width * scale))
    const height = Math.max(2, Math.round(project.settings.height * scale))
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    if (this.layer.width !== width || this.layer.height !== height) {
      this.layer.width = width
      this.layer.height = height
    }
    ctx.imageSmoothingQuality = options.previewQuality === 'best' ? 'high' : 'medium'
    composeFrame(ctx, this.layerCtx, project, options.autoCrossfade, t, width, height, (ev) => {
      const slot = this.videos.get(ev.id)
      // While a seek decodes (long keyframe intervals take a while) keep showing the last frame instead of black.
      if (!slot || (slot.el.readyState < 2 && !slot.hasFrame)) return null
      return { source: slot.el, width: slot.el.videoWidth, height: slot.el.videoHeight }
    })
  }
}

let engine: PreviewEngine | null = null

export function getEngine(): PreviewEngine {
  if (!engine) engine = new PreviewEngine()
  return engine
}

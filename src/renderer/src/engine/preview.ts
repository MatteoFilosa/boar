import { useEditor, mediaById, type PreviewQuality } from '../core/store'
import { onUserSeek, setStatus } from '../core/actions'
import { type Flicks, flicksToSeconds, secondsToFlicks } from '../core/time'
import { audioGain, eventEnd, eventsByTrack, projectEnd, sourceTime } from '../core/timeline'
import { panCropAt, sourceToOutput } from '../core/pancrop'
import { imageAt } from '../media/cache'
import type { MediaItem, TimelineEvent, Track } from '../core/types'
import { composeFrame } from './compose'
import { type AudioFxChain, audioFxKey, buildAudioFxChain, prepareAudioFx } from './audioFx'
import type { EventFx } from '../core/fx'
import { onFontLoaded } from '../core/fonts'
import { onSegmenterReady } from './vision'
import { previewUrl } from '../media/proxy'
import { type SoundClock, SoundStream, closeIdleSounds, openSound } from './soundStream'

/**
 * Preview engine: hidden <video> elements decode, frames are composited on a
 * 2D canvas; sound is decoded like the export and mixed with Web Audio.
 */

export const QUALITY_SCALE: Record<PreviewQuality, number> = {
  draft: 0.25,
  preview: 0.5,
  good: 1,
  best: 1
}

/**
 * Keeps a playing element on the timeline clock without fighting its own
 * seeks. Elements seek only while paused: a seek aims where the timeline will
 * be when it lands (seeks of long files or files read through the media
 * protocol can take longer than the drift allowed), and the element starts
 * when the timeline reaches it. Seeking a playing element left a gap and landed
 * behind the timeline, which took another seek.
 *
 * currentTime can read behind for a moment, then catch up: a playing element
 * is judged by its least late reading over a short window; after a jump of the
 * timeline one reading decides.
 */
interface Drift {
  /** When the running seek started (performance.now), 0 = none. */
  seekStart: number
  /** How long this element's seeks take, in seconds. */
  seekLag: number
  /** No new correction before this time (performance.now). */
  holdUntil: number
  /** When the element started playing (performance.now). */
  since: number
  /** Recent readings while playing: time (performance.now) and offset from the timeline (seconds), in pairs. */
  readings: number[]
  /** The timeline clock jumped: the next reading decides at once. */
  jumped: boolean
}

const newDrift = (): Drift => ({ seekStart: 0, seekLag: 0.05, holdUntil: 0, since: 0, readings: [], jumped: false })

/** How long a playing element is watched before a drift counts (ms). */
const DRIFT_WINDOW = 600

function seekTo(el: HTMLMediaElement, drift: Drift, seconds: number): void {
  drift.seekStart = performance.now()
  el.currentTime = seconds
}

function seekLanded(drift: Drift): void {
  if (drift.seekStart) drift.seekLag = Math.min(0.5, (performance.now() - drift.seekStart) / 1000)
  drift.seekStart = 0
}

/** Off by more than this in one reading (seconds of source), a playing element is cued again at once. */
const JUMP = 1
/** A cued element starts when the timeline is this close to it (seconds; a tick is about 17 ms). */
const START_WINDOW = 0.025

/** Whether a playing element is off the timeline by more than `limit` seconds. */
function drifted(drift: Drift, off: number, limit: number, now: number): boolean {
  if (drift.jumped) {
    drift.jumped = false
    drift.readings.length = 0
    // Still in step: watch it again from here.
    drift.since = now
    return Math.abs(off) > limit
  }
  if (Math.abs(off) > JUMP) return true
  const readings = drift.readings
  readings.push(now, off)
  let first = 0
  while (first < readings.length && readings[first] < now - DRIFT_WINDOW) first += 2
  if (first > 0) readings.splice(0, first)
  if (now - drift.since < DRIFT_WINDOW || now < drift.holdUntil) return false
  let best = -Infinity
  for (let i = 1; i < readings.length; i += 2) best = Math.max(best, readings[i])
  return Math.abs(best) > limit
}

/**
 * Plays `el` at source time `src` (where the timeline is now). A playing
 * element that drifted by more than `tolerance` seconds is paused and cued
 * again; a paused one seeks ahead and starts when the timeline gets there.
 * `frame` is how long ticks take now (seconds).
 */
function playInStep(el: HTMLMediaElement, drift: Drift, src: number, rate: number, tolerance: number, frame: number): void {
  const speed = Math.max(1, rate)
  if (!el.paused) {
    if (el.seeking || el.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return
    const now = performance.now()
    if (!drifted(drift, el.currentTime - src, tolerance * speed, now)) return
    drift.holdUntil = now + 1000
    el.pause()
  }
  if (el.seeking) return
  const ahead = el.currentTime - src
  // Starts on the tick nearest to the cue. With slow frames (heavy projects) no
  // tick fell within a few ms of it: the element sought again and again and never played.
  if (ahead <= Math.max(START_WINDOW, frame / 2) * speed && ahead >= -(START_WINDOW + frame) * speed) {
    drift.since = performance.now()
    drift.readings.length = 0
    drift.jumped = false
    void el.play().catch(() => undefined)
    return
  }
  // Cued ahead: wait for the timeline (the element keeps its frame on screen meanwhile).
  if (ahead > 0 && ahead <= (drift.seekLag + 0.25) * speed) return
  seekTo(el, drift, src + (drift.seekLag + 0.05) * rate)
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
  drift: Drift
}

interface AudioSlot {
  /** Where the decoded sound enters. */
  input: GainNode
  stream: SoundStream
  gain: GainNode
  mediaId: string
  trackId: string
  lastUsed: number
  /** Event FX chain between the input and the gain (null = direct). */
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
/** Sound slots kept per file, FX chain built, for the next event that plays it. */
const SPARE_AUDIO_PER_MEDIA = 3
const SPARE_AUDIO_MS = 120_000
/** Off the clock by more than this (seconds), playing sound starts again where the timeline is. */
const MAX_SOUND_DRIFT = 0.04
const dbToGain = (db: number): number => (db <= -60 ? 0 : Math.pow(10, db / 20))

/** Side of the square an eyedropper averages, in source pixels (evens out noise and compression). */
const PICK_SIZE = 5
let pickCanvas: CanvasRenderingContext2D | null = null

/** Average color (0xRRGGBB) of the pixels around (x, y) in `source`, null where it is transparent. */
function averageColor(source: CanvasImageSource, x: number, y: number): number | null {
  if (!pickCanvas) {
    const canvas = document.createElement('canvas')
    canvas.width = PICK_SIZE
    canvas.height = PICK_SIZE
    pickCanvas = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D
  }
  const ctx = pickCanvas
  ctx.clearRect(0, 0, PICK_SIZE, PICK_SIZE)
  const half = PICK_SIZE / 2
  ctx.drawImage(source, x - half, y - half, PICK_SIZE, PICK_SIZE, 0, 0, PICK_SIZE, PICK_SIZE)
  const data = ctx.getImageData(0, 0, PICK_SIZE, PICK_SIZE).data
  let r = 0
  let g = 0
  let b = 0
  let w = 0
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255
    r += data[i] * a
    g += data[i + 1] * a
    b += data[i + 2] * a
    w += a
  }
  if (w < 0.5) return null
  return (Math.round(r / w) << 16) | (Math.round(g / w) << 8) | Math.round(b / w)
}

class PreviewEngine {
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private readonly layer = document.createElement('canvas')
  private readonly layerCtx = this.layer.getContext('2d') as CanvasRenderingContext2D
  private readonly host = document.createElement('div')
  private readonly videos = new Map<string, VideoSlot>()
  private readonly audios = new Map<string, AudioSlot>()
  /**
   * Sound slots no event uses right now, by media: the pieces of a clip cut
   * into many events (Remove Silences) reuse their FX chain instead of building
   * it again (noise reduction models take a moment to start).
   */
  private readonly spareAudio = new Map<string, AudioSlot[]>()
  private audio: AudioGraph | null = null
  private dirty = true
  private playStartWall = 0
  private playStartTime: Flicks = 0
  private returnTo: Flicks | null = null
  /** Bumped when the timeline clock jumps or the sound drifts from it: playing sound starts again where it is. */
  private soundEpoch = 0
  /**
   * Context time of one timeline time, fixed until the next jump: the sounds of
   * every event follow the same clock, so the pieces of a cut clip join sample
   * by sample (measured anew for each event, they overlapped or left gaps of a
   * millisecond or two, which clicked).
   */
  private soundAnchor: { epoch: number; t: Flicks; ctx: number } | null = null
  /** Since when the sound clock is off the measured one by more than MAX_SOUND_DRIFT (performance.now, 0 = in step). */
  private soundDriftSince = 0
  /** How long ticks take now (seconds). */
  private frame = 1 / 60
  private lastTick = 0
  /** Files whose sound could not be decoded, reported once. */
  private readonly silentMedia = new Set<string>()
  private readonly clock: SoundClock = {
    now: () => this.playStartTime + secondsToFlicks((performance.now() - this.playStartWall) / 1000),
    contextTimeAt: (t) => this.contextTimeAt(t)
  }
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
        this.clockJumped()
      }
    })
    requestAnimationFrame(this.tick)
  }

  /** The timeline clock jumped while playing: the playing elements and sounds follow at once. */
  private clockJumped(): void {
    this.soundEpoch++
    for (const slot of this.videos.values()) {
      slot.drift.jumped = true
      slot.drift.holdUntil = 0
    }
  }

  /** AudioContext time at which timeline time `t` is played, on the clock of the sounds playing now. */
  private contextTimeAt(t: Flicks): number {
    let anchor = this.soundAnchor
    if (!anchor || anchor.epoch !== this.soundEpoch) {
      anchor = { epoch: this.soundEpoch, t, ctx: this.heardAt(t) }
      this.soundAnchor = anchor
    }
    return anchor.ctx + flicksToSeconds(t - anchor.t)
  }

  /** AudioContext time at which timeline time `t` is heard while playing, measured now (output latency included). */
  private heardAt(t: Flicks): number {
    const ctx = this.ensureAudio().ctx
    const wall = this.playStartWall + flicksToSeconds(t - this.playStartTime) * 1000
    const out = ctx.getOutputTimestamp()
    if (out.contextTime && out.performanceTime) return out.contextTime + (wall - out.performanceTime) / 1000
    return ctx.currentTime - ctx.baseLatency - (ctx.outputLatency || 0) + (wall - performance.now()) / 1000
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
    // Play from Start while playing: elements still play where the timeline was.
    this.clockJumped()
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
    const wall = performance.now()
    if (this.lastTick) this.frame = Math.min(0.25, Math.max(0.004, (wall - this.lastTick) / 1000))
    this.lastTick = wall
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
          this.clockJumped()
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
    // The audio device's clock and the timeline's drift apart slowly (and stop together while the
    // context is suspended); a single reading can be off by a few ms, a drift lasts.
    const anchor = this.soundAnchor
    if (playing && anchor?.epoch === this.soundEpoch && Math.abs(this.contextTimeAt(t) - this.heardAt(t)) > MAX_SOUND_DRIFT) {
      this.soundDriftSince ||= now
      if (now - this.soundDriftSince > DRIFT_WINDOW) this.soundEpoch++
    } else {
      this.soundDriftSince = 0
    }

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
      } else if (ev.kind === 'audio' && (playing || active)) {
        // While paused, the file under the cursor is opened too: play starts at once.
        const audible = !track.muted && (!anyAudioSolo || track.solo)
        if (!audible) continue
        wantAudio.add(ev.id)
        const slot = this.audioSlot(ev, media, track)
        slot.lastUsed = now
        this.syncFx(slot, ev)
        this.syncAudio(slot, ev, media, t, playing, active, byTrack.get(ev.trackId) ?? [ev], options.autoCrossfade)
      }
    }

    for (const [id, slot] of this.videos) {
      if (wantVideo.has(id)) continue
      if (!slot.el.paused) slot.el.pause()
      // A file no longer in the project (another one opened) lets its decoder go at once.
      if (now - slot.lastUsed > RELEASE_AFTER_MS || !mediaById(slot.mediaId)) this.releaseVideo(id)
    }
    for (const [id, slot] of this.audios) {
      if (wantAudio.has(id)) continue
      // Fades out (setting the gain to 0 at once clicked).
      slot.stream.stop()
      this.spare(id)
    }
    closeIdleSounds(now)
    for (const [mediaId, list] of this.spareAudio) {
      const keep = mediaById(mediaId) ? list.filter((slot) => now - slot.lastUsed < SPARE_AUDIO_MS) : []
      for (const slot of list) if (!keep.includes(slot)) this.destroyAudio(slot)
      if (keep.length) this.spareAudio.set(mediaId, keep)
      else this.spareAudio.delete(mediaId)
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
      const created: VideoSlot = { el, mediaId: media.id, url, pendingSeek: null, lastUsed: 0, hasFrame: false, drift: newDrift() }
      el.addEventListener('loadeddata', () => {
        created.hasFrame = true
        this.dirty = true
      })
      el.addEventListener('seeked', () => {
        seekLanded(created.drift)
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
      playInStep(el, slot.drift, src, rate, 0.2, this.frame)
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
      // A loaded element of the same file, if one is free.
      slot = this.spareAudio.get(media.id)?.pop()
      if (slot) this.audios.set(ev.id, slot)
    }
    if (!slot) {
      const input = graph.ctx.createGain()
      const gain = graph.ctx.createGain()
      gain.gain.value = 0
      input.connect(gain)
      const stream = new SoundStream(graph.ctx, input, (err) => this.soundFailed(media, err))
      slot = { input, stream, gain, mediaId: media.id, trackId: '', lastUsed: 0, chain: null, fxKey: '', fxRef: null }
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
      slot.input.disconnect()
      slot.chain?.dispose()
      slot.chain = key ? buildAudioFxChain(ctx, ev.fx) : null
      if (slot.chain) {
        slot.input.connect(slot.chain.input)
        slot.chain.output.connect(slot.gain)
      } else {
        slot.input.connect(slot.gain)
      }
      slot.fxKey = key
      slot.fxRef = ev.fx
      return
    }
    if (slot.chain && slot.fxRef !== ev.fx) slot.chain.update(ev.fx)
    slot.fxRef = ev.fx
  }

  /**
   * Plays the event's sound while playing: from where the timeline is, or from
   * its start when it is coming up (scheduled ahead, so a cut joins the next
   * piece without a gap). Starts again after a jump, an edit of the event's
   * timing or a drift from the clock.
   */
  private syncAudio(
    slot: AudioSlot,
    ev: TimelineEvent,
    media: MediaItem,
    t: Flicks,
    playing: boolean,
    active: boolean,
    trackEvents: TimelineEvent[],
    autoCrossfade: boolean
  ): void {
    const ctx = this.ensureAudio().ctx
    if (!playing) {
      slot.stream.stop()
      void openSound(media, (err) => this.soundFailed(media, err))
      return
    }
    // The audio thread runs ahead of the sound heard now by the output latency: gains follow it.
    const lead = secondsToFlicks(Math.max(0, ctx.currentTime - this.contextTimeAt(t)))
    const at = Math.min(ev.start + ev.length - 1, Math.max(ev.start, t + lead))
    slot.gain.gain.setTargetAtTime(audioGain(ev, at, trackEvents, autoCrossfade), ctx.currentTime, 0.012)
    const key = `${this.soundEpoch}|${ev.start}|${ev.length}|${ev.offset}|${ev.rate}`
    if (slot.stream.key !== key) slot.stream.start(ev, media, active ? t : ev.start, key, this.clock)
  }

  private soundFailed(media: MediaItem, err: unknown): void {
    console.warn('[preview] sound of', media.name, err)
    if (this.silentMedia.has(media.id)) return
    this.silentMedia.add(media.id)
    setStatus(`Preview cannot play the sound of ${media.name}`)
  }

  /** The event no longer plays: its slot waits, FX chain built, for the next event of the same file. */
  private spare(id: string): void {
    const slot = this.audios.get(id)
    if (!slot) return
    this.audios.delete(id)
    const list = this.spareAudio.get(slot.mediaId) ?? []
    list.push(slot)
    while (list.length > SPARE_AUDIO_PER_MEDIA) {
      const oldest = list.shift()
      if (oldest) this.destroyAudio(oldest)
    }
    this.spareAudio.set(slot.mediaId, list)
  }

  private releaseAudio(id: string): void {
    const slot = this.audios.get(id)
    if (!slot) return
    this.audios.delete(id)
    this.destroyAudio(slot)
  }

  private destroyAudio(slot: AudioSlot): void {
    slot.stream.stop()
    slot.input.disconnect()
    slot.chain?.dispose()
    slot.gain.disconnect()
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

  /**
   * Eyedropper: the color of the event's own picture (before its effects) at
   * output point (x, y), in project pixels, at the cursor. Where the event shows
   * no picture, the color of the preview as it looks.
   */
  pickColor(eventId: string, x: number, y: number): number | null {
    const { project, cursor } = useEditor.getState()
    const W = project.settings.width
    const H = project.settings.height
    const ev = project.events.find((e) => e.id === eventId)
    const media = ev && !ev.text && ev.start <= cursor && cursor < eventEnd(ev) ? mediaById(ev.mediaId) : undefined
    if (ev && media?.width && media.height) {
      const src = sourceTime(ev, cursor)
      const [px, py] = sourceToOutput(panCropAt(ev.panCrop, src), media.width, media.height, W, H).inverse(x, y)
      if (px >= 0 && py >= 0 && px < media.width && py < media.height) {
        if (media.kind === 'image') {
          const bitmap = imageAt(media.id, flicksToSeconds(src))
          const color = bitmap ? averageColor(bitmap, px, py) : null
          if (color !== null) return color
        } else {
          // The element may play a proxy, smaller than the file.
          const el = this.videos.get(ev.id)?.el
          if (el && el.readyState >= 2 && el.videoWidth) {
            const k = el.videoWidth / media.width
            const color = averageColor(el, px * k, py * k)
            if (color !== null) return color
          }
        }
      }
    }
    if (!this.canvas) return null
    const k = this.canvas.width / W
    return averageColor(this.canvas, x * k, y * k)
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

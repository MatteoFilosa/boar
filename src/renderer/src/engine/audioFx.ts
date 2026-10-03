import {
  GtcrnWorkletNode,
  RnnoiseWorkletNode,
  SpeexWorkletNode,
  loadGtcrn,
  loadRnnoise,
  loadSpeex
} from '@sapphi-red/web-noise-suppressor'
import gtcrnWorkletSource from '@sapphi-red/web-noise-suppressor/gtcrnWorklet.js?raw'
import rnnoiseWorkletSource from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?raw'
import speexWorkletSource from '@sapphi-red/web-noise-suppressor/speexWorklet.js?raw'
import gtcrnWasm from '@sapphi-red/web-noise-suppressor/gtcrn.wasm?url'
import rnnoiseWasm from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url'
import rnnoiseSimdWasm from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url'
import speexWasm from '@sapphi-red/web-noise-suppressor/speex.wasm?url'
import { EQ_BANDS, type EventFx, activeFx, fxParam } from '../core/fx'

// Audio FX as Web Audio node chains, built the same way in the preview
// (AudioContext) and the export (OfflineAudioContext). Noise reduction runs
// GTCRN / RNNoise / Speex in WebAssembly (web-noise-suppressor).

const dbToGain = (db: number): number => Math.pow(10, db / 20)

// Worklets

/** Our own processors: a smooth noise gate and a delay-line pitch shifter. */
const CUSTOM_WORKLETS = `
class NoiseGateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -45 },
      { name: 'range', defaultValue: -60 },
      { name: 'attack', defaultValue: 2 },
      { name: 'release', defaultValue: 150 }
    ]
  }
  constructor() { super(); this.env = 0; this.gain = 0; this.hold = 0 }
  process(inputs, outputs, p) {
    const input = inputs[0], output = outputs[0]
    if (!input || input.length === 0) return true
    const n = input[0].length
    const thr = Math.pow(10, p.threshold[0] / 20)
    const floor = Math.pow(10, p.range[0] / 20)
    const att = Math.exp(-1 / (sampleRate * Math.max(0.0001, p.attack[0] / 1000)))
    const rel = Math.exp(-1 / (sampleRate * Math.max(0.001, p.release[0] / 1000)))
    const envRel = Math.exp(-1 / (sampleRate * 0.02))
    const holdSamples = sampleRate * 0.04
    for (let i = 0; i < n; i++) {
      let peak = 0
      for (let c = 0; c < input.length; c++) { const v = Math.abs(input[c][i]); if (v > peak) peak = v }
      this.env = peak > this.env ? peak : this.env * envRel + peak * (1 - envRel)
      if (this.env >= thr) this.hold = holdSamples
      else if (this.hold > 0) this.hold--
      const target = this.hold > 0 ? 1 : floor
      const coef = target > this.gain ? att : rel
      this.gain = target + (this.gain - target) * coef
      for (let c = 0; c < output.length; c++) output[c][i] = (input[c] || input[0])[i] * this.gain
    }
    return true
  }
}
registerProcessor('boar-gate', NoiseGateProcessor)

class PitchShiftProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'ratio', defaultValue: 1, minValue: 0.25, maxValue: 4 }] }
  constructor() {
    super()
    this.window = Math.round(sampleRate * 0.05)
    this.length = this.window * 2 + 4
    this.buffers = []
    this.write = 0
    this.phase = 0
  }
  read(buf, delay) {
    let pos = this.write - delay
    while (pos < 0) pos += this.length
    const i = Math.floor(pos), f = pos - i
    const a = buf[i % this.length], b = buf[(i + 1) % this.length]
    return a + (b - a) * f
  }
  process(inputs, outputs, p) {
    const input = inputs[0], output = outputs[0]
    if (!input || input.length === 0) return true
    while (this.buffers.length < input.length) this.buffers.push(new Float32Array(this.length))
    const W = this.window
    for (let i = 0; i < input[0].length; i++) {
      const ratio = p.ratio.length > 1 ? p.ratio[i] : p.ratio[0]
      this.phase += (1 - ratio) / W
      this.phase -= Math.floor(this.phase)
      const p2 = (this.phase + 0.5) % 1
      const g1 = Math.sin(Math.PI * this.phase) ** 2
      const g2 = 1 - g1
      for (let c = 0; c < input.length; c++) {
        const buf = this.buffers[c]
        buf[this.write] = input[c][i]
        if (output[c]) output[c][i] = this.read(buf, this.phase * W + 1) * g1 + this.read(buf, p2 * W + 1) * g2
      }
      this.write = (this.write + 1) % this.length
    }
    return true
  }
}
registerProcessor('boar-pitch', PitchShiftProcessor)
`

const blobUrl = (source: string): string => URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
let moduleUrls: string[] | null = null

interface Binaries {
  gtcrn: ArrayBuffer
  rnnoise: ArrayBuffer
  speex: ArrayBuffer
}
let binaries: Promise<Binaries> | null = null
let loadedBinaries: Binaries | null = null

const prepared = new WeakMap<BaseAudioContext, Promise<void>>()
const ready = new WeakSet<BaseAudioContext>()

/** Loads the worklet processors and the noise reduction models into a context (once). */
export function prepareAudioFx(ctx: BaseAudioContext): Promise<void> {
  let pending = prepared.get(ctx)
  if (!pending) {
    pending = (async () => {
      // Worklets load from blob URLs and the models are inlined as data URLs in builds
      // (see electron.vite.config.ts): no file:// fetches in the packaged app.
      moduleUrls ??= [CUSTOM_WORKLETS, gtcrnWorkletSource, rnnoiseWorkletSource, speexWorkletSource].map(blobUrl)
      binaries ??= Promise.all([
        loadGtcrn({ url: gtcrnWasm }),
        loadRnnoise({ url: rnnoiseWasm, simdUrl: rnnoiseSimdWasm }),
        loadSpeex({ url: speexWasm })
      ]).then(([gtcrn, rnnoise, speex]) => (loadedBinaries = { gtcrn, rnnoise, speex }))
      await Promise.all([...moduleUrls.map((url) => ctx.audioWorklet.addModule(url)), binaries])
      ready.add(ctx)
    })().catch((err: unknown) => {
      console.error('[audioFx] cannot load the worklets:', err)
    })
    prepared.set(ctx, pending)
  }
  return pending
}

// Units

interface Unit {
  input: AudioNode
  output: AudioNode
  update(fx: EventFx): void
  dispose(): void
  /** Runs asynchronous setup inside the audio thread (offline renders wait for it). */
  warmup?: boolean
}

type Setter = (param: AudioParam, value: number) => void

function passthrough(ctx: BaseAudioContext): Unit {
  const node = ctx.createGain()
  return { input: node, output: node, update: () => undefined, dispose: () => node.disconnect() }
}

/** Dry/wet pair: input -> dry -> output and wet -> output. */
function mixer(ctx: BaseAudioContext): { input: GainNode; output: GainNode; dry: GainNode; wet: GainNode } {
  const input = ctx.createGain()
  const output = ctx.createGain()
  const dry = ctx.createGain()
  const wet = ctx.createGain()
  input.connect(dry)
  dry.connect(output)
  wet.connect(output)
  return { input, output, dry, wet }
}

function disconnectAll(nodes: AudioNode[]): void {
  for (const n of nodes) n.disconnect()
}

function gainUnit(ctx: BaseAudioContext, set: Setter): Unit {
  const input = ctx.createGain()
  const output = ctx.createGain()
  const stereo = ctx.createGain()
  const mono = ctx.createGain()
  mono.channelCount = 1
  mono.channelCountMode = 'explicit'
  mono.channelInterpretation = 'speakers'
  input.connect(stereo)
  stereo.connect(output)
  input.connect(mono)
  mono.connect(output)
  return {
    input,
    output,
    update: (fx) => {
      const isMono = Math.round(fxParam(fx, 'mode')) === 1
      set(stereo.gain, isMono ? 0 : 1)
      set(mono.gain, isMono ? 1 : 0)
      set(output.gain, dbToGain(fxParam(fx, 'gain')))
    },
    dispose: () => disconnectAll([input, output, stereo, mono])
  }
}

const FILTER_TYPES: BiquadFilterType[] = ['highpass', 'lowpass', 'bandpass', 'notch']

function filterUnit(ctx: BaseAudioContext, set: Setter): Unit {
  const f = ctx.createBiquadFilter()
  return {
    input: f,
    output: f,
    update: (fx) => {
      f.type = FILTER_TYPES[Math.round(fxParam(fx, 'mode'))] ?? 'highpass'
      set(f.frequency, fxParam(fx, 'frequency'))
      set(f.Q, fxParam(fx, 'q'))
    },
    dispose: () => f.disconnect()
  }
}

function eqUnit(ctx: BaseAudioContext, set: Setter): Unit {
  const bands = EQ_BANDS.map((freq, i) => {
    const b = ctx.createBiquadFilter()
    b.type = i === 0 ? 'lowshelf' : i === EQ_BANDS.length - 1 ? 'highshelf' : 'peaking'
    b.frequency.value = freq
    b.Q.value = 1.4
    return b
  })
  const output = ctx.createGain()
  for (let i = 0; i < bands.length - 1; i++) bands[i].connect(bands[i + 1])
  bands[bands.length - 1].connect(output)
  return {
    input: bands[0],
    output,
    update: (fx) => {
      EQ_BANDS.forEach((freq, i) => set(bands[i].gain, fxParam(fx, `b${freq}`)))
      set(output.gain, dbToGain(fxParam(fx, 'output')))
    },
    dispose: () => disconnectAll([...bands, output])
  }
}

function compressorUnit(ctx: BaseAudioContext, set: Setter): Unit {
  const comp = ctx.createDynamicsCompressor()
  const makeup = ctx.createGain()
  comp.connect(makeup)
  return {
    input: comp,
    output: makeup,
    update: (fx) => {
      set(comp.threshold, fxParam(fx, 'threshold'))
      set(comp.ratio, Math.min(20, fxParam(fx, 'ratio')))
      set(comp.attack, fxParam(fx, 'attack') / 1000)
      set(comp.release, fxParam(fx, 'release') / 1000)
      set(comp.knee, fxParam(fx, 'knee'))
      set(makeup.gain, dbToGain(fxParam(fx, 'makeup')))
    },
    dispose: () => disconnectAll([comp, makeup])
  }
}

function gateUnit(ctx: BaseAudioContext, set: Setter): Unit {
  if (!ready.has(ctx)) return passthrough(ctx)
  const node = new AudioWorkletNode(ctx, 'boar-gate')
  const param = (name: string): AudioParam => node.parameters.get(name) as AudioParam
  return {
    input: node,
    output: node,
    update: (fx) => {
      set(param('threshold'), fxParam(fx, 'threshold'))
      set(param('range'), fxParam(fx, 'range'))
      set(param('attack'), fxParam(fx, 'attack'))
      set(param('release'), fxParam(fx, 'release'))
    },
    dispose: () => node.disconnect()
  }
}

function pitchUnit(ctx: BaseAudioContext, set: Setter): Unit {
  if (!ready.has(ctx)) return passthrough(ctx)
  const node = new AudioWorkletNode(ctx, 'boar-pitch')
  const ratio = node.parameters.get('ratio') as AudioParam
  return {
    input: node,
    output: node,
    update: (fx) => set(ratio, Math.pow(2, fxParam(fx, 'semitones') / 12)),
    dispose: () => node.disconnect()
  }
}

/** Samples of delay the GTCRN and RNNoise worklets add (frame buffering at 48 kHz). */
const SUPPRESSOR_LATENCY = 640

function noiseUnit(ctx: BaseAudioContext, set: Setter, algorithm: number): Unit {
  const bins = loadedBinaries
  // The neural models are trained at 48 kHz; other rates pass through untouched.
  if (!ready.has(ctx) || !bins || ctx.sampleRate !== 48000) return passthrough(ctx)
  const audioCtx = ctx as AudioContext
  const node =
    algorithm === 1
      ? new RnnoiseWorkletNode(audioCtx, { wasmBinary: bins.rnnoise, maxChannels: 1 })
      : algorithm === 2
        ? new SpeexWorkletNode(audioCtx, { wasmBinary: bins.speex, maxChannels: 1 })
        : new GtcrnWorkletNode(audioCtx, { wasmBinary: bins.gtcrn, maxChannels: 1 })
  // Voice is processed in mono: half the CPU, same result for speech.
  node.channelCount = 1
  node.channelCountMode = 'explicit'
  node.channelInterpretation = 'speakers'
  const m = mixer(ctx)
  // The dry signal is delayed like the processed one so mixing them never combs.
  m.input.disconnect()
  const align = ctx.createDelay(0.1)
  align.delayTime.value = algorithm === 2 ? 0 : SUPPRESSOR_LATENCY / ctx.sampleRate
  m.input.connect(align)
  align.connect(m.dry)
  m.input.connect(node)
  node.connect(m.wet)
  return {
    input: m.input,
    output: m.output,
    warmup: true,
    update: (fx) => {
      const amount = fxParam(fx, 'amount')
      set(m.wet.gain, amount)
      set(m.dry.gain, 1 - amount)
    },
    dispose: () => {
      node.destroy()
      disconnectAll([node, align, m.input, m.output, m.dry, m.wet])
    }
  }
}

/** Deterministic noise so the preview and the export get the same reverb. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function impulseResponse(ctx: BaseAudioContext, decay: number, preDelayMs: number, damping: number): AudioBuffer {
  const rate = ctx.sampleRate
  const pre = Math.round((preDelayMs / 1000) * rate)
  const tail = Math.round(Math.min(10, Math.max(0.1, decay)) * rate)
  const buffer = ctx.createBuffer(2, pre + tail, rate)
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c)
    const random = seeded(1234 + c * 977)
    let low = 0
    for (let i = 0; i < tail; i++) {
      const t = i / tail
      const noise = random() * 2 - 1
      // Higher damping: the tail loses its highs faster (a one-pole lowpass closing over time).
      const k = 1 - Math.min(0.97, damping * t * 1.1)
      low += k * (noise - low)
      data[pre + i] = low * Math.exp((-6.9 * i) / tail)
    }
  }
  return buffer
}

function reverbUnit(ctx: BaseAudioContext, set: Setter): Unit {
  const m = mixer(ctx)
  const conv = ctx.createConvolver()
  m.input.connect(conv)
  conv.connect(m.wet)
  let irKey = ''
  return {
    input: m.input,
    output: m.output,
    update: (fx) => {
      const decay = fxParam(fx, 'decay')
      const preDelay = fxParam(fx, 'preDelay')
      const damping = fxParam(fx, 'damping')
      const key = `${decay}|${preDelay}|${damping}`
      if (key !== irKey) {
        irKey = key
        conv.buffer = impulseResponse(ctx, decay, preDelay, damping)
      }
      const mix = fxParam(fx, 'mix')
      set(m.dry.gain, 1 - mix * 0.5)
      set(m.wet.gain, mix)
    },
    dispose: () => disconnectAll([conv, m.input, m.output, m.dry, m.wet])
  }
}

function echoUnit(ctx: BaseAudioContext, set: Setter): Unit {
  const m = mixer(ctx)
  const delay = ctx.createDelay(2.5)
  const feedback = ctx.createGain()
  m.input.connect(delay)
  delay.connect(feedback)
  feedback.connect(delay)
  delay.connect(m.wet)
  return {
    input: m.input,
    output: m.output,
    update: (fx) => {
      set(delay.delayTime, fxParam(fx, 'time') / 1000)
      set(feedback.gain, Math.min(0.95, fxParam(fx, 'feedback')))
      const mix = fxParam(fx, 'mix')
      set(m.dry.gain, 1 - mix * 0.5)
      set(m.wet.gain, mix)
    },
    dispose: () => disconnectAll([delay, feedback, m.input, m.output, m.dry, m.wet])
  }
}

function chorusUnit(ctx: BaseAudioContext, set: Setter): Unit {
  const m = mixer(ctx)
  const delay = ctx.createDelay(0.1)
  const feedback = ctx.createGain()
  const lfo = ctx.createOscillator()
  const depth = ctx.createGain()
  lfo.connect(depth)
  depth.connect(delay.delayTime)
  m.input.connect(delay)
  delay.connect(feedback)
  feedback.connect(delay)
  delay.connect(m.wet)
  lfo.start()
  return {
    input: m.input,
    output: m.output,
    update: (fx) => {
      const base = fxParam(fx, 'delay') / 1000
      set(delay.delayTime, base)
      set(depth.gain, fxParam(fx, 'depth') * base * 0.9)
      set(lfo.frequency, fxParam(fx, 'rate'))
      set(feedback.gain, fxParam(fx, 'feedback'))
      const mix = fxParam(fx, 'mix')
      set(m.dry.gain, 1 - mix * 0.5)
      set(m.wet.gain, mix)
    },
    dispose: () => {
      lfo.stop()
      disconnectAll([lfo, depth, delay, feedback, m.input, m.output, m.dry, m.wet])
    }
  }
}

function driveCurve(drive: number): Float32Array<ArrayBuffer> {
  const k = drive * 60
  const n = 2048
  const curve = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x))
  }
  return curve
}

function distortionUnit(ctx: BaseAudioContext, set: Setter): Unit {
  const m = mixer(ctx)
  const shaper = ctx.createWaveShaper()
  shaper.oversample = '4x'
  const tone = ctx.createBiquadFilter()
  tone.type = 'lowpass'
  const makeup = ctx.createGain()
  m.input.connect(shaper)
  shaper.connect(tone)
  tone.connect(makeup)
  makeup.connect(m.wet)
  let lastDrive = -1
  return {
    input: m.input,
    output: m.output,
    update: (fx) => {
      const drive = fxParam(fx, 'drive')
      if (drive !== lastDrive) {
        lastDrive = drive
        shaper.curve = driveCurve(drive)
      }
      set(tone.frequency, fxParam(fx, 'tone'))
      set(makeup.gain, 1 - drive * 0.45)
      const mix = fxParam(fx, 'mix')
      set(m.dry.gain, 1 - mix)
      set(m.wet.gain, mix)
    },
    dispose: () => disconnectAll([shaper, tone, makeup, m.input, m.output, m.dry, m.wet])
  }
}

const LOFI = [
  { hp: 400, lp: 3200, peak: 1500, boost: 4, drive: 0.25 },
  { hp: 500, lp: 4200, peak: 2000, boost: 6, drive: 0.45 },
  { hp: 700, lp: 5000, peak: 1800, boost: 9, drive: 0.8 }
]

function lofiUnit(ctx: BaseAudioContext, set: Setter): Unit {
  const m = mixer(ctx)
  const hp = ctx.createBiquadFilter()
  hp.type = 'highpass'
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  const peak = ctx.createBiquadFilter()
  peak.type = 'peaking'
  peak.Q.value = 1.2
  const shaper = ctx.createWaveShaper()
  const makeup = ctx.createGain()
  m.input.connect(hp)
  hp.connect(lp)
  lp.connect(peak)
  peak.connect(shaper)
  shaper.connect(makeup)
  makeup.connect(m.wet)
  let lastMode = -1
  return {
    input: m.input,
    output: m.output,
    update: (fx) => {
      const mode = Math.max(0, Math.min(LOFI.length - 1, Math.round(fxParam(fx, 'mode'))))
      const p = LOFI[mode]
      set(hp.frequency, p.hp)
      set(lp.frequency, p.lp)
      set(peak.frequency, p.peak)
      set(peak.gain, p.boost)
      if (mode !== lastMode) {
        lastMode = mode
        shaper.curve = driveCurve(p.drive)
      }
      set(makeup.gain, 1.4 - p.drive * 0.5)
      const mix = fxParam(fx, 'mix')
      set(m.dry.gain, 1 - mix)
      set(m.wet.gain, mix)
    },
    dispose: () => disconnectAll([hp, lp, peak, shaper, makeup, m.input, m.output, m.dry, m.wet])
  }
}

function makeUnit(ctx: BaseAudioContext, fx: EventFx, set: Setter): Unit {
  switch (fx.type) {
    case 'gain':
      return gainUnit(ctx, set)
    case 'filter':
      return filterUnit(ctx, set)
    case 'graphicEq':
      return eqUnit(ctx, set)
    case 'compressor':
      return compressorUnit(ctx, set)
    case 'noiseGate':
      return gateUnit(ctx, set)
    case 'noiseReduction':
      return noiseUnit(ctx, set, Math.round(fxParam(fx, 'algorithm')))
    case 'reverb':
      return reverbUnit(ctx, set)
    case 'echo':
      return echoUnit(ctx, set)
    case 'chorus':
      return chorusUnit(ctx, set)
    case 'pitchShift':
      return pitchUnit(ctx, set)
    case 'distortion':
      return distortionUnit(ctx, set)
    case 'lofiVoice':
      return lofiUnit(ctx, set)
    default:
      return passthrough(ctx)
  }
}

// Chains

export interface AudioFxChain {
  input: AudioNode
  output: AudioNode
  /** True when an effect initializes asynchronously in the audio thread (offline renders wait). */
  warmup: boolean
  update(fx: readonly EventFx[]): void
  dispose(): void
}

/**
 * Identifies the node structure of a chain: when it changes the chain must be
 * rebuilt; otherwise update() only moves parameters. Empty = no audio FX.
 */
export function audioFxKey(ctx: BaseAudioContext, fx: readonly EventFx[] | undefined): string {
  const active = activeFx(fx, 'audio')
  if (active.length === 0) return ''
  const parts = active.map((f) => (f.type === 'noiseReduction' ? `${f.id}:${f.type}:${Math.round(fxParam(f, 'algorithm'))}` : `${f.id}:${f.type}`))
  return `${ready.has(ctx) ? '' : '~'}${parts.join('|')}`
}

export function buildAudioFxChain(ctx: BaseAudioContext, fx: readonly EventFx[]): AudioFxChain | null {
  const active = activeFx(fx, 'audio')
  if (active.length === 0) return null
  // Live changes glide (no zipper noise); the first values are set directly.
  let initial = true
  const live = ctx instanceof AudioContext
  const set: Setter = (param, value) => {
    if (!Number.isFinite(value)) return
    if (initial || !live) param.value = value
    else param.setTargetAtTime(value, ctx.currentTime, 0.015)
  }
  const units = active.map((f) => ({ id: f.id, unit: makeUnit(ctx, f, set) }))
  for (let i = 0; i < units.length - 1; i++) units[i].unit.output.connect(units[i + 1].unit.input)
  const update = (list: readonly EventFx[]): void => {
    for (const f of list) units.find((u) => u.id === f.id)?.unit.update(f)
  }
  update(active)
  initial = false
  return {
    input: units[0].unit.input,
    output: units[units.length - 1].unit.output,
    warmup: units.some((u) => u.unit.warmup),
    update,
    dispose: () => {
      for (const u of units) u.unit.dispose()
    }
  }
}

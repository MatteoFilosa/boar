import { app, ipcMain, net, type WebContents } from 'electron'
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'

// Speech to text with whisper.cpp, bundled with the app (resources/whisper):
// on the GPU through Vulkan (Windows, Linux) or Metal (macOS), on the CPU
// otherwise. The renderer decodes the sound and streams it here as 16 kHz
// mono WAV; nothing else needs to be installed.

export interface WhisperModel {
  id: string
  file: string
  sizeMB: number
  note: string
  /** Alignment heads for word timings (whisper.cpp's DTW presets). */
  dtw: string
}

export const WHISPER_MODELS: WhisperModel[] = [
  { id: 'base', file: 'ggml-base.bin', sizeMB: 148, note: 'Fast, decent quality', dtw: 'base' },
  { id: 'small', file: 'ggml-small.bin', sizeMB: 488, note: 'Good balance', dtw: 'small' },
  { id: 'large-v3-turbo', file: 'ggml-large-v3-turbo.bin', sizeMB: 1624, note: 'Best quality', dtw: 'large.v3.turbo' }
]

const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/'

const modelsDir = (): string => join(app.getPath('userData'), 'models')

const engineDir = (): string => (app.isPackaged ? join(process.resourcesPath, 'whisper') : join(app.getAppPath(), 'resources', 'whisper'))

/** The whisper.cpp tool: next to the app's resources when packaged, in resources/whisper while developing. */
export function whisperPath(): string {
  return join(engineDir(), process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli')
}

/** Voice activity detection model shipped with the engine (see scripts/build-whisper.sh). */
const vadModel = (): string => join(engineDir(), 'ggml-silero-v6.2.0.bin')

/** True when the bundled tool starts (the smoke test checks it too). */
export function whisperRuns(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!existsSync(whisperPath())) return resolve(false)
    const child = spawn(whisperPath(), ['--help'], { windowsHide: true })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
}

async function status(): Promise<{ engine: boolean; models: (WhisperModel & { installed: boolean })[] }> {
  const models = WHISPER_MODELS.map((m) => ({ ...m, installed: existsSync(join(modelsDir(), m.file)) }))
  return { engine: existsSync(whisperPath()), models }
}

async function download(id: string, sender: WebContents): Promise<void> {
  const model = WHISPER_MODELS.find((m) => m.id === id)
  if (!model) throw new Error(`Unknown model ${id}`)
  await mkdir(modelsDir(), { recursive: true })
  const target = join(modelsDir(), model.file)
  const partial = `${target}.part`
  const response = await net.fetch(MODEL_URL + model.file)
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status})`)
  const total = Number(response.headers.get('content-length')) || model.sizeMB * 1024 * 1024
  const file = createWriteStream(partial)
  const reader = response.body.getReader()
  let received = 0
  let lastReport = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (!file.write(value)) await new Promise<void>((resolve) => file.once('drain', () => resolve()))
      if (received - lastReport > 2 * 1024 * 1024) {
        lastReport = received
        sender.send('captions:progress', { phase: 'download', progress: received / total })
      }
    }
    await new Promise<void>((resolve, reject) => file.end((err?: Error | null) => (err ? reject(err) : resolve())))
    await rename(partial, target)
  } catch (err) {
    file.destroy()
    await rm(partial, { force: true })
    throw err
  }
}

interface TranscribeRequest {
  model: string
  language: string
  /** Number of 16 kHz mono samples the renderer will send. */
  samples: number
}

/** A piece of transcript, times in seconds from the start of the sent audio. */
export interface TranscriptPiece {
  start: number
  end: number
  text: string
}

export interface Transcript {
  /** Phrases with proper spacing. */
  segments: TranscriptPiece[]
  /** The same text split into tokens (often parts of words) with their own times. */
  tokens: TranscriptPiece[]
}

interface Job {
  child: ChildProcessWithoutNullStreams
  output: string
  done: Promise<number>
  log: string
  /** Speech segments found by voice activity detection (seconds), from the engine's log. */
  vad: [number, number][]
  /** Start of a log line not finished yet. */
  partial: string
}

/** The engine joins the speech segments with this much in between (0.1 s overlap + 0.1 s silence). */
const VAD_JOIN = 0.2

/**
 * Real time of a token time on the speech-only clock: with voice activity
 * detection the engine transcribes only the speech segments, joined, and maps
 * the phrases back but not their tokens. Null when the log had no segments.
 */
function vadClock(vad: [number, number][]): ((t: number) => number) | null {
  if (vad.length === 0) return null
  const joined: number[] = []
  let at = 0
  for (const [start, end] of vad) {
    joined.push(at)
    at += end - start + VAD_JOIN
  }
  return (t) => {
    let k = 0
    while (k + 1 < joined.length && t >= joined[k + 1]) k++
    const [start, end] = vad[k]
    const into = t - joined[k]
    // In the silence between two segments: the next one starts there.
    if (into > end - start + VAD_JOIN / 2 && k + 1 < vad.length) return vad[k + 1][0]
    return start + into
  }
}

const jobs = new Map<number, Job>()
let nextJob = 1

/** 44-byte header of a 16-bit 16 kHz mono WAV holding `samples` samples. */
function wavHeader(samples: number): Buffer {
  const data = samples * 2
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + data, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(16000, 24)
  h.writeUInt32LE(32000, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(data, 40)
  return h
}

/** Starts whisper.cpp reading WAV from stdin; the renderer then sends the audio. */
async function start(req: TranscribeRequest, sender: WebContents): Promise<number> {
  const model = WHISPER_MODELS.find((m) => m.id === req.model)
  if (!model) throw new Error(`Unknown model ${req.model}`)
  const modelFile = join(modelsDir(), model.file)
  if (!existsSync(modelFile)) throw new Error('Model not downloaded')
  if (!existsSync(whisperPath())) throw new Error('The speech engine is missing from this build of Boar')
  const language = /^[a-z]{2,3}$|^auto$/.test(req.language) ? req.language : 'auto'
  const tmp = join(app.getPath('userData'), 'tmp')
  await mkdir(tmp, { recursive: true })
  const id = nextJob++
  const output = join(tmp, `captions-${Date.now()}-${id}`)
  const threads = Math.max(1, Math.min(8, availableParallelism() - 1))
  // No -np: the log lists the speech segments, needed to place the words (see vadClock).
  const args = ['-m', modelFile, '-f', '-', '-l', language, '-t', String(threads), '-ojf', '-of', output, '-pp']
  // Only the parts with speech are transcribed: no made-up text over music or silence, and faster.
  if (existsSync(vadModel())) args.push('--vad', '-vm', vadModel())
  const child = spawn(whisperPath(), args, { windowsHide: true })
  const job: Job = { child, output: `${output}.json`, log: '', done: Promise.resolve(0), vad: [], partial: '' }
  job.done = new Promise<number>((resolve) => {
    child.on('error', (err) => {
      job.log += String(err)
      resolve(-1)
    })
    child.on('close', (code) => resolve(code ?? -1))
  })
  child.stderr.on('data', (data: Buffer) => {
    const text = data.toString()
    job.log = (job.log + text).slice(-4000)
    const progress = /progress =\s*(\d+)%/g
    let match: RegExpExecArray | null
    let last = -1
    while ((match = progress.exec(text))) last = Number(match[1])
    if (last >= 0) sender.send('captions:progress', { phase: 'transcribe', progress: last / 100 })
    const lines = (job.partial + text).split(/\r?\n/)
    job.partial = lines.pop() ?? ''
    for (const line of lines) {
      const segment = /VAD segment \d+: start = ([\d.]+), end = ([\d.]+)/.exec(line)
      if (segment) job.vad.push([Number(segment[1]), Number(segment[2])])
    }
  })
  // Results go to the JSON file; the console text is not needed.
  child.stdout.resume()
  child.stdin.on('error', () => undefined)
  child.stdin.write(wavHeader(req.samples))
  jobs.set(id, job)
  return id
}

async function sendAudio(id: number, data: Uint8Array): Promise<void> {
  const job = jobs.get(id)
  if (!job) throw new Error('Transcription is not running')
  if (!job.child.stdin.write(data)) await new Promise<void>((resolve) => job.child.stdin.once('drain', () => resolve()))
}

/**
 * The speech-segment clock, if it agrees with the phrase times the engine
 * reports (it would not if a new engine version joined segments differently).
 */
function trustedClock(clock: ((t: number) => number) | null, json: WhisperJson): ((t: number) => number) | null {
  if (!clock) return null
  const errors: number[] = []
  for (const s of json.transcription ?? []) {
    const first = (s.tokens ?? []).find((t) => !isSpecial(t.text) && t.text.trim())
    if (first) errors.push(Math.abs(clock(first.offsets.from / 1000) - s.offsets.from / 1000))
  }
  if (errors.length === 0) return null
  errors.sort((a, b) => a - b)
  return errors[Math.floor(errors.length / 2)] < 0.3 ? clock : null
}

/** Special tokens ([_BEG_], [_TT_150], <|en|>) carry no text. */
const isSpecial = (text: string): boolean => /^\s*(\[_[A-Z]+_?\d*\]|<\|.*\|>)\s*$/.test(text)

interface WhisperJson {
  transcription?: {
    offsets: { from: number; to: number }
    text: string
    tokens?: { text: string; offsets: { from: number; to: number } }[]
  }[]
}

async function finish(id: number): Promise<Transcript> {
  const job = jobs.get(id)
  if (!job) throw new Error('Transcription is not running')
  job.child.stdin.end()
  const code = await job.done
  jobs.delete(id)
  try {
    if (code !== 0) {
      console.error(`[captions] whisper.cpp failed (${code}):\n${job.log}`)
      throw new Error('The speech engine could not transcribe this audio (see the console for details)')
    }
    const json = JSON.parse(await readFile(job.output, 'utf8')) as WhisperJson
    const segments: TranscriptPiece[] = []
    const tokens: TranscriptPiece[] = []
    const realTime = trustedClock(vadClock(job.vad), json)
    for (const s of json.transcription ?? []) {
      const text = s.text.trim()
      if (!text) continue
      const start = s.offsets.from / 1000
      const end = s.offsets.to / 1000
      segments.push({ start, end, text })
      const words = (s.tokens ?? []).filter((t) => !isSpecial(t.text) && t.text.trim())
      if (words.length === 0) continue
      if (realTime) {
        for (const t of words) {
          tokens.push({ start: realTime(t.offsets.from / 1000), end: realTime(t.offsets.to / 1000), text: t.text.trim() })
        }
        continue
      }
      // Without the segment list: whisper.cpp gives the phrases their real
      // times but leaves the tokens on the speech-only clock (pauses removed),
      // so they drift earlier and earlier. Each phrase's tokens are laid back
      // over the phrase; without the drift this changes nothing.
      const from = words[0].offsets.from / 1000
      const to = Math.max(from, ...words.map((t) => t.offsets.to / 1000))
      const scale = to > from ? (end - start) / (to - from) : 1
      const place = (x: number): number => Math.min(end, Math.max(start, start + (x / 1000 - from) * scale))
      for (const t of words) tokens.push({ start: place(t.offsets.from), end: place(t.offsets.to), text: t.text.trim() })
    }
    return { segments, tokens }
  } finally {
    await rm(job.output, { force: true })
  }
}

function cancel(id: number): void {
  const job = jobs.get(id)
  if (!job) return
  jobs.delete(id)
  job.child.kill()
  void job.done.then(() => rm(job.output, { force: true }))
}

export function registerCaptionIpc(): void {
  ipcMain.handle('captions:status', () => status())
  ipcMain.handle('captions:download', (event, id: string) => download(id, event.sender))
  ipcMain.handle('captions:start', (event, req: TranscribeRequest) => start(req, event.sender))
  ipcMain.handle('captions:audio', (_event, id: number, data: Uint8Array) => sendAudio(id, data))
  ipcMain.handle('captions:finish', (_event, id: number) => finish(id))
  ipcMain.handle('captions:cancel', (_event, id: number) => cancel(id))
}

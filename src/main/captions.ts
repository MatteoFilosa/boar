import { app, ipcMain, net, type WebContents } from 'electron'
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

// Speech to text with FFmpeg's `whisper` filter (FFmpeg 8+ built with whisper.cpp).

export interface WhisperModel {
  id: string
  file: string
  sizeMB: number
  note: string
}

export const WHISPER_MODELS: WhisperModel[] = [
  { id: 'base', file: 'ggml-base.bin', sizeMB: 148, note: 'Fast, decent quality' },
  { id: 'small', file: 'ggml-small.bin', sizeMB: 488, note: 'Good balance' },
  { id: 'large-v3-turbo', file: 'ggml-large-v3-turbo.bin', sizeMB: 1624, note: 'Best quality, slower on CPU' }
]

const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/'

const modelsDir = (): string => join(app.getPath('userData'), 'models')

function run(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let out = ''
    const child = spawn(cmd, args, { windowsHide: true })
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('error', () => resolve({ code: -1, out }))
    child.on('close', (code) => resolve({ code: code ?? -1, out }))
  })
}

async function status(): Promise<{ ffmpeg: boolean; whisper: boolean; models: (WhisperModel & { installed: boolean })[] }> {
  const filters = await run('ffmpeg', ['-hide_banner', '-filters'])
  const models = await Promise.all(
    WHISPER_MODELS.map(async (m) => ({ ...m, installed: existsSync(join(modelsDir(), m.file)) }))
  )
  return { ffmpeg: filters.code === 0, whisper: /\bwhisper\b/.test(filters.out), models }
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
  path: string
  /** Seconds into the file where the event starts, and its length. */
  start: number
  duration: number
  model: string
  language: string
}

/** A piece of transcript, times in seconds from the start of the transcribed range. */
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

/** The whisper filter's JSON output: one {"start","end","text"} object per line, times in ms. */
function parsePieces(json: string): TranscriptPiece[] {
  const out: TranscriptPiece[] = []
  for (const line of json.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const p = JSON.parse(line) as { start: number; end: number; text: string }
      if (typeof p.text === 'string' && p.text.trim()) out.push({ start: p.start / 1000, end: p.end / 1000, text: p.text.trim() })
    } catch {
      // Ignore a truncated line.
    }
  }
  return out
}

/**
 * Transcribes a range of a media file. Two whisper passes share one FFmpeg run:
 * one gives phrases (correct word spacing), the other token-level times
 * (max_len=1); the renderer aligns them into per-word timings.
 */
async function transcribe(req: TranscribeRequest, sender: WebContents): Promise<Transcript> {
  const model = WHISPER_MODELS.find((m) => m.id === req.model)
  if (!model) throw new Error(`Unknown model ${req.model}`)
  if (!isAbsolute(req.path) || !(await stat(req.path).catch(() => null))) throw new Error('Media file not found')
  const dir = modelsDir()
  if (!existsSync(join(dir, model.file))) throw new Error('Model not downloaded')
  const language = /^[a-z]{2,3}$|^auto$/.test(req.language) ? req.language : 'auto'
  // FFmpeg runs inside the models folder so filter options only contain plain
  // file names (Windows paths would need filtergraph escaping).
  const stamp = Date.now()
  const segmentsFile = `captions-${stamp}-segments.json`
  const tokensFile = `captions-${stamp}-tokens.json`
  const whisper = (destination: string, maxLen: number): string =>
    [`whisper=model=${model.file}`, `language=${language}`, 'queue=20', `destination=${destination}`, 'format=json', `max_len=${maxLen}`].join(':')
  const graph = [
    `[0:a]aresample=16000,aformat=channel_layouts=mono,asplit[a][b]`,
    `[a]${whisper(segmentsFile, 0)}[outa]`,
    `[b]${whisper(tokensFile, 1)}[outb]`
  ].join(';')
  const args = [
    '-hide_banner',
    '-nostats',
    '-progress',
    'pipe:1',
    '-ss',
    String(Math.max(0, req.start)),
    '-t',
    String(Math.max(0.1, req.duration)),
    '-i',
    req.path,
    '-filter_complex',
    graph,
    '-map',
    '[outa]',
    '-f',
    'null',
    '-',
    '-map',
    '[outb]',
    '-f',
    'null',
    '-'
  ]
  const code = await new Promise<number>((resolve) => {
    const child = spawn('ffmpeg', args, { cwd: dir, windowsHide: true })
    let log = ''
    child.stdout.on('data', (data: Buffer) => {
      const match = /out_time_us=(\d+)/.exec(data.toString())
      if (match) {
        sender.send('captions:progress', {
          phase: 'transcribe',
          progress: Math.min(1, Number(match[1]) / 1e6 / Math.max(0.1, req.duration))
        })
      }
    })
    child.stderr.on('data', (data: Buffer) => (log = (log + data.toString()).slice(-4000)))
    child.on('error', () => resolve(-1))
    child.on('close', (exit) => {
      if (exit !== 0) console.error(`[captions] ffmpeg failed:\n${log}`)
      resolve(exit ?? -1)
    })
  })
  try {
    if (code !== 0) throw new Error('FFmpeg could not transcribe this media (see the console for details)')
    const [segments, tokens] = await Promise.all([
      readFile(join(dir, segmentsFile), 'utf8').then(parsePieces),
      readFile(join(dir, tokensFile), 'utf8').then(parsePieces, () => [])
    ])
    return { segments, tokens }
  } finally {
    await rm(join(dir, segmentsFile), { force: true })
    await rm(join(dir, tokensFile), { force: true })
  }
}

export function registerCaptionIpc(): void {
  ipcMain.handle('captions:status', () => status())
  ipcMain.handle('captions:download', (event, id: string) => download(id, event.sender))
  ipcMain.handle('captions:transcribe', (event, req: TranscribeRequest) => transcribe(req, event.sender))
}

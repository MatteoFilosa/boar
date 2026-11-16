import { app, ipcMain } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { downloadFile } from './download'

// Caption translation runs in the renderer (engine/translate.ts) with
// Opus-MT models: Helsinki-NLP's MarianMT models (CC-BY 4.0) converted to
// ONNX and quantized to 8 bits by Xenova on Hugging Face. One model per
// language pair, downloaded on first use into userData/models/translate, at
// a fixed revision so the files never change under the app.

interface MtModel {
  /** Source and target language, 'it-en'; 'mul' = any language. */
  pair: string
  revision: string
  sizeMB: number
}

export const MT_MODELS: MtModel[] = [
  { pair: 'it-en', revision: 'fd0b89b9c052adc1f2f64152f555aa17353728be', sizeMB: 131 },
  { pair: 'it-fr', revision: '7843e3b7137d19face19cb32e27256888d26fe84', sizeMB: 108 },
  { pair: 'it-es', revision: '0eba27fe6da2208231ea5e7047b0f62241ffc2bb', sizeMB: 107 },
  { pair: 'en-it', revision: '075406e3c8c2c30634d4a1bd8f00c21d9e162011', sizeMB: 130 },
  { pair: 'en-fr', revision: '28726206f80896b90035bd99cccd5cc1e151f916', sizeMB: 108 },
  { pair: 'en-es', revision: '4b002a4c7edd54a7ced58877258b87f7efd3f892', sizeMB: 114 },
  { pair: 'en-de', revision: '1ca130c44c4c5441ef16d48aae521a424ab644f7', sizeMB: 106 },
  { pair: 'fr-en', revision: '6b166a182780e118c997879d0ad5be4b53671644', sizeMB: 108 },
  { pair: 'fr-es', revision: '962338be51033b548c13dbb6f4da3ddb8c8aba0e', sizeMB: 125 },
  { pair: 'es-en', revision: 'eadfd7c658a9d8929ac3b8e996b68a68e2c7d480', sizeMB: 114 },
  { pair: 'es-fr', revision: '3bef5f612825d503f6fb85e0527a1fe30f2578c2', sizeMB: 125 },
  { pair: 'es-it', revision: '596c67cda7cb919f0d67221f3a31bd7df79f19d0', sizeMB: 107 },
  { pair: 'de-en', revision: '399dfd68706739fffd503f876093e455ae268a06', sizeMB: 106 },
  { pair: 'mul-en', revision: '72a05e47cee89c718a9db4dc70d02fef3bc39de8', sizeMB: 113 }
]

/** Files of a model, in download order (the big ones last). */
export const MT_FILES = [
  'config.json',
  'tokenizer_config.json',
  'tokenizer.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx'
]

const modelDir = (pair: string): string => join(app.getPath('userData'), 'models', 'translate', `opus-mt-${pair}`)

const isInstalled = (pair: string): boolean => MT_FILES.every((f) => existsSync(join(modelDir(pair), f)))

function model(pair: unknown): MtModel {
  const found = MT_MODELS.find((m) => m.pair === pair)
  if (!found) throw new Error(`No translation model for ${String(pair)}`)
  return found
}

const downloads = new Map<string, Promise<void>>()

async function download(m: MtModel, progress: (fraction: number) => void): Promise<void> {
  const total = m.sizeMB * 1024 * 1024
  let before = 0
  for (const file of MT_FILES) {
    const target = join(modelDir(m.pair), file)
    if (existsSync(target)) continue
    await mkdir(dirname(target), { recursive: true })
    const url = `https://huggingface.co/Xenova/opus-mt-${m.pair}/resolve/${m.revision}/${file}`
    let last = 0
    await downloadFile(url, target, (received) => {
      last = received
      progress(Math.min(1, (before + received) / total))
    })
    before += last
  }
}

export function registerTranslateIpc(): void {
  ipcMain.handle('translate:status', () => MT_MODELS.map((m) => ({ pair: m.pair, sizeMB: m.sizeMB, installed: isInstalled(m.pair) })))
  ipcMain.handle('translate:download', (event, pair: unknown) => {
    const m = model(pair)
    if (isInstalled(m.pair)) return
    let job = downloads.get(m.pair)
    if (!job) {
      job = download(m, (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send('translate:progress', { pair: m.pair, progress })
      }).finally(() => downloads.delete(m.pair))
      downloads.set(m.pair, job)
    }
    return job
  })
  ipcMain.handle('translate:read', async (_event, pair: unknown, file: unknown) => {
    const m = model(pair)
    if (typeof file !== 'string' || !MT_FILES.includes(file)) throw new Error('Not a model file')
    return new Uint8Array(await readFile(join(modelDir(m.pair), file)))
  })
}

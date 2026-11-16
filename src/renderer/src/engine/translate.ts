import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url'
import { bridge } from '../platform'
import { assetBytes } from '../media/assets'
import { captionTranslations, languageLabel, plainCaption, sentenceGroups, translationRoute } from '../core/translation'
import * as A from '../core/actions'
import { useEditor } from '../core/store'
import { FLICKS_PER_SECOND } from '../core/time'
import { eventEnd } from '../core/timeline'
import type { TranslateModelFiles, TranslateReply, TranslateRequest } from './translate.worker'
import TranslateWorker from './translate.worker?worker&inline'

// Local translation (Translate Captions, MCP translate_captions without
// texts): Opus-MT models downloaded on first use by the main process
// (src/main/translate.ts), run by translate.worker.ts.

export interface TranslateProgress {
  label: string
  /** 0..1 */
  progress: number
}

/** The language pairs there are models for ('it-en', 'mul-en', …). */
export async function translationPairs(): Promise<{ pair: string; installed: boolean; sizeMB: number }[]> {
  return bridge ? bridge.translateStatus() : []
}

/** Megabytes still to download to translate `from` into `to` (0: ready), or null when there is no route. */
export async function downloadNeeded(from: string, to: string): Promise<number | null> {
  const pairs = await translationPairs()
  const route = translationRoute(from, to, pairs.map((p) => p.pair))
  if (!route) return null
  return route.reduce((mb, pair) => mb + (pairs.find((p) => p.pair === pair && !p.installed)?.sizeMB ?? 0), 0)
}

const decoder = new TextDecoder()

async function modelFiles(pair: string): Promise<TranslateModelFiles> {
  const read = (file: string): Promise<Uint8Array> => bridge!.readTranslateModel(pair, file)
  const [config, tokenizer, tokenizerConfig, encoder, decoderModel] = await Promise.all([
    read('config.json'),
    read('tokenizer.json'),
    read('tokenizer_config.json'),
    read('onnx/encoder_model_quantized.onnx'),
    read('onnx/decoder_model_merged_quantized.onnx')
  ])
  return {
    config: decoder.decode(config),
    tokenizer: decoder.decode(tokenizer),
    tokenizerConfig: decoder.decode(tokenizerConfig),
    encoder,
    decoder: decoderModel
  }
}

/**
 * Translates texts from one language into another on this computer,
 * downloading the models first when needed. `signal` stops it.
 */
export async function translateTexts(
  texts: string[],
  from: string,
  to: string,
  onProgress?: (progress: TranslateProgress) => void,
  signal?: AbortSignal
): Promise<string[]> {
  if (!bridge) throw new Error('Translation runs in the desktop app')
  const pairs = await translationPairs()
  const route = translationRoute(from, to, pairs.map((p) => p.pair))
  if (!route) throw new Error(`There is no model to translate ${languageLabel(from)} into ${languageLabel(to)}`)
  if (route.length === 0) return [...texts]
  for (const pair of route) {
    if (pairs.find((p) => p.pair === pair)?.installed) continue
    const label = `Downloading the ${pair} translation model`
    onProgress?.({ label, progress: 0 })
    const off = bridge.onTranslateProgress((p) => {
      if (p.pair === pair) onProgress?.({ label, progress: p.progress })
    })
    try {
      await bridge.downloadTranslateModel(pair)
    } finally {
      off()
    }
    signal?.throwIfAborted()
  }
  onProgress?.({ label: 'Loading the translation model', progress: 0 })
  const [wasm, ...steps] = await Promise.all([assetBytes(wasmUrl), ...route.map(modelFiles)])
  signal?.throwIfAborted()
  const worker = new TranslateWorker()
  try {
    return await new Promise<string[]>((resolve, reject) => {
      const stop = (): void => reject(new DOMException('Translation cancelled', 'AbortError'))
      signal?.addEventListener('abort', stop, { once: true })
      worker.onmessage = (e: MessageEvent<TranslateReply>) => {
        const reply = e.data
        if (reply.kind === 'progress') onProgress?.({ label: `Translating into ${languageLabel(to)}`, progress: reply.progress })
        else if (reply.kind === 'done') resolve(reply.texts)
        else reject(new Error(reply.message))
      }
      worker.onerror = (e) => reject(new Error(e.message || 'The translation stopped'))
      const request: TranslateRequest = { wasm, steps, texts }
      worker.postMessage(request, [wasm.buffer, ...steps.flatMap((s) => [s.encoder.buffer, s.decoder.buffer])])
    })
  } finally {
    worker.terminate()
  }
}

/** The language a caption track was spoken in, from the transcript its words came from (null: not known). */
export function captionLanguage(trackId: string): string | null {
  const { transcripts } = useEditor.getState()
  for (const e of A.captionEvents(trackId)) {
    for (const w of e.text?.words ?? []) {
      const language = w.src ? transcripts[w.src[0]]?.language : undefined
      if (language && /^[a-z]{2,3}$/.test(language)) return language
    }
  }
  return null
}

/** Video tracks holding captions or other text, with how many, top to bottom. */
export function captionTracks(): { id: string; name: string; count: number }[] {
  const { project } = useEditor.getState()
  return project.tracks.flatMap((t, i) => {
    const count = A.captionEvents(t.id).length
    return t.kind === 'video' && count ? [{ id: t.id, name: t.name || `Track ${i + 1}`, count }] : []
  })
}

/**
 * Translate Captions on this computer: the track's captions are read as
 * sentences, translated, and put back one piece per caption on a new track
 * (A.addTranslatedCaptions). Returns how many captions it made.
 */
export async function translateCaptionTrack(
  trackId: string,
  from: string,
  to: string,
  onProgress?: (progress: TranslateProgress) => void,
  signal?: AbortSignal
): Promise<number> {
  const events = A.captionEvents(trackId)
  if (events.length === 0) throw new Error('That track has no captions')
  const originals = events.map((e) => e.text?.text ?? '')
  const lines = events.map((e, i) => ({
    text: plainCaption(originals[i]),
    start: e.start / FLICKS_PER_SECOND,
    end: eventEnd(e) / FLICKS_PER_SECOND
  }))
  const groups = sentenceGroups(lines)
  const translated = await translateTexts(
    groups.map((g) => g.map((i) => lines[i].text).join(' ')),
    from,
    to,
    onProgress,
    signal
  )
  const texts = captionTranslations(originals, groups, translated)
  const before = useEditor.getState().project
  A.addTranslatedCaptions(
    trackId,
    events.map((e) => e.id),
    texts,
    to
  )
  return useEditor.getState().project === before ? 0 : texts.filter(Boolean).length
}

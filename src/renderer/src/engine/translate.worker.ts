import * as ort from 'onnxruntime-web/wasm'
import { Tokenizer } from '@huggingface/tokenizers'

// Translates texts with Opus-MT models (MarianMT exported to ONNX, 8-bit):
// ONNX Runtime's WebAssembly backend on one thread (pages are not cross-origin
// isolated), greedy decoding with the decoder's key/value cache, sentences in
// batches of similar length. Runs off the page's thread; engine/translate.ts
// hands it the runtime and the model files (nothing is fetched here).

export interface TranslateModelFiles {
  config: string
  tokenizer: string
  tokenizerConfig: string
  encoder: Uint8Array
  decoder: Uint8Array
}

export interface TranslateRequest {
  /** ONNX Runtime's WebAssembly binary. */
  wasm: Uint8Array
  /** The models to run one after the other (a pair through English takes two). */
  steps: TranslateModelFiles[]
  texts: string[]
}

export type TranslateReply = { kind: 'progress'; progress: number } | { kind: 'done'; texts: string[] } | { kind: 'error'; message: string }

interface MarianConfig {
  d_model: number
  decoder_attention_heads: number
  pad_token_id: number
  eos_token_id: number
  decoder_start_token_id: number
}

interface Model {
  tokenizer: Tokenizer
  encoder: ort.InferenceSession
  decoder: ort.InferenceSession
  config: MarianConfig
}

const BATCH = 8

async function loadModel(files: TranslateModelFiles): Promise<Model> {
  const options: ort.InferenceSession.SessionOptions = {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all'
  }
  return {
    tokenizer: new Tokenizer(JSON.parse(files.tokenizer), JSON.parse(files.tokenizerConfig)),
    encoder: await ort.InferenceSession.create(files.encoder, options),
    decoder: await ort.InferenceSession.create(files.decoder, options),
    config: JSON.parse(files.config) as MarianConfig
  }
}

/** Translates one batch of token id lists (greedy: the likeliest next token each step). */
async function translateBatch(model: Model, encoded: number[][]): Promise<number[][]> {
  const { encoder, decoder, config } = model
  const b = encoded.length
  const len = Math.max(...encoded.map((e) => e.length))
  const pad = config.pad_token_id
  const ids = new BigInt64Array(b * len).fill(BigInt(pad))
  const mask = new BigInt64Array(b * len)
  encoded.forEach((e, i) =>
    e.forEach((id, j) => {
      ids[i * len + j] = BigInt(id)
      mask[i * len + j] = 1n
    })
  )
  const attention = new ort.Tensor('int64', mask, [b, len])
  const encoderOut = await encoder.run({
    input_ids: new ort.Tensor('int64', ids, [b, len]),
    attention_mask: attention
  })
  const hidden = encoderOut.last_hidden_state
  const heads = config.decoder_attention_heads
  const headDim = config.d_model / heads
  let past: Record<string, ort.Tensor> = {}
  for (const name of decoder.inputNames) {
    if (name.startsWith('past_key_values')) past[name] = new ort.Tensor('float32', new Float32Array(0), [b, heads, 0, headDim])
  }
  const out: number[][] = encoded.map(() => [])
  const done = encoded.map(() => false)
  let next = new BigInt64Array(b).fill(BigInt(config.decoder_start_token_id))
  const maxSteps = Math.min(512, len * 2 + 10)
  for (let step = 0; step < maxSteps; step++) {
    const result = await decoder.run({
      input_ids: new ort.Tensor('int64', next, [b, 1]),
      encoder_attention_mask: attention,
      encoder_hidden_states: hidden,
      use_cache_branch: new ort.Tensor('bool', [step > 0], [1]),
      ...past
    })
    const logits = result.logits
    const vocab = logits.dims[2]
    const data = logits.data as Float32Array
    next = new BigInt64Array(b)
    for (let i = 0; i < b; i++) {
      if (done[i]) {
        next[i] = BigInt(pad)
        continue
      }
      // The padding token is never generated.
      let best = -1
      let bestScore = -Infinity
      for (let v = 0, base = i * vocab; v < vocab; v++) {
        if (v !== pad && data[base + v] > bestScore) {
          bestScore = data[base + v]
          best = v
        }
      }
      next[i] = BigInt(best)
      if (best === config.eos_token_id) done[i] = true
      else out[i].push(best)
    }
    const nextPast: Record<string, ort.Tensor> = {}
    for (const name of Object.keys(past)) {
      // The encoder's keys and values come out of the first step and stay.
      nextPast[name] = step > 0 && name.includes('.encoder.') ? past[name] : result[name.replace('past_key_values', 'present')]
    }
    past = nextPast
    if (done.every(Boolean)) break
  }
  return out
}

async function translateAll(model: Model, texts: string[], progress: (done: number) => void): Promise<string[]> {
  const result = texts.map(() => '')
  const encoded = texts.map((t) => (t.trim() ? model.tokenizer.encode(t.trim()).ids : []))
  // Similar lengths together: less padding.
  const order = texts.map((_, i) => i).filter((i) => encoded[i].length > 0)
  order.sort((a, b) => encoded[a].length - encoded[b].length)
  let done = texts.length - order.length
  for (let k = 0; k < order.length; k += BATCH) {
    const batch = order.slice(k, k + BATCH)
    const tokens = await translateBatch(
      model,
      batch.map((i) => encoded[i].slice(0, 510))
    )
    batch.forEach((i, j) => (result[i] = model.tokenizer.decode(tokens[j], { skip_special_tokens: true }).trim()))
    done += batch.length
    progress(done)
  }
  return result
}

self.onmessage = async (e: MessageEvent<TranslateRequest>) => {
  const post = (reply: TranslateReply): void => self.postMessage(reply)
  try {
    const { wasm, steps, texts } = e.data
    ort.env.wasm.wasmBinary = wasm
    ort.env.wasm.numThreads = 1
    ort.env.wasm.proxy = false
    let current = texts
    for (const [s, files] of steps.entries()) {
      const model = await loadModel(files)
      try {
        current = await translateAll(model, current, (done) =>
          post({
            kind: 'progress',
            progress: (s + done / Math.max(1, texts.length)) / steps.length
          })
        )
      } finally {
        await model.encoder.release()
        await model.decoder.release()
      }
    }
    post({ kind: 'done', texts: current })
  } catch (err) {
    post({
      kind: 'error',
      message: err instanceof Error ? err.message : String(err)
    })
  }
}

import { ALL_FORMATS, AudioBufferSink, Input } from 'mediabunny'
import type { MediaItem } from '../core/types'
import { inputSource } from '../media/source'
import type { Transcript } from '../core/captions'
import { type CaptionProgress, bridge } from '../platform'

// Transcription with the speech engine bundled with the app (whisper.cpp):
// the sound of a media range is decoded here (WebCodecs), mixed to mono,
// resampled to 16 kHz and streamed to the main process, which runs the
// engine on it. No other program is needed.

const RATE = 16000
/** Seconds of sound resampled and sent at a time. */
const BLOCK = 30

/**
 * Transcribes [from, from + duration) seconds of a media file. Times in the
 * result are seconds from `from`.
 */
export async function transcribeMedia(
  media: MediaItem,
  from: number,
  duration: number,
  model: string,
  language: string,
  onProgress?: (progress: CaptionProgress) => void
): Promise<Transcript> {
  if (!bridge) throw new Error('Transcription runs in the desktop app')
  const total = Math.max(1, Math.round(duration * RATE))
  const id = await bridge.startTranscription({ model, language, samples: total })
  let sent = 0
  try {
    const input = new Input({ formats: ALL_FORMATS, source: inputSource(media) })
    try {
      const track = await input.getPrimaryAudioTrack()
      if (!track) throw new Error('This media has no sound')
      const first = Math.max(0, await input.getFirstTimestamp())
      const blocks = Math.ceil(total / (RATE * BLOCK))
      const contexts = new Map<number, OfflineAudioContext>()
      const context = (b: number): OfflineAudioContext => {
        let ctx = contexts.get(b)
        if (!ctx) {
          const frames = Math.min(RATE * BLOCK, total - b * RATE * BLOCK)
          ctx = new OfflineAudioContext(1, frames, RATE)
          contexts.set(b, ctx)
        }
        return ctx
      }
      let next = 0
      /** Renders and sends, in order, the blocks before `upTo` (silent ones too), as 16-bit mono samples. */
      const flush = async (upTo: number): Promise<void> => {
        for (; next < upTo; next++) {
          const rendered = (await context(next).startRendering()).getChannelData(0)
          contexts.delete(next)
          const pcm = new Int16Array(rendered.length)
          for (let i = 0; i < rendered.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(rendered[i] * 32767)))
          await bridge!.sendTranscriptionAudio(id, new Uint8Array(pcm.buffer))
          sent += pcm.length
          onProgress?.({ phase: 'prepare', progress: sent / total })
        }
      }
      for await (const { buffer, timestamp } of new AudioBufferSink(track).buffers(first + from, first + from + duration)) {
        const t0 = timestamp - first - from
        const firstBlock = Math.max(0, Math.floor(t0 / BLOCK))
        const lastBlock = Math.min(blocks - 1, Math.floor((t0 + buffer.duration) / BLOCK))
        await flush(firstBlock)
        for (let b = Math.max(firstBlock, next); b <= lastBlock; b++) {
          const ctx = context(b)
          const source = ctx.createBufferSource()
          source.buffer = buffer
          source.connect(ctx.destination)
          // Starts inside the block, or plays from the part that falls into it.
          const at = t0 - b * BLOCK
          if (at >= 0) source.start(at)
          else source.start(0, -at)
        }
      }
      await flush(blocks)
    } finally {
      input.dispose()
    }
    if (sent < total) await bridge.sendTranscriptionAudio(id, new Uint8Array((total - sent) * 2))
    onProgress?.({ phase: 'transcribe', progress: 0 })
    return await bridge.finishTranscription(id)
  } catch (err) {
    void bridge.cancelTranscription(id)
    throw err
  }
}

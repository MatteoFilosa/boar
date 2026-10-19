import {
  AudioBufferSource,
  AudioSample,
  AudioSampleSource,
  FlacOutputFormat,
  Mp3OutputFormat,
  Mp4OutputFormat,
  OggOutputFormat,
  Output,
  type OutputFormat,
  type Target,
  WavOutputFormat,
  canEncodeAudio
} from 'mediabunny'
import { mediaById } from '../core/store'
import type { Flicks } from '../core/time'
import { mixedTracks, projectEnd } from '../core/timeline'
import type { Project } from '../core/types'
import { ExportCancelled, type ExportProgress, type ExportQuality, type MixSettings, encoderDelay, mixAudio, sliceAudio } from './export'
import { type LoudnessResult, normalizeLoudness } from './loudness'

// Sound only renders: the mix (or chosen tracks) without the picture, to the
// usual audio files. MP3 and FLAC encoders are wasm builds loaded on first use;
// AAC and Opus come from the system through WebCodecs.

export type SoundFormat = 'mp3' | 'wav' | 'flac' | 'm4a' | 'ogg'

export const SOUND_FORMATS: SoundFormat[] = ['mp3', 'wav', 'flac', 'm4a', 'ogg']

export interface SoundFormatInfo {
  label: string
  extension: string
  mimeType: string
  /** Quality choices: bit rates for compressed formats, bit depths for lossless ones. */
  qualities: Partial<Record<ExportQuality, string>>
}

export const SOUND_FORMAT_INFO: Record<SoundFormat, SoundFormatInfo> = {
  mp3: { label: 'MP3 (plays everywhere)', extension: 'mp3', mimeType: 'audio/mpeg', qualities: { medium: '128 kbps', high: '192 kbps', veryHigh: '320 kbps' } },
  wav: { label: 'WAV (uncompressed)', extension: 'wav', mimeType: 'audio/wav', qualities: { high: '16-bit', veryHigh: '24-bit' } },
  flac: { label: 'FLAC (lossless, about half of WAV)', extension: 'flac', mimeType: 'audio/flac', qualities: { high: '16-bit', veryHigh: '24-bit' } },
  m4a: { label: 'M4A · AAC', extension: 'm4a', mimeType: 'audio/mp4', qualities: { medium: '128 kbps', high: '192 kbps', veryHigh: '256 kbps' } },
  ogg: { label: 'OGG · Opus (small files)', extension: 'ogg', mimeType: 'audio/ogg', qualities: { medium: '96 kbps', high: '128 kbps', veryHigh: '192 kbps' } }
}

const BITRATES: Partial<Record<SoundFormat, Record<ExportQuality, number>>> = {
  mp3: { medium: 128_000, high: 192_000, veryHigh: 320_000 },
  m4a: { medium: 128_000, high: 192_000, veryHigh: 256_000 },
  ogg: { medium: 96_000, high: 128_000, veryHigh: 192_000 }
}

/** The quality a format really uses: lossless formats have no 'medium' and take 16-bit. */
export const soundQuality = (format: SoundFormat, quality: ExportQuality): ExportQuality =>
  SOUND_FORMAT_INFO[format].qualities[quality] ? quality : 'high'

/** Formats this system can write. MP3, WAV and FLAC are encoded by Boar itself, so they always work. */
export async function soundSupport(): Promise<Record<SoundFormat, boolean>> {
  const check = (codec: 'aac' | 'opus'): Promise<boolean> =>
    canEncodeAudio(codec, { numberOfChannels: 2, sampleRate: 48000 }).catch(() => false)
  const [aac, opus] = await Promise.all([check('aac'), check('opus')])
  return { mp3: true, wav: true, flac: true, m4a: aac, ogg: opus }
}

let mp3Ready: Promise<void> | null = null
let flacReady: Promise<void> | null = null

/** Registers the wasm MP3 or FLAC encoder once, unless the system has its own. */
function loadEncoder(format: SoundFormat): Promise<void> {
  if (format === 'mp3') {
    mp3Ready ??= (async () => {
      if (await canEncodeAudio('mp3').catch(() => false)) return
      const { registerMp3Encoder } = await import('@mediabunny/mp3-encoder')
      registerMp3Encoder()
    })()
    return mp3Ready
  }
  if (format === 'flac') {
    flacReady ??= (async () => {
      if (await canEncodeAudio('flac').catch(() => false)) return
      const { registerFlacEncoder } = await import('@mediabunny/flac-encoder')
      registerFlacEncoder()
    })()
    return flacReady
  }
  return Promise.resolve()
}

export interface SoundSettings extends MixSettings {
  format: SoundFormat
  quality: ExportQuality
  /** Integrated loudness target in LUFS (null or absent = leave the mix as is). */
  loudness?: number | null
}

/** Whether the chosen tracks have any sound in the range. */
export function hasSound(project: Project, tracks: string[] | undefined, range: { start: Flicks; end: Flicks }): boolean {
  const ids = new Set(mixedTracks(project, tracks).map((t) => t.id))
  return project.events.some(
    (e) => ids.has(e.trackId) && e.start < range.end && e.start + e.length > range.start && !!mediaById(e.mediaId)?.hasAudio
  )
}

function outputFormat(format: SoundFormat): OutputFormat {
  switch (format) {
    case 'mp3':
      return new Mp3OutputFormat()
    case 'wav':
      return new WavOutputFormat()
    case 'flac':
      return new FlacOutputFormat()
    case 'm4a':
      return new Mp4OutputFormat({ fastStart: false })
    case 'ogg':
      return new OggOutputFormat()
  }
}

/** Interleaved 16-bit samples of a piece of the mix (FLAC takes its bit depth from the sample format). */
function s16Sample(buffer: AudioBuffer, timestamp: number): AudioSample {
  const channels = buffer.numberOfChannels
  const data = new Int16Array(buffer.length * channels)
  for (let c = 0; c < channels; c++) {
    const src = buffer.getChannelData(c)
    for (let n = 0; n < src.length; n++) {
      const v = Math.max(-1, Math.min(1, src[n]))
      data[n * channels + c] = Math.round(v < 0 ? v * 0x8000 : v * 0x7fff)
    }
  }
  return new AudioSample({ data, format: 's16', numberOfChannels: channels, sampleRate: buffer.sampleRate, timestamp })
}

/** Renders the sound of the project (or `range` of it) to an audio file. */
export async function exportSound(
  project: Project,
  target: Target,
  settings: SoundSettings,
  onProgress: (p: ExportProgress) => void,
  isCancelled: () => boolean,
  range?: { start: Flicks; end: Flicks }
): Promise<{ loudness: LoudnessResult | null }> {
  const span = range ?? { start: 0, end: projectEnd(project) }
  if (span.end - span.start <= 0) throw new Error('Nothing to render: the timeline or the selection is empty')
  if (!hasSound(project, settings.tracks, span)) throw new Error('Nothing to render: there is no sound on the chosen tracks')
  const { format } = settings
  const quality = soundQuality(format, settings.quality)
  await loadEncoder(format)

  onProgress({ phase: 'audio', progress: 0 })
  const mix = await mixAudio(project, settings, span, (f) => onProgress({ phase: 'audio', progress: f * 0.5 }), isCancelled)
  const loudness = settings.loudness != null ? normalizeLoudness(mix, settings.loudness) : null

  const output = new Output({ format: outputFormat(format), target })
  const codec =
    format === 'mp3' ? 'mp3' : format === 'flac' ? 'flac' : format === 'm4a' ? 'aac' : format === 'ogg' ? 'opus' : quality === 'veryHigh' ? 'pcm-s24' : 'pcm-s16'
  const bitrate = BITRATES[format]?.[quality]
  // AAC in MP4 starts before 0 by the encoder's delay, like in video renders (edit list).
  const delay = codec === 'aac' ? await encoderDelay('aac', mix.sampleRate) : 0
  const sixteenBitFlac = format === 'flac' && quality !== 'veryHigh'
  const samples = sixteenBitFlac ? new AudioSampleSource({ codec, bitrate }) : null
  const buffers = samples ? null : new AudioBufferSource({ codec, bitrate }, { startTimestamp: -delay / mix.sampleRate })
  output.addAudioTrack((samples ?? buffers)!)

  let finished = false
  try {
    await output.start()
    const chunk = mix.sampleRate // one second at a time
    for (let at = 0; at < mix.length; at += chunk) {
      if (isCancelled()) throw new ExportCancelled()
      const piece = sliceAudio(mix, at, at + chunk)
      if (!piece) break
      if (samples) {
        const sample = s16Sample(piece, at / mix.sampleRate)
        await samples.add(sample)
        sample.close()
      } else {
        await buffers!.add(piece)
      }
      onProgress({ phase: 'audio', progress: 0.5 + (0.5 * (at + piece.length)) / mix.length })
    }
    onProgress({ phase: 'finalizing', progress: 1 })
    ;(samples ?? buffers)!.close()
    await output.finalize()
    finished = true
  } finally {
    if (!finished) await output.cancel().catch(() => undefined)
  }
  return { loudness }
}

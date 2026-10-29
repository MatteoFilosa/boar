import { ProgramStreamReader, isProgramStream, ticksBetween, type PesPacket } from './programStream'
import { Mpeg2VideoDecoder } from './video'
import { squareWidth } from './resample'

/** What a camcorder file holds, as Boar's editable copy of it will be. */
export interface CameraFileFacts {
  /** Seconds. */
  duration: number
  /** Square pixels. */
  width: number
  height: number
  /** Frames per second of the copy (one per field when interlaced). */
  fps: number
  interlaced: boolean
  codec: 'MPEG-1' | 'MPEG-2'
  audioTracks: number
}

/** A byte range [start, end) of the file and the file's size. */
export type RangeReader = (start: number, end: number) => Promise<{ data: Uint8Array; size: number }>

const SPAN = 1 << 20

/** Reads a program stream's first and last megabyte: picture format, sound tracks, length. Null for other files. */
export async function probeProgramStream(read: RangeReader): Promise<CameraFileFacts | null> {
  const head = await read(0, SPAN)
  if (!isProgramStream(head.data)) return null
  const all = (data: Uint8Array): PesPacket[] => {
    const reader = new ProgramStreamReader()
    return [...reader.push(data), ...reader.finish()]
  }
  const isVideo = (p: PesPacket): boolean => p.stream >= 0xe0 && p.stream <= 0xef
  const decoder = new Mpeg2VideoDecoder()
  const sounds = new Set<number>()
  let first: number | null = null
  for (const p of all(head.data)) {
    if (isVideo(p)) {
      decoder.push(p.data, p.pts)
      decoder.take()
      if (p.pts !== null && (first === null || ticksBetween(first, p.pts) < 0)) first = p.pts
    } else if (p.stream !== 0xbd || (p.substream >= 0x80 && p.substream <= 0xaf)) sounds.add((p.stream << 8) | p.substream)
  }
  const seq = decoder.sequence
  if (!seq || first === null) return null
  let last = first
  const tail = head.size > SPAN ? (await read(head.size - SPAN, head.size)).data : head.data
  for (const p of all(tail)) if (isVideo(p) && p.pts !== null && ticksBetween(last, p.pts) > 0) last = p.pts
  return {
    duration: ticksBetween(first, last) / 90000 + 1 / seq.frameRate,
    width: squareWidth(seq.height, seq.aspect),
    height: seq.height,
    fps: seq.progressive ? seq.frameRate : seq.frameRate * 2,
    interlaced: !seq.progressive,
    codec: seq.mpeg2 ? 'MPEG-2' : 'MPEG-1',
    audioTracks: sounds.size
  }
}

// MPEG program streams (.mpg, .mod, .vob): what camcorders that record on a
// DVD, a hard disk or a memory card in standard definition write. Chromium
// reads none of them, so Boar demuxes them itself (MPEG-1 and MPEG-2 packs).

/** One PES packet's payload. Times are 90 kHz clock ticks. */
export interface PesPacket {
  /** 0xe0-0xef video, 0xc0-0xdf MPEG audio, 0xbd private stream 1. */
  stream: number
  /** Private stream 1 only: 0x80-0x87 AC-3, 0x88-0x8f DTS, 0xa0-0xa7 LPCM, 0x20-0x3f subpictures. */
  substream: number
  pts: number | null
  data: Uint8Array
}

/** LPCM parameters from a DVD private stream header. */
export interface LpcmFormat {
  bits: number
  sampleRate: number
  channels: number
}

const PACK = 0xba
const END = 0xb9

/** True when the bytes start like a program stream (a pack header). */
export function isProgramStream(head: Uint8Array): boolean {
  if (head.length < 12 || head[0] !== 0 || head[1] !== 0 || head[2] !== 1 || head[3] !== PACK) return false
  // MPEG-2 packs start with '01', MPEG-1 packs with '0010'.
  return (head[4] & 0xc0) === 0x40 || (head[4] & 0xf0) === 0x20
}

/** Reads a 33-bit PES time stamp (5 bytes with marker bits). */
function readTime(d: Uint8Array, i: number): number {
  return ((d[i] >> 1) & 7) * 1073741824 + ((d[i + 1] << 22) | ((d[i + 2] >> 1) << 15) | (d[i + 3] << 7) | (d[i + 4] >> 1))
}

/**
 * Splits a program stream into PES packets, chunk by chunk. Packs, system
 * headers, padding and private stream 2 (DVD navigation) are skipped; damaged
 * bytes are passed over until the next start code.
 */
export class ProgramStreamReader {
  private buffer = new Uint8Array(1 << 16)
  private start = 0
  private end = 0
  /** Bytes of the stream read so far, before the buffer start. */
  private consumed = 0
  /** LPCM formats by substream, from their headers. */
  readonly lpcm = new Map<number, LpcmFormat>()

  /** Position in the stream of the next byte not handled yet. */
  get position(): number {
    return this.consumed + this.start
  }

  push(chunk: Uint8Array): PesPacket[] {
    if (this.end + chunk.length > this.buffer.length) {
      const kept = this.end - this.start
      if (kept + chunk.length <= this.buffer.length) this.buffer.copyWithin(0, this.start, this.end)
      else {
        const next = new Uint8Array((kept + chunk.length) * 2)
        next.set(this.buffer.subarray(this.start, this.end))
        this.buffer = next
      }
      this.consumed += this.start
      this.end = kept
      this.start = 0
    }
    this.buffer.set(chunk, this.end)
    this.end += chunk.length
    return this.parse(false)
  }

  /** Whatever complete packets are left at the end of the file. */
  finish(): PesPacket[] {
    return this.parse(true)
  }

  private parse(last: boolean): PesPacket[] {
    const d = this.buffer
    const out: PesPacket[] = []
    let i = this.start
    while (i + 4 <= this.end) {
      if (d[i] !== 0 || d[i + 1] !== 0 || d[i + 2] !== 1) {
        // Out of step: look for the next start code.
        const next = d.subarray(0, this.end).indexOf(1, i + 2)
        if (next < 0) {
          i = Math.max(i, this.end - 2)
          break
        }
        i = next - 2
        continue
      }
      const code = d[i + 3]
      if (code === PACK) {
        if (i + 14 > this.end) break
        if ((d[i + 4] & 0xc0) === 0x40) {
          const size = 14 + (d[i + 13] & 7)
          if (i + size > this.end) break
          i += size
        } else i += 12
        continue
      }
      if (code === END) {
        i += 4
        continue
      }
      if (code < 0xbb) {
        // Not a system start code (video bytes outside a packet): resync.
        i += 3
        continue
      }
      if (i + 6 > this.end) break
      const length = (d[i + 4] << 8) | d[i + 5]
      const size = 6 + length
      if (i + size > this.end) {
        if (!last) break
        i = this.end
        break
      }
      if (code === 0xbd || (code >= 0xc0 && code <= 0xef)) {
        const packet = this.packet(code, d, i + 6, i + size)
        if (packet) out.push(packet)
      }
      i += size
    }
    this.start = i
    if (this.start === this.end) {
      this.consumed += this.start
      this.start = this.end = 0
    }
    return out
  }

  private packet(stream: number, d: Uint8Array, from: number, to: number): PesPacket | null {
    let i = from
    let pts: number | null = null
    if ((d[i] & 0xc0) === 0x80) {
      // MPEG-2 PES header.
      const flags = d[i + 1] >> 6
      const headerLength = d[i + 2]
      if (flags & 2) pts = readTime(d, i + 3)
      i += 3 + headerLength
    } else {
      // MPEG-1: stuffing, optional STD buffer size, then the time stamps.
      while (i < to && d[i] === 0xff) i++
      if ((d[i] & 0xc0) === 0x40) i += 2
      if ((d[i] & 0xf0) === 0x20) {
        pts = readTime(d, i)
        i += 5
      } else if ((d[i] & 0xf0) === 0x30) {
        pts = readTime(d, i)
        i += 10
      } else i++
    }
    if (i >= to) return null
    let substream = 0
    if (stream === 0xbd) {
      substream = d[i]
      if (substream >= 0x80 && substream <= 0x8f) i += 4
      else if (substream >= 0xa0 && substream <= 0xaf) {
        // Frame count, first access unit, then the LPCM header.
        const format = d[i + 5]
        const bits = [16, 20, 24, 0][format >> 6]
        const sampleRate = [48000, 96000, 44100, 32000][(format >> 4) & 3]
        if (bits) this.lpcm.set(substream, { bits, sampleRate, channels: (format & 7) + 1 })
        i += 7
      } else i += 1
    }
    if (i >= to) return null
    return { stream, substream, pts, data: d.slice(i, to) }
  }
}

/** Number of 90 kHz ticks from `from` to `to`, across the 33-bit wrap. */
export function ticksBetween(from: number, to: number): number {
  const wrap = 2 ** 33
  let delta = (to - from) % wrap
  if (delta > wrap / 2) delta -= wrap
  if (delta < -wrap / 2) delta += wrap
  return delta
}

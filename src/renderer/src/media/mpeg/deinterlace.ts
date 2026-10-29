// Deinterlacing: camcorders record 50 (or 60) fields a second, each field
// every other line at its own moment. Every field becomes a whole frame, so
// motion stays as smooth as it was filmed: the field's own lines are kept and
// the missing ones are guessed from the fields before and after where the
// picture holds still, and along edges from the lines above and below where
// it moves.

/** One picture plane with its line step. */
export interface Plane {
  data: Uint8Array
  /** Offset of the first sample. */
  offset: number
  stride: number
}

/** A frame of interlaced pictures (or a progressive one). */
export interface InterlacedFrame {
  y: Plane
  u: Plane
  v: Plane
  width: number
  height: number
  topFieldFirst: boolean
  /** Both fields come from the same moment: nothing to interpolate. */
  progressive: boolean
}

/** A whole frame made from one field, planes tightly packed (I420). */
export interface FieldFrame {
  data: Uint8Array
  width: number
  height: number
}

/**
 * Fills the lines of parity `missing` (0 even, 1 odd) of `dst` (width×height,
 * tightly packed), copying the other lines from `cur`. `before`/`after` hold
 * the missing lines just before and after this field; `prev`/`next` are the
 * frames before and after the current one (for the motion of the kept lines).
 */
export function deinterlacePlane(
  dst: Uint8Array,
  dstOffset: number,
  width: number,
  height: number,
  missing: number,
  cur: Plane,
  before: Plane,
  after: Plane,
  prev: Plane,
  next: Plane
): void {
  const row = (p: Plane, y: number): number => p.offset + y * p.stride
  for (let y = 1 - missing; y < height; y += 2) dst.set(cur.data.subarray(row(cur, y), row(cur, y) + width), dstOffset + y * width)
  const c0 = cur.data
  const b0 = before.data
  const a0 = after.data
  const p0 = prev.data
  const n0 = next.data
  for (let y = missing; y < height; y += 2) {
    // Kept lines above and below (repeated at the picture's edges), and the missing ones two lines away.
    const up = y - 1 >= 0 ? y - 1 : y + 1
    const down = y + 1 < height ? y + 1 : y - 1
    const edge = y === 0 || y === height - 1
    const up2 = y - 2 >= 0 ? y - 2 : y
    const down2 = y + 2 < height ? y + 2 : y
    const cu = row(cur, up)
    const cd = row(cur, down)
    const bm = row(before, y)
    const am = row(after, y)
    const bu2 = row(before, up2)
    const au2 = row(after, up2)
    const bd2 = row(before, down2)
    const ad2 = row(after, down2)
    const pu = row(prev, up)
    const pd = row(prev, down)
    const nu = row(next, up)
    const nd = row(next, down)
    const out = dstOffset + y * width
    for (let x = 0; x < width; x++) {
      const c = c0[cu + x]
      const e = c0[cd + x]
      const pb = b0[bm + x]
      const pa = a0[am + x]
      const d = (pb + pa) >> 1
      // How much the picture moves here.
      const motion0 = Math.abs(pb - pa) >> 1
      const motion1 = (Math.abs(p0[pu + x] - c) + Math.abs(p0[pd + x] - e)) >> 1
      const motion2 = (Math.abs(n0[nu + x] - c) + Math.abs(n0[nd + x] - e)) >> 1
      let diff = motion0 > motion1 ? motion0 : motion1
      if (motion2 > diff) diff = motion2
      // Guess from the lines above and below, along the direction where they match best:
      // leaning left (k -1, then -2 while it gets better), then right.
      let pred = (c + e) >> 1
      if (x >= 3 && x < width - 3) {
        const u = cu + x
        const v = cd + x
        let score = Math.abs(c0[u - 1] - c0[v - 1]) + Math.abs(c - e) + Math.abs(c0[u + 1] - c0[v + 1]) - 1
        let s = Math.abs(c0[u - 2] - c0[v]) + Math.abs(c0[u - 1] - c0[v + 1]) + Math.abs(c - c0[v + 2])
        if (s < score) {
          score = s
          pred = (c0[u - 1] + c0[v + 1]) >> 1
          s = Math.abs(c0[u - 3] - c0[v + 1]) + Math.abs(c0[u - 2] - c0[v + 2]) + Math.abs(c0[u - 1] - c0[v + 3])
          if (s < score) {
            score = s
            pred = (c0[u - 2] + c0[v + 2]) >> 1
          }
        }
        s = Math.abs(c - c0[v - 2]) + Math.abs(c0[u + 1] - c0[v - 1]) + Math.abs(c0[u + 2] - e)
        if (s < score) {
          score = s
          pred = (c0[u + 1] + c0[v - 1]) >> 1
          s = Math.abs(c0[u + 1] - c0[v - 3]) + Math.abs(c0[u + 2] - c0[v - 2]) + Math.abs(c0[u + 3] - c0[v - 1])
          if (s < score) pred = (c0[u + 2] + c0[v - 2]) >> 1
        }
      }
      // Where the temporal guess is not between the lines around it, allow more change (the first and
      // last lines have a neighbour on one side only: there the motion alone decides).
      if (!edge) {
        const b = (b0[bu2 + x] + a0[au2 + x]) >> 1
        const f = (b0[bd2 + x] + a0[ad2 + x]) >> 1
        const de = d - e
        const dc = d - c
        const bc = b - c
        const fe = f - e
        let max = de > dc ? de : dc
        const low = bc < fe ? bc : fe
        if (low > max) max = low
        let min = de < dc ? de : dc
        const high = bc > fe ? bc : fe
        if (high < min) min = high
        if (min > diff) diff = min
        if (-max > diff) diff = -max
      }
      if (pred > d + diff) pred = d + diff
      else if (pred < d - diff) pred = d - diff
      dst[out + x] = pred < 0 ? 0 : pred > 255 ? 255 : pred
    }
  }
}

/** Copies a plane into a tight buffer. */
function copyPlane(dst: Uint8Array, dstOffset: number, width: number, height: number, src: Plane): void {
  for (let y = 0; y < height; y++) dst.set(src.data.subarray(src.offset + y * src.stride, src.offset + y * src.stride + width), dstOffset + y * width)
}

/**
 * Turns interlaced frames into twice as many whole frames, one per field, in
 * the order they were filmed. Each frame comes out when the next one arrives
 * (its second field needs the next frame's first one).
 */
export class Deinterlacer {
  private window: InterlacedFrame[] = []

  push(frame: InterlacedFrame): FieldFrame[] {
    this.window.push(frame)
    if (this.window.length === 1) return []
    if (this.window.length > 3) this.window.shift()
    // The frame before the newest one can be made now.
    const i = this.window.length - 2
    return this.fields(this.window[i - 1] ?? this.window[i], this.window[i], this.window[i + 1])
  }

  /** The last frame, with itself standing in for the one after. */
  flush(): FieldFrame[] {
    const last = this.window.at(-1)
    if (!last) return []
    const out = this.fields(this.window.at(-2) ?? last, last, last)
    this.window = []
    return out
  }

  private fields(prev: InterlacedFrame, cur: InterlacedFrame, next: InterlacedFrame): FieldFrame[] {
    const { width, height } = cur
    const cw = width >> 1
    const ch = height >> 1
    const size = width * height + 2 * cw * ch
    const firstParity = cur.topFieldFirst ? 0 : 1
    const out: FieldFrame[] = []
    for (let field = 0; field < 2; field++) {
      const data = new Uint8Array(size)
      if (cur.progressive) {
        copyPlane(data, 0, width, height, cur.y)
        copyPlane(data, width * height, cw, ch, cur.u)
        copyPlane(data, width * height + cw * ch, cw, ch, cur.v)
      } else {
        const kept = field === 0 ? firstParity : 1 - firstParity
        // The missing lines of the first field were filmed between the previous frame's and this one's
        // other field; those of the second field between this frame's first field and the next frame's.
        const before = field === 0 ? prev : cur
        const after = field === 0 ? cur : next
        deinterlacePlane(data, 0, width, height, 1 - kept, cur.y, before.y, after.y, prev.y, next.y)
        deinterlacePlane(data, width * height, cw, ch, 1 - kept, cur.u, before.u, after.u, prev.u, next.u)
        deinterlacePlane(data, width * height + cw * ch, cw, ch, 1 - kept, cur.v, before.v, after.v, prev.v, next.v)
      }
      out.push({ data, width, height })
    }
    return out
  }
}

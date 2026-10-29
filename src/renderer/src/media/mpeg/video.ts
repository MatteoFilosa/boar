// MPEG-1 and MPEG-2 video decoder (ISO/IEC 11172-2 and 13818-2, main
// profile, 4:2:0): the picture of camcorders that record standard definition
// on DVDs, hard disks and memory cards, which Chromium cannot decode. Frame and
// field pictures, every motion type (dual prime too), both scans and VLC
// tables, linear and non-linear quantiser scales. Pictures come out in display
// order with their fields as coded; deinterlace.ts makes frames of them.

/** What the stream says about its pictures. */
export interface SequenceInfo {
  width: number
  height: number
  /** Display aspect ratio (width / height) of the whole coded picture. */
  aspect: number
  /** Frames per second. */
  frameRate: number
  /** Every picture is progressive (otherwise pictures are interlaced unless marked). */
  progressive: boolean
  mpeg2: boolean
}

/** A decoded frame. The planes cover whole macroblocks: `stride` luma bytes per line, chroma half of it. */
export interface DecodedPicture {
  y: Uint8Array
  u: Uint8Array
  v: Uint8Array
  stride: number
  /** Allocated luma lines. */
  lines: number
  width: number
  height: number
  /** 90 kHz presentation time from the stream, when it gave one. */
  pts: number | null
  /** Both fields were captured at the same moment. */
  progressive: boolean
  topFieldFirst: boolean
  /** Shown for three fields (or two frames in progressive sequences) instead of two. */
  repeatFirstField: boolean
  /** 1 I, 2 P, 3 B. */
  type: number
}

// Macroblock type flags.
const QUANT = 1
const FWD = 2
const BWD = 4
const PATTERN = 8
const INTRA = 16

const I_TYPE = 1
const P_TYPE = 2
const B_TYPE = 3

const ZIGZAG = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49,
  56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63
])

const ALTERNATE = new Uint8Array([
  0, 8, 16, 24, 1, 9, 2, 10, 17, 25, 32, 40, 48, 56, 57, 49, 41, 33, 26, 18, 3, 11, 4, 12, 19, 27, 34, 42, 50, 58, 35, 43, 51, 59,
  20, 28, 5, 13, 6, 14, 21, 29, 36, 44, 52, 60, 37, 45, 53, 61, 22, 30, 7, 15, 23, 31, 38, 46, 54, 62, 39, 47, 55, 63
])

/** Default intra quantiser matrix, in raster order. */
const DEFAULT_INTRA = new Uint8Array([
  8, 16, 19, 22, 26, 27, 29, 34, 16, 16, 22, 24, 27, 29, 34, 37, 19, 22, 26, 27, 29, 34, 34, 38, 22, 22, 26, 27, 29, 34, 37, 40, 22, 26,
  27, 29, 32, 35, 40, 48, 26, 27, 29, 32, 35, 40, 48, 58, 26, 27, 29, 34, 38, 46, 56, 69, 27, 29, 35, 38, 46, 56, 69, 83
])

const NON_LINEAR_SCALE = new Uint8Array([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 40, 44, 48, 52, 56, 64, 72, 80, 88, 96, 104, 112
])

/** Frame rates by frame_rate_code. */
const FRAME_RATES = [0, 24000 / 1001, 24, 25, 30000 / 1001, 30, 50, 60000 / 1001, 60]
/** MPEG-2 display aspect ratios by aspect_ratio_information (1 = square pixels). */
const MPEG2_ASPECTS = [0, 0, 4 / 3, 16 / 9, 2.21]
/** MPEG-1 pixel aspect ratios (height / width of a pixel). */
const MPEG1_PIXEL_ASPECTS = [
  1, 1, 0.6735, 0.7031, 0.7615, 0.8055, 0.8437, 0.8935, 0.9157, 0.9815, 1.0255, 1.0695, 1.095, 1.1575, 1.2015, 1
]

/** Builds a lookup table indexed by the next `bits` bits: (length << 8) | value, 0 = no such code. */
function vlc(bits: number, codes: readonly (readonly [number, number])[], values?: readonly number[]): Uint16Array {
  const table = new Uint16Array(1 << bits)
  codes.forEach(([code, length], i) => {
    const value = values ? values[i] : i
    const shift = bits - length
    for (let k = code << shift; k < (code + 1) << shift; k++) table[k] = (length << 8) | value
  })
  return table
}

/** macroblock_address_increment: 1..33, 34 = escape (+33), 35 = stuffing. */
const MB_INCREMENT = vlc(
  11,
  [
    [1, 1], [3, 3], [2, 3], [3, 4], [2, 4], [3, 5], [2, 5], [7, 7], [6, 7], [11, 8], [10, 8], [9, 8], [8, 8], [7, 8], [6, 8], [23, 10],
    [22, 10], [21, 10], [20, 10], [19, 10], [18, 10], [35, 11], [34, 11], [33, 11], [32, 11], [31, 11], [30, 11], [29, 11], [28, 11],
    [27, 11], [26, 11], [25, 11], [24, 11], [8, 11], [15, 11]
  ],
  Array.from({ length: 35 }, (_, i) => i + 1)
)

const P_MB_TYPES = vlc(
  6,
  [[3, 5], [1, 2], [1, 3], [1, 1], [1, 6], [1, 5], [2, 5]],
  [INTRA, PATTERN, FWD, FWD | PATTERN, QUANT | INTRA, QUANT | PATTERN, QUANT | FWD | PATTERN]
)

const B_MB_TYPES = vlc(
  6,
  [[3, 5], [2, 3], [3, 3], [2, 4], [3, 4], [2, 2], [3, 2], [1, 6], [2, 6], [3, 6], [2, 5]],
  [
    INTRA, BWD, BWD | PATTERN, FWD, FWD | PATTERN, FWD | BWD, FWD | BWD | PATTERN, QUANT | INTRA, QUANT | BWD | PATTERN,
    QUANT | FWD | PATTERN, QUANT | FWD | BWD | PATTERN
  ]
)

/** coded_block_pattern, indexed by the pattern itself. */
const CODED_BLOCKS = vlc(9, [
  [1, 9], [11, 5], [9, 5], [13, 6], [13, 4], [23, 7], [19, 7], [31, 8], [12, 4], [22, 7], [18, 7], [30, 8], [19, 5], [27, 8], [23, 8],
  [19, 8], [11, 4], [21, 7], [17, 7], [29, 8], [17, 5], [25, 8], [21, 8], [17, 8], [15, 6], [15, 8], [13, 8], [3, 9], [15, 5], [11, 8],
  [7, 8], [7, 9], [10, 4], [20, 7], [16, 7], [28, 8], [14, 6], [14, 8], [12, 8], [2, 9], [16, 5], [24, 8], [20, 8], [16, 8], [14, 5],
  [10, 8], [6, 8], [6, 9], [18, 5], [26, 8], [22, 8], [18, 8], [13, 5], [9, 8], [5, 8], [5, 9], [12, 5], [8, 8], [4, 8], [4, 9], [7, 3],
  [10, 5], [8, 5], [12, 6]
])

/** motion_code magnitude 0..16 (a sign bit follows non-zero codes). */
const MOTION_CODES = vlc(10, [
  [1, 1], [1, 2], [1, 3], [1, 4], [3, 6], [5, 7], [4, 7], [3, 7], [11, 9], [10, 9], [9, 9], [17, 10], [16, 10], [15, 10], [14, 10],
  [13, 10], [12, 10]
])

const DC_LUMA_SIZES = vlc(10, [[4, 3], [0, 2], [1, 2], [5, 3], [6, 3], [14, 4], [30, 5], [62, 6], [126, 7], [254, 8], [510, 9], [511, 9]])
const DC_CHROMA_SIZES = vlc(10, [
  [0, 2], [1, 2], [2, 2], [6, 3], [14, 4], [30, 5], [62, 6], [126, 7], [254, 8], [510, 9], [1022, 10], [1023, 10]
])

// DCT coefficient tables B-14 and B-15: codes for (run, level) pairs, in the
// same order: run 0 with levels 1..40, run 1 with 1..18, run 2 with 1..5...
const LEVELS_PER_RUN = [40, 18, 5, 4, 3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, ...Array<number>(15).fill(1)]
const RUNS = LEVELS_PER_RUN.flatMap((count, run) => Array<number>(count).fill(run))
const LEVELS = LEVELS_PER_RUN.flatMap((count) => Array.from({ length: count }, (_, i) => i + 1))
const B14_CODES: [number, number][] = [
  [3, 2], [4, 4], [5, 5], [6, 7], [38, 8], [33, 8], [10, 10], [29, 12], [24, 12], [19, 12], [16, 12], [26, 13], [25, 13], [24, 13],
  [23, 13], [31, 14], [30, 14], [29, 14], [28, 14], [27, 14], [26, 14], [25, 14], [24, 14], [23, 14], [22, 14], [21, 14], [20, 14],
  [19, 14], [18, 14], [17, 14], [16, 14], [24, 15], [23, 15], [22, 15], [21, 15], [20, 15], [19, 15], [18, 15], [17, 15], [16, 15],
  [3, 3], [6, 6], [37, 8], [12, 10], [27, 12], [22, 13], [21, 13], [31, 15], [30, 15], [29, 15], [28, 15], [27, 15], [26, 15], [25, 15],
  [19, 16], [18, 16], [17, 16], [16, 16], [5, 4], [4, 7], [11, 10], [20, 12], [20, 13], [7, 5], [36, 8], [28, 12], [19, 13], [6, 5],
  [15, 10], [18, 12], [7, 6], [9, 10], [18, 13], [5, 6], [30, 12], [20, 16], [4, 6], [21, 12], [7, 7], [17, 12], [5, 7], [17, 13],
  [39, 8], [16, 13], [35, 8], [26, 16], [34, 8], [25, 16], [32, 8], [24, 16], [14, 10], [23, 16], [13, 10], [22, 16], [8, 10], [21, 16],
  [31, 12], [26, 12], [25, 12], [23, 12], [22, 12], [31, 13], [30, 13], [29, 13], [28, 13], [27, 13], [31, 16], [30, 16], [29, 16],
  [28, 16], [27, 16]
]
const B15_CODES: [number, number][] = [
  [2, 2], [6, 3], [7, 4], [28, 5], [29, 5], [5, 6], [4, 6], [123, 7], [124, 7], [35, 8], [34, 8], [250, 8], [251, 8], [254, 8], [255, 8],
  [31, 14], [30, 14], [29, 14], [28, 14], [27, 14], [26, 14], [25, 14], [24, 14], [23, 14], [22, 14], [21, 14], [20, 14], [19, 14],
  [18, 14], [17, 14], [16, 14], [24, 15], [23, 15], [22, 15], [21, 15], [20, 15], [19, 15], [18, 15], [17, 15], [16, 15], [2, 3],
  [6, 5], [121, 7], [39, 8], [32, 8], [22, 13], [21, 13], [31, 15], [30, 15], [29, 15], [28, 15], [27, 15], [26, 15], [25, 15], [19, 16],
  [18, 16], [17, 16], [16, 16], [5, 5], [7, 7], [252, 8], [12, 10], [20, 13], [7, 5], [38, 8], [28, 12], [19, 13], [6, 6], [253, 8],
  [18, 12], [7, 6], [4, 9], [18, 13], [6, 7], [30, 12], [20, 16], [4, 7], [21, 12], [5, 7], [17, 12], [120, 7], [17, 13], [122, 7],
  [16, 13], [33, 8], [26, 16], [37, 8], [25, 16], [36, 8], [24, 16], [5, 9], [23, 16], [7, 9], [22, 16], [13, 10], [21, 16], [31, 12],
  [26, 12], [25, 12], [23, 12], [22, 12], [31, 13], [30, 13], [29, 13], [28, 13], [27, 13], [31, 16], [30, 16], [29, 16], [28, 16],
  [27, 16]
]

const EOB = 64
const ESCAPE = 65

/** 16-bit lookup of a DCT coefficient table: length | run << 8 | level << 16 (run 64 = end of block, 65 = escape). */
function coefficientTable(codes: [number, number][], eob: [number, number]): Int32Array {
  const table = new Int32Array(1 << 16)
  const put = (code: number, length: number, packed: number): void => {
    const shift = 16 - length
    table.fill(packed | length, code << shift, (code + 1) << shift)
  }
  codes.forEach(([code, length], i) => put(code, length, (RUNS[i] << 8) | (LEVELS[i] << 16)))
  put(eob[0], eob[1], EOB << 8)
  put(1, 6, ESCAPE << 8)
  return table
}

const B14 = coefficientTable(B14_CODES, [2, 2])
const B15 = coefficientTable(B15_CODES, [6, 4])

/** IDCT basis: COS[u * 8 + x], scaled so a 2D transform is two 1D passes. */
const COS = new Float64Array(64)
for (let u = 0; u < 8; u++) {
  for (let x = 0; x < 8; x++) COS[u * 8 + x] = (u === 0 ? Math.SQRT1_2 / 2 : 0.5) * Math.cos(((2 * x + 1) * u * Math.PI) / 16)
}

class Bits {
  data: Uint8Array
  /** Position in bits. */
  pos = 0

  constructor(data: Uint8Array) {
    this.data = data
  }

  /** The next n bits (n <= 24) without moving. */
  peek(n: number): number {
    const d = this.data
    const i = this.pos >>> 3
    const word = (d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]
    return (word << (this.pos & 7)) >>> (32 - n)
  }

  read(n: number): number {
    const value = this.peek(n)
    this.pos += n
    return value
  }

  skip(n: number): void {
    this.pos += n
  }
}

/** A damaged slice: decoding goes on with the next one. */
class SliceError extends Error {}

interface Frame extends DecodedPicture {
  /** Fields decoded so far: 1 top, 2 bottom, 3 both. */
  fields: number
}

export class Mpeg2VideoDecoder {
  sequence: SequenceInfo | null = null

  private output: DecodedPicture[] = []

  // Elementary stream bytes not decoded yet, and where its pieces' time stamps belong.
  private es = new Uint8Array(1 << 20)
  private esLength = 0
  /** Stream position of es[0]. */
  private esBase = 0
  private scanFrom = 0
  /** Start of the unit being collected (its start code), -1 before the first. */
  private unitStart = -1
  private stamps: { position: number; pts: number; used: boolean }[] = []

  // Sequence.
  private seqWidth = 0
  private seqHeight = 0
  private aspectCode = 0
  private frameRateCode = 0
  private frameRateExtN = 0
  private frameRateExtD = 0
  private progressiveSequence = true
  private mpeg2 = false
  private intraMatrix = new Uint8Array(DEFAULT_INTRA)
  private nonIntraMatrix = new Uint8Array(64).fill(16)
  private chromaIntraMatrix = new Uint8Array(DEFAULT_INTRA)
  private chromaNonIntraMatrix = new Uint8Array(64).fill(16)
  private width = 0
  private height = 0
  private mbWidth = 0
  private mbHeight = 0
  private stride = 0
  private lines = 0

  // Picture.
  private havePicture = false
  private pictureStarted = false
  private skipPicture = false
  private type = 0
  private pts: number | null = null
  private fCode = [new Int32Array(2), new Int32Array(2)]
  private fullPel = [false, false]
  private intraDcPrecision = 0
  private structure = 3
  private topFieldFirst = true
  private framePredFrameDct = true
  private concealment = false
  private qScaleType = 0
  private intraVlcFormat = false
  private alternateScan = false
  private repeatFirstField = false
  private progressiveFrame = true
  /** Frame picture (not a field). */
  private frame = true
  /** Parity of a field picture: 0 top, 1 bottom. */
  private parity = 0
  private secondField = false

  // References and the frame being decoded.
  private forward: Frame | null = null
  private backward: Frame | null = null
  private current: Frame | null = null

  // Macroblock state.
  private quantiserScale = 0
  private dcPred = new Int32Array(3)
  /** PMV[r][s][t]: motion vector predictors (r first/second vector, s forward/backward, t horizontal/vertical). */
  private pmv = [
    [new Int32Array(2), new Int32Array(2)],
    [new Int32Array(2), new Int32Array(2)]
  ]
  private mv = [
    [new Int32Array(2), new Int32Array(2)],
    [new Int32Array(2), new Int32Array(2)]
  ]
  /** fieldSelect[r][s]. */
  private fieldSelect = [new Int32Array(2), new Int32Array(2)]
  private dmvector = new Int32Array(2)
  private lastFlags = 0
  private lastMotionType = 2

  private block = new Int32Array(64)
  private rowMax = new Int8Array(8).fill(-1)
  private idctRows = new Float64Array(64)

  /** Elementary stream bytes from one PES packet, with its time stamp. */
  push(data: Uint8Array, pts: number | null): void {
    // Four spare bytes stay at the end: the bit reader looks ahead.
    if (this.esLength + data.length + 4 > this.es.length) {
      const from = Math.max(0, this.unitStart)
      const kept = this.esLength - from
      const next = kept + data.length + 4 > this.es.length ? new Uint8Array((kept + data.length) * 2 + 4) : this.es
      next.set(this.es.subarray(from, this.esLength))
      this.es = next
      this.esBase += from
      this.esLength = kept
      this.scanFrom -= from
      if (this.unitStart >= 0) this.unitStart = 0
    }
    if (pts !== null) this.stamps.push({ position: this.esBase + this.esLength, pts, used: false })
    this.es.set(data, this.esLength)
    this.esLength += data.length
    this.scan(false)
  }

  /** End of the stream: decodes what is left and lets the last pictures out. */
  flush(): void {
    this.scan(true)
    if (this.pictureStarted) this.endPicture()
    if (this.current) this.completeFrame()
    if (this.backward) this.output.push(this.backward)
    this.backward = this.forward = null
  }

  /** Pictures decoded so far, in display order. */
  take(): DecodedPicture[] {
    const out = this.output
    this.output = []
    return out
  }

  private scan(end: boolean): void {
    const d = this.es
    const length = this.esLength
    d.fill(0, length, length + 4)
    const view = d.subarray(0, length)
    let i = Math.max(this.scanFrom, 0)
    for (;;) {
      let found = -1
      let j = i + 2
      while (j + 1 < length) {
        j = view.indexOf(1, j)
        if (j < 0 || j + 1 >= length) break
        if (d[j - 1] === 0 && d[j - 2] === 0) {
          found = j - 2
          break
        }
        j++
      }
      if (found < 0) {
        this.scanFrom = Math.max(i, length - 3)
        break
      }
      if (this.unitStart >= 0) this.unit(this.unitStart)
      this.unitStart = found
      i = found + 3
    }
    if (end && this.unitStart >= 0 && this.unitStart + 4 <= length) {
      this.unit(this.unitStart)
      this.unitStart = -1
    }
  }

  private unit(start: number): void {
    const code = this.es[start + 3]
    if (code >= 0x01 && code <= 0xaf) {
      this.slice(start, code)
      return
    }
    if (this.pictureStarted) this.endPicture()
    const bits = new Bits(this.es)
    bits.pos = (start + 4) * 8
    if (code === 0x00) this.pictureHeader(bits, start)
    else if (code === 0xb3) this.sequenceHeader(bits)
    else if (code === 0xb5) this.extension(bits)
  }

  private sequenceHeader(b: Bits): void {
    this.seqWidth = b.read(12)
    this.seqHeight = b.read(12)
    this.aspectCode = b.read(4)
    this.frameRateCode = b.read(4)
    b.skip(18 + 1 + 10 + 1)
    if (b.read(1)) for (let i = 0; i < 64; i++) this.intraMatrix[ZIGZAG[i]] = b.read(8)
    else this.intraMatrix.set(DEFAULT_INTRA)
    if (b.read(1)) for (let i = 0; i < 64; i++) this.nonIntraMatrix[ZIGZAG[i]] = b.read(8)
    else this.nonIntraMatrix.fill(16)
    this.chromaIntraMatrix.set(this.intraMatrix)
    this.chromaNonIntraMatrix.set(this.nonIntraMatrix)
    this.mpeg2 = false
    this.progressiveSequence = true
    this.frameRateExtN = this.frameRateExtD = 0
  }

  private extension(b: Bits): void {
    const id = b.read(4)
    if (id === 1) {
      // Sequence extension: this is MPEG-2.
      this.mpeg2 = true
      b.skip(8)
      this.progressiveSequence = b.read(1) === 1
      const chroma = b.read(2)
      if (chroma !== 1) throw new Error('only 4:2:0 MPEG-2 video is supported')
      this.seqWidth |= b.read(2) << 12
      this.seqHeight |= b.read(2) << 12
      b.skip(12 + 1 + 8 + 1)
      this.frameRateExtN = b.read(2)
      this.frameRateExtD = b.read(5)
    } else if (id === 3) {
      // Quant matrix extension.
      if (b.read(1)) {
        for (let i = 0; i < 64; i++) this.intraMatrix[ZIGZAG[i]] = b.read(8)
        this.chromaIntraMatrix.set(this.intraMatrix)
      }
      if (b.read(1)) {
        for (let i = 0; i < 64; i++) this.nonIntraMatrix[ZIGZAG[i]] = b.read(8)
        this.chromaNonIntraMatrix.set(this.nonIntraMatrix)
      }
      if (b.read(1)) for (let i = 0; i < 64; i++) this.chromaIntraMatrix[ZIGZAG[i]] = b.read(8)
      if (b.read(1)) for (let i = 0; i < 64; i++) this.chromaNonIntraMatrix[ZIGZAG[i]] = b.read(8)
    } else if (id === 8 && this.havePicture) {
      // Picture coding extension.
      this.fCode[0][0] = b.read(4)
      this.fCode[0][1] = b.read(4)
      this.fCode[1][0] = b.read(4)
      this.fCode[1][1] = b.read(4)
      this.intraDcPrecision = b.read(2)
      this.structure = b.read(2)
      this.topFieldFirst = b.read(1) === 1
      this.framePredFrameDct = b.read(1) === 1
      this.concealment = b.read(1) === 1
      this.qScaleType = b.read(1)
      this.intraVlcFormat = b.read(1) === 1
      this.alternateScan = b.read(1) === 1
      this.repeatFirstField = b.read(1) === 1
      b.skip(1)
      this.progressiveFrame = b.read(1) === 1
    }
  }

  private pictureHeader(b: Bits, start: number): void {
    b.skip(10)
    this.type = b.read(3)
    b.skip(16)
    if (this.type === P_TYPE || this.type === B_TYPE) {
      this.fullPel[0] = b.read(1) === 1
      this.fCode[0][0] = this.fCode[0][1] = b.read(3)
    }
    if (this.type === B_TYPE) {
      this.fullPel[1] = b.read(1) === 1
      this.fCode[1][0] = this.fCode[1][1] = b.read(3)
    }
    // MPEG-1 has no picture coding extension: these are its fixed values.
    this.intraDcPrecision = 0
    this.structure = 3
    this.topFieldFirst = true
    this.framePredFrameDct = true
    this.concealment = false
    this.qScaleType = 0
    this.intraVlcFormat = false
    this.alternateScan = false
    this.repeatFirstField = false
    this.progressiveFrame = true
    this.havePicture = this.type >= I_TYPE && this.type <= B_TYPE
    this.pts = this.stampAt(this.esBase + start)
  }

  /** The time stamp of the PES packet in which a picture's start code begins (each is used once). */
  private stampAt(position: number): number | null {
    let found: { position: number; pts: number; used: boolean } | null = null
    let drop = 0
    for (let i = 0; i < this.stamps.length; i++) {
      if (this.stamps[i].position > position) break
      found = this.stamps[i]
      drop = i
    }
    this.stamps.splice(0, drop)
    if (!found || found.used) return null
    found.used = true
    return found.pts
  }

  private setUpSequence(): void {
    const width = this.seqWidth
    const height = this.seqHeight
    const interlaced = this.mpeg2 && !this.progressiveSequence
    const mbHeight = interlaced ? 2 * ((height + 31) >> 5) : (height + 15) >> 4
    if (width === this.width && height === this.height && mbHeight === this.mbHeight && this.sequence) return
    if (!width || !height) throw new Error('no sequence header')
    this.width = width
    this.height = height
    this.mbWidth = (width + 15) >> 4
    this.mbHeight = mbHeight
    this.stride = this.mbWidth * 16
    this.lines = mbHeight * 16
    this.forward = this.backward = null
    let aspect = width / height
    if (this.mpeg2) aspect = MPEG2_ASPECTS[this.aspectCode] || aspect
    else aspect = width / (MPEG1_PIXEL_ASPECTS[this.aspectCode] || 1) / height
    let frameRate = FRAME_RATES[this.frameRateCode] || 25
    if (this.mpeg2) frameRate = (frameRate * (this.frameRateExtN + 1)) / (this.frameRateExtD + 1)
    this.sequence = { width, height, aspect, frameRate, progressive: !interlaced, mpeg2: this.mpeg2 }
  }

  private newFrame(): Frame {
    const size = this.stride * this.lines
    return {
      y: new Uint8Array(size),
      u: new Uint8Array(size >> 2).fill(128),
      v: new Uint8Array(size >> 2).fill(128),
      stride: this.stride,
      lines: this.lines,
      width: this.width,
      height: this.height,
      pts: this.pts,
      progressive: this.progressiveFrame,
      topFieldFirst: this.topFieldFirst,
      repeatFirstField: this.repeatFirstField,
      type: this.type,
      fields: 0
    }
  }

  private startPicture(): void {
    this.pictureStarted = true
    this.setUpSequence()
    this.frame = this.structure === 3
    this.parity = this.structure === 2 ? 1 : 0
    const cur = this.current
    // The second field of a frame goes into the same frame.
    if (!this.frame && cur && cur.fields === (this.parity ? 1 : 2)) {
      this.secondField = true
      return
    }
    if (cur) this.completeFrame()
    this.secondField = false
    const frame = this.newFrame()
    if (this.type === B_TYPE) {
      this.skipPicture = !this.forward || !this.backward
    } else {
      this.skipPicture = this.type === P_TYPE && !this.backward
      if (this.backward) this.output.push(this.backward)
      this.forward = this.backward
      this.backward = frame
    }
    this.current = frame
  }

  private endPicture(): void {
    this.pictureStarted = false
    this.havePicture = false
    const cur = this.current
    if (!cur) return
    cur.fields |= this.frame ? 3 : this.parity ? 2 : 1
    if (cur.fields === 3) this.completeFrame()
  }

  private completeFrame(): void {
    const cur = this.current
    this.current = null
    if (!cur || this.skipPicture) return
    // B frames show as soon as they are decoded; I and P frames when the next one arrives.
    if (cur.type === B_TYPE) this.output.push(cur)
  }

  private slice(start: number, code: number): void {
    // Pictures before the first sequence header cannot be decoded.
    if (!this.havePicture || !this.seqWidth) return
    if (!this.pictureStarted) this.startPicture()
    if (this.skipPicture || !this.current) return
    const b = new Bits(this.es)
    b.pos = (start + 4) * 8
    try {
      let row = code - 1
      if (this.height > 2800) row += b.read(3) << 7
      this.quantiserScale = this.scaleOf(b.read(5))
      if (b.read(1)) {
        b.skip(8)
        while (b.read(1)) b.skip(8)
      }
      this.macroblocks(b, row)
    } catch (err) {
      if (!(err instanceof SliceError)) throw err
    }
  }

  private scaleOf(code: number): number {
    if (!this.mpeg2) return code
    return this.qScaleType ? NON_LINEAR_SCALE[code] : code * 2
  }

  private resetDc(): void {
    const reset = this.mpeg2 ? 1 << (7 + this.intraDcPrecision) : 128
    this.dcPred[0] = this.dcPred[1] = this.dcPred[2] = reset
  }

  private resetPmv(): void {
    for (const r of this.pmv) for (const s of r) s.fill(0)
  }

  private macroblocks(b: Bits, row: number): void {
    const mbWidth = this.mbWidth
    const rows = this.frame ? this.mbHeight : this.mbHeight >> 1
    if (row >= rows) return
    this.resetDc()
    this.resetPmv()
    let address = row * mbWidth - 1
    let first = true
    const last = mbWidth * rows
    for (;;) {
      let increment = 0
      for (;;) {
        const e = MB_INCREMENT[b.peek(11)]
        if (!e) throw new SliceError()
        b.skip(e >> 8)
        const value = e & 0xff
        if (value === 34) increment += 33
        else if (value !== 35) {
          increment += value
          break
        }
      }
      if (!first) for (let k = 1; k < increment; k++) this.skipped(address + k, mbWidth)
      first = false
      address += increment
      if (address >= last) throw new SliceError()
      this.macroblock(b, address % mbWidth, (address / mbWidth) | 0)
      if (b.peek(23) === 0) break
    }
  }

  private skipped(address: number, mbWidth: number): void {
    const x = address % mbWidth
    const y = (address / mbWidth) | 0
    this.resetDc()
    if (this.type === P_TYPE) {
      this.resetPmv()
      this.mv[0][0][0] = this.mv[0][0][1] = 0
      this.fieldSelect[0][0] = this.parity
      this.predict(x, y, FWD, this.frame ? 2 : 1)
    } else if (this.type === B_TYPE) {
      this.predict(x, y, this.lastFlags, this.lastMotionType)
    }
  }

  private macroblock(b: Bits, x: number, y: number): void {
    let flags: number
    if (this.type === I_TYPE) {
      if (b.read(1)) flags = INTRA
      else if (b.read(1)) flags = INTRA | QUANT
      else throw new SliceError()
    } else {
      const e = (this.type === P_TYPE ? P_MB_TYPES : B_MB_TYPES)[b.peek(6)]
      if (!e) throw new SliceError()
      b.skip(e >> 8)
      flags = e & 0xff
    }
    let motionType = 2
    let dctType = 0
    if (flags & (FWD | BWD)) {
      if (!this.mpeg2) motionType = 2
      else if (this.frame) motionType = this.framePredFrameDct ? 2 : b.read(2)
      else motionType = b.read(2)
      if (motionType === 0) throw new SliceError()
    }
    if (this.frame && !this.framePredFrameDct && flags & (INTRA | PATTERN)) dctType = b.read(1)
    if (flags & QUANT) this.quantiserScale = this.scaleOf(b.read(5))

    if (flags & INTRA) {
      if (this.concealment) {
        this.motionVectors(b, 0, this.frame ? 2 : 1)
        b.skip(1)
      } else this.resetPmv()
      for (let i = 0; i < 6; i++) this.intraBlock(b, i, x, y, dctType)
      this.lastFlags = 0
      return
    }
    this.resetDc()
    if (flags & FWD) this.motionVectors(b, 0, motionType)
    if (flags & BWD) this.motionVectors(b, 1, motionType)
    if (!(flags & (FWD | BWD))) {
      // P macroblock without motion compensation: the same place in the reference.
      this.resetPmv()
      motionType = this.frame ? 2 : 1
      this.mv[0][0][0] = this.mv[0][0][1] = 0
      this.fieldSelect[0][0] = this.parity
      flags |= FWD
    }
    this.predict(x, y, flags, motionType)
    this.lastFlags = flags & (FWD | BWD)
    this.lastMotionType = motionType
    if (flags & PATTERN) {
      const e = CODED_BLOCKS[b.peek(9)]
      if (!e) throw new SliceError()
      b.skip(e >> 8)
      const pattern = e & 0xff
      for (let i = 0; i < 6; i++) if (pattern & (32 >> i)) this.interBlock(b, i, x, y, dctType)
    }
  }

  private motionVectors(b: Bits, s: number, motionType: number): void {
    let count = 1
    let fieldFormat = false
    let dualPrime = false
    if (this.mpeg2) {
      if (this.frame) {
        if (motionType === 1) {
          count = 2
          fieldFormat = true
        } else if (motionType === 3) fieldFormat = dualPrime = true
      } else {
        fieldFormat = true
        if (motionType === 2) count = 2
        else if (motionType === 3) dualPrime = true
      }
    }
    if (count === 1) {
      if (fieldFormat && !dualPrime) this.fieldSelect[0][s] = b.read(1)
      this.motionVector(b, 0, s, fieldFormat && this.frame, dualPrime)
      this.pmv[1][s][0] = this.pmv[0][s][0]
      this.pmv[1][s][1] = this.pmv[0][s][1]
    } else {
      this.fieldSelect[0][s] = b.read(1)
      this.motionVector(b, 0, s, this.frame, false)
      this.fieldSelect[1][s] = b.read(1)
      this.motionVector(b, 1, s, this.frame, false)
    }
  }

  private motionVector(b: Bits, r: number, s: number, fieldInFrame: boolean, dualPrime: boolean): void {
    for (let t = 0; t < 2; t++) {
      const rSize = this.fCode[s][t] - 1
      const e = MOTION_CODES[b.peek(10)]
      if (!e) throw new SliceError()
      b.skip(e >> 8)
      let code = e & 0xff
      if (code && b.read(1)) code = -code
      const residual = rSize > 0 && code !== 0 ? b.read(rSize) : 0
      if (dualPrime) this.dmvector[t] = b.read(1) ? (b.read(1) ? -1 : 1) : 0
      let delta = 0
      if (code !== 0) {
        delta = ((Math.abs(code) - 1) << rSize) + residual + 1
        if (code < 0) delta = -delta
      }
      const halve = fieldInFrame && t === 1
      const prediction = halve ? this.pmv[r][s][t] >> 1 : this.pmv[r][s][t]
      let vector = prediction + delta
      const low = -(16 << rSize)
      const high = (16 << rSize) - 1
      if (vector < low) vector += 32 << rSize
      else if (vector > high) vector -= 32 << rSize
      this.mv[r][s][t] = vector
      this.pmv[r][s][t] = halve ? vector * 2 : vector
    }
  }

  // Motion compensation.

  private predict(x: number, y: number, flags: number, motionType: number): void {
    let average = false
    if (flags & FWD) {
      this.predictFrom(0, x, y, motionType, false)
      average = true
    }
    if (flags & BWD) this.predictFrom(1, x, y, motionType, average)
  }

  private predictFrom(s: number, x: number, y: number, motionType: number, average: boolean): void {
    const ref = s === 0 ? this.forward : this.backward
    if (!ref) return
    const mv = this.mv
    const select = this.fieldSelect
    if (this.frame) {
      if (!this.mpeg2 || motionType === 2) {
        const scale = !this.mpeg2 && this.fullPel[s] ? 2 : 1
        this.motion(ref, -1, -1, x * 16, y * 16, 8, mv[0][s][0] * scale, mv[0][s][1] * scale, average)
      } else if (motionType === 1) {
        this.motion(ref, select[0][s], 0, x * 16, y * 8, 4, mv[0][s][0], mv[0][s][1], average)
        this.motion(ref, select[1][s], 1, x * 16, y * 8, 4, mv[1][s][0], mv[1][s][1], average)
      } else {
        // Dual prime: each field averages its own parity and the other one, through derived vectors.
        const mx = mv[0][0][0]
        const my = mv[0][0][1]
        const m = this.topFieldFirst ? 1 : 3
        const pos = (v: number): number => (v > 0 ? 1 : 0)
        const topX = ((mx * m + pos(mx)) >> 1) + this.dmvector[0]
        const topY = ((my * m + pos(my)) >> 1) + this.dmvector[1] - 1
        const bottomX = ((mx * (4 - m) + pos(mx)) >> 1) + this.dmvector[0]
        const bottomY = ((my * (4 - m) + pos(my)) >> 1) + this.dmvector[1] + 1
        this.motion(ref, 0, 0, x * 16, y * 8, 4, mx, my, false)
        this.motion(ref, 1, 0, x * 16, y * 8, 4, topX, topY, true)
        this.motion(ref, 1, 1, x * 16, y * 8, 4, mx, my, false)
        this.motion(ref, 0, 1, x * 16, y * 8, 4, bottomX, bottomY, true)
      }
      return
    }
    const p = this.parity
    // The second field of a P frame can point at the first one.
    const fieldRef = (field: number): Frame => (s === 0 && this.secondField && this.type === P_TYPE && field !== p && this.current ? this.current : ref)
    if (motionType === 1) {
      const f = select[0][s]
      this.motion(fieldRef(f), f, p, x * 16, y * 16, 8, mv[0][s][0], mv[0][s][1], average)
    } else if (motionType === 2) {
      const f0 = select[0][s]
      const f1 = select[1][s]
      this.motion(fieldRef(f0), f0, p, x * 16, y * 16, 4, mv[0][s][0], mv[0][s][1], average)
      this.motion(fieldRef(f1), f1, p, x * 16, y * 16 + 8, 4, mv[1][s][0], mv[1][s][1], average)
    } else {
      const mx = mv[0][0][0]
      const my = mv[0][0][1]
      const ox = ((mx + (mx > 0 ? 1 : 0)) >> 1) + this.dmvector[0]
      const oy = ((my + (my > 0 ? 1 : 0)) >> 1) + this.dmvector[1] + (p === 0 ? -1 : 1)
      this.motion(fieldRef(p), p, p, x * 16, y * 16, 8, mx, my, false)
      this.motion(fieldRef(1 - p), 1 - p, p, x * 16, y * 16, 8, ox, oy, true)
    }
  }

  /**
   * Predicts a 16-wide luma area (and its chroma) of the current frame from a
   * reference. `srcField`/`dstField` -1 = frame lines, 0/1 = that field's
   * lines; `x`, `y` are in the destination's (field) coordinates; `halfHeight`
   * is the chroma height (luma is twice that).
   */
  private motion(
    ref: Frame,
    srcField: number,
    dstField: number,
    x: number,
    y: number,
    halfHeight: number,
    mvx: number,
    mvy: number,
    average: boolean
  ): void {
    const cur = this.current as Frame
    const stride = this.stride
    const fieldSrc = srcField >= 0
    const fieldDst = dstField >= 0
    // Luma.
    const srcStep = fieldSrc ? stride * 2 : stride
    const srcLines = fieldSrc ? this.lines >> 1 : this.lines
    const dstStep = fieldDst ? stride * 2 : stride
    predictBlock(
      ref.y, fieldSrc ? srcField * stride : 0, srcStep, stride, srcLines,
      x + (mvx >> 1), y + (mvy >> 1), mvx & 1, mvy & 1,
      cur.y, (fieldDst ? dstField * stride : 0) + y * dstStep + x, dstStep, 16, halfHeight * 2, average
    )
    // Chroma: half the vector, rounded towards zero.
    const cs = stride >> 1
    const cmx = (mvx / 2) | 0
    const cmy = (mvy / 2) | 0
    const cSrcStep = fieldSrc ? cs * 2 : cs
    const cLines = fieldSrc ? this.lines >> 2 : this.lines >> 1
    const cDstStep = fieldDst ? cs * 2 : cs
    const cx = (x >> 1) + (cmx >> 1)
    const cy = (y >> 1) + (cmy >> 1)
    const dst = (fieldDst ? dstField * cs : 0) + (y >> 1) * cDstStep + (x >> 1)
    const srcOff = fieldSrc ? srcField * cs : 0
    predictBlock(ref.u, srcOff, cSrcStep, cs, cLines, cx, cy, cmx & 1, cmy & 1, cur.u, dst, cDstStep, 8, halfHeight, average)
    predictBlock(ref.v, srcOff, cSrcStep, cs, cLines, cx, cy, cmx & 1, cmy & 1, cur.v, dst, cDstStep, 8, halfHeight, average)
  }

  // Blocks.

  /** Where block i of macroblock (x, y) goes: plane, offset and line step. */
  private blockPlace(i: number, x: number, y: number, dctType: number): [Uint8Array, number, number] {
    const cur = this.current as Frame
    const stride = this.stride
    if (i < 4) {
      const left = x * 16 + (i & 1) * 8
      if (!this.frame) return [cur.y, (2 * (y * 16 + (i >> 1) * 8) + this.parity) * stride + left, stride * 2]
      if (dctType) return [cur.y, (y * 16 + (i >> 1)) * stride + left, stride * 2]
      return [cur.y, (y * 16 + (i >> 1) * 8) * stride + left, stride]
    }
    const plane = i === 4 ? cur.u : cur.v
    const cs = stride >> 1
    if (!this.frame) return [plane, (2 * y * 8 + this.parity) * cs + x * 8, cs * 2]
    return [plane, y * 8 * cs + x * 8, cs]
  }

  private intraBlock(b: Bits, i: number, x: number, y: number, dctType: number): void {
    const cc = i < 4 ? 0 : i - 3
    const e = (cc === 0 ? DC_LUMA_SIZES : DC_CHROMA_SIZES)[b.peek(10)]
    if (!e) throw new SliceError()
    b.skip(e >> 8)
    const size = e & 0xff
    let diff = 0
    if (size) {
      diff = b.read(size)
      if (diff < 1 << (size - 1)) diff -= (1 << size) - 1
    }
    this.dcPred[cc] += diff
    const dc = this.mpeg2 ? this.dcPred[cc] * (8 >> this.intraDcPrecision) : this.dcPred[cc] * 8
    this.put(0, dc)
    const matrix = cc === 0 ? this.intraMatrix : this.chromaIntraMatrix
    this.coefficients(b, 1, this.intraVlcFormat ? B15 : B14, matrix, true, dc)
    const [plane, offset, step] = this.blockPlace(i, x, y, dctType)
    this.idct(plane, offset, step, false)
  }

  private interBlock(b: Bits, i: number, x: number, y: number, dctType: number): void {
    const matrix = i < 4 ? this.nonIntraMatrix : this.chromaNonIntraMatrix
    this.coefficients(b, 0, B14, matrix, false, 0)
    const [plane, offset, step] = this.blockPlace(i, x, y, dctType)
    this.idct(plane, offset, step, true)
  }

  private put(position: number, value: number): void {
    this.block[position] = value
    const row = position >> 3
    if ((position & 7) > this.rowMax[row]) this.rowMax[row] = position & 7
  }

  /** Reads a block's coefficients from index `n` on, dequantized into `block`. */
  private coefficients(b: Bits, n: number, table: Int32Array, matrix: Uint8Array, intra: boolean, sum: number): void {
    const scan = this.alternateScan ? ALTERNATE : ZIGZAG
    const mpeg2 = this.mpeg2
    const qs = this.quantiserScale
    // The first coefficient of a non-intra block has a shorter code for (0, ±1).
    if (!intra && b.peek(1)) {
      b.skip(1)
      const level = b.read(1) ? -1 : 1
      sum += this.store(scan[0], level, matrix, qs, intra, mpeg2)
      n = 1
    }
    for (;;) {
      const e = table[b.peek(16)]
      const length = e & 0xff
      if (!length) throw new SliceError()
      const run = (e >> 8) & 0xff
      if (run === EOB) {
        b.skip(length)
        break
      }
      let level: number
      let skip: number
      if (run === ESCAPE) {
        b.skip(6)
        skip = b.read(6)
        if (mpeg2) {
          level = b.read(12)
          if (level >= 2048) level -= 4096
        } else {
          level = b.read(8)
          if (level === 0) level = b.read(8)
          else if (level === 128) level = b.read(8) - 256
          else if (level > 128) level -= 256
        }
        if (level === 0) throw new SliceError()
      } else {
        b.skip(length)
        skip = run
        level = e >> 16
        if (b.read(1)) level = -level
      }
      n += skip
      if (n > 63) throw new SliceError()
      sum += this.store(scan[n], level, matrix, qs, intra, mpeg2)
      n++
    }
    // MPEG-2 mismatch control: the sum of the coefficients must be odd.
    if (mpeg2 && (sum & 1) === 0) this.put(63, this.block[63] ^ 1)
  }

  private store(position: number, level: number, matrix: Uint8Array, qs: number, intra: boolean, mpeg2: boolean): number {
    const w = matrix[position]
    let value: number
    if (intra) {
      const t = level * w * qs
      value = mpeg2 ? (t >= 0 ? t >> 4 : -(-t >> 4)) : t >= 0 ? t >> 3 : -(-t >> 3)
    } else {
      const t = (2 * level + (level > 0 ? 1 : -1)) * w * qs
      value = mpeg2 ? (t >= 0 ? t >> 5 : -(-t >> 5)) : t >= 0 ? t >> 4 : -(-t >> 4)
    }
    // MPEG-1 makes every coefficient odd instead of the mismatch control.
    if (!mpeg2 && value !== 0 && (value & 1) === 0) value -= value > 0 ? 1 : -1
    if (value > 2047) value = 2047
    else if (value < -2048) value = -2048
    this.put(position, value)
    return value
  }

  /** Inverse DCT of `block` into the plane (or added to the prediction there), then clears the block. */
  private idct(plane: Uint8Array, offset: number, step: number, add: boolean): void {
    const block = this.block
    const rowMax = this.rowMax
    const tmp = this.idctRows
    let rows = 0
    for (let v = 0; v < 8; v++) if (rowMax[v] >= 0) rows |= 1 << v
    if (rows === 1 && rowMax[0] === 0) {
      // Only the DC coefficient: a flat block.
      const dc = Math.floor(block[0] / 8 + 0.5)
      block[0] = 0
      rowMax[0] = -1
      for (let yy = 0; yy < 8; yy++) {
        const o = offset + yy * step
        for (let xx = 0; xx < 8; xx++) {
          let value = add ? plane[o + xx] + dc : dc
          value = value < 0 ? 0 : value > 255 ? 255 : value
          plane[o + xx] = value
        }
      }
      return
    }
    // Rows: horizontal transforms of the rows that have coefficients.
    for (let v = 0; v < 8; v++) {
      if (!(rows & (1 << v))) continue
      const last = rowMax[v]
      const base = v * 8
      for (let xx = 0; xx < 8; xx++) {
        let sum = 0
        for (let u = 0; u <= last; u++) sum += COS[u * 8 + xx] * block[base + u]
        tmp[base + xx] = sum
      }
      for (let u = 0; u <= last; u++) block[base + u] = 0
      rowMax[v] = -1
    }
    // Columns.
    for (let yy = 0; yy < 8; yy++) {
      const o = offset + yy * step
      for (let xx = 0; xx < 8; xx++) {
        let sum = 0
        for (let v = 0; v < 8; v++) if (rows & (1 << v)) sum += COS[v * 8 + yy] * tmp[v * 8 + xx]
        let value = Math.floor(sum + 0.5)
        if (add) value += plane[o + xx]
        plane[o + xx] = value < 0 ? 0 : value > 255 ? 255 : value
      }
    }
  }
}

/**
 * Copies (or averages into `dst`) a w×h block from `src` at integer position
 * (ix, iy) plus half a sample right (hx) and down (hy), with the usual
 * rounding. Positions outside the source repeat its edges.
 */
function predictBlock(
  src: Uint8Array,
  srcOffset: number,
  srcStep: number,
  srcWidth: number,
  srcLines: number,
  ix: number,
  iy: number,
  hx: number,
  hy: number,
  dst: Uint8Array,
  dstOffset: number,
  dstStep: number,
  w: number,
  h: number,
  average: boolean
): void {
  if (ix < 0 || iy < 0 || ix + w + hx > srcWidth || iy + h + hy > srcLines) {
    const at = (xx: number, yy: number): number =>
      src[srcOffset + Math.min(Math.max(yy, 0), srcLines - 1) * srcStep + Math.min(Math.max(xx, 0), srcWidth - 1)]
    for (let r = 0; r < h; r++) {
      const d = dstOffset + r * dstStep
      for (let c = 0; c < w; c++) {
        const xx = ix + c
        const yy = iy + r
        let value: number
        if (hx && hy) value = (at(xx, yy) + at(xx + 1, yy) + at(xx, yy + 1) + at(xx + 1, yy + 1) + 2) >> 2
        else if (hx) value = (at(xx, yy) + at(xx + 1, yy) + 1) >> 1
        else if (hy) value = (at(xx, yy) + at(xx, yy + 1) + 1) >> 1
        else value = at(xx, yy)
        dst[d + c] = average ? (dst[d + c] + value + 1) >> 1 : value
      }
    }
    return
  }
  let s = srcOffset + iy * srcStep + ix
  let d = dstOffset
  if (!hx && !hy) {
    for (let r = 0; r < h; r++, s += srcStep, d += dstStep) {
      if (average) for (let c = 0; c < w; c++) dst[d + c] = (dst[d + c] + src[s + c] + 1) >> 1
      else for (let c = 0; c < w; c++) dst[d + c] = src[s + c]
    }
  } else if (hx && !hy) {
    for (let r = 0; r < h; r++, s += srcStep, d += dstStep) {
      for (let c = 0; c < w; c++) {
        const value = (src[s + c] + src[s + c + 1] + 1) >> 1
        dst[d + c] = average ? (dst[d + c] + value + 1) >> 1 : value
      }
    }
  } else if (!hx && hy) {
    for (let r = 0; r < h; r++, s += srcStep, d += dstStep) {
      for (let c = 0; c < w; c++) {
        const value = (src[s + c] + src[s + c + srcStep] + 1) >> 1
        dst[d + c] = average ? (dst[d + c] + value + 1) >> 1 : value
      }
    }
  } else {
    for (let r = 0; r < h; r++, s += srcStep, d += dstStep) {
      for (let c = 0; c < w; c++) {
        const value = (src[s + c] + src[s + c + 1] + src[s + c + srcStep] + src[s + c + srcStep + 1] + 2) >> 2
        dst[d + c] = average ? (dst[d + c] + value + 1) >> 1 : value
      }
    }
  }
}

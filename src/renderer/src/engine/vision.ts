import { FaceDetector, ImageSegmenter, InteractiveSegmenterLegacy } from '@mediapipe/tasks-vision'
import visionLoaderUrl from '@mediapipe/tasks-vision/vision_wasm_internal.js?url'
import visionWasmUrl from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url'
import faceModelUrl from '../assets/models/blaze_face_short_range.tflite?url'
import selfieModelUrl from '../assets/models/selfie_segmenter.tflite?url'
import magicTouchUrl from '../assets/models/magic_touch.tflite?url'
import { assetBlobUrl, assetBytes } from '../media/assets'

// MediaPipe face detection, person segmentation and object segmentation from a
// point (Smart Select), on the GPU through WebGL with a CPU fallback. The
// tasks' usage logs to Google are refused by noExternalRequests.ts.

type WasmFileset = Parameters<typeof FaceDetector.createFromOptions>[0]

let fileset: Promise<WasmFileset> | null = null

function wasmFileset(): Promise<WasmFileset> {
  fileset ??= Promise.all([assetBlobUrl(visionLoaderUrl, 'text/javascript'), assetBlobUrl(visionWasmUrl, 'application/wasm')]).then(
    ([wasmLoaderPath, wasmBinaryPath]) => ({ wasmLoaderPath, wasmBinaryPath })
  )
  return fileset
}

/** GPU first; if WebGL cannot run the model, the CPU (slower, same result). */
async function withDelegate<T>(create: (delegate: 'GPU' | 'CPU') => Promise<T>): Promise<T> {
  try {
    return await create('GPU')
  } catch (err) {
    console.warn('[vision] GPU delegate unavailable, using the CPU', err)
    return create('CPU')
  }
}

let faces: Promise<FaceDetector> | null = null

export function faceDetector(): Promise<FaceDetector> {
  faces ??= (async () => {
    const files = await wasmFileset()
    const model = await assetBytes(faceModelUrl)
    return withDelegate((delegate) =>
      FaceDetector.createFromOptions(files, {
        baseOptions: { modelAssetBuffer: model, delegate },
        runningMode: 'IMAGE',
        minDetectionConfidence: 0.45
      })
    )
  })()
  faces.catch(() => (faces = null))
  return faces
}

export interface Face {
  /** Center and size, as fractions of the image. */
  cx: number
  cy: number
  w: number
  h: number
  score: number
}

export async function detectFaces(image: TexImageSource & { width: number; height: number }): Promise<Face[]> {
  const detector = await faceDetector()
  const result = detector.detect(image)
  return result.detections
    .filter((d) => d.boundingBox)
    .map((d) => {
      const b = d.boundingBox as { originX: number; originY: number; width: number; height: number }
      return {
        cx: (b.originX + b.width / 2) / image.width,
        cy: (b.originY + b.height / 2) / image.height,
        w: b.width / image.width,
        h: b.height / image.height,
        score: d.categories[0]?.score ?? 0
      }
    })
}

// Segmentation

let segmenter: ImageSegmenter | null = null
let segmenterLoading: Promise<ImageSegmenter> | null = null
const readyListeners = new Set<() => void>()

/** Called once the person segmenter is loaded (the preview redraws). */
export function onSegmenterReady(listener: () => void): () => void {
  readyListeners.add(listener)
  return () => readyListeners.delete(listener)
}

export function prepareSegmenter(): Promise<ImageSegmenter> {
  segmenterLoading ??= (async () => {
    const files = await wasmFileset()
    const model = await assetBytes(selfieModelUrl)
    const created = await withDelegate((delegate) =>
      ImageSegmenter.createFromOptions(files, {
        baseOptions: { modelAssetBuffer: model, delegate },
        runningMode: 'IMAGE',
        outputConfidenceMasks: true,
        outputCategoryMask: false
      })
    )
    segmenter = created
    for (const listener of readyListeners) listener()
    return created
  })()
  segmenterLoading.catch((err: unknown) => {
    segmenterLoading = null
    console.error('[vision] cannot load the segmenter', err)
  })
  return segmenterLoading
}

export interface PersonMask {
  /** Person confidence 0..255, row 0 at the top. */
  data: Uint8Array
  width: number
  height: number
}

const previous = new Map<string, { time: number; mask: PersonMask }>()

/**
 * Where the person is in a frame (null until the model is loaded; the first
 * call starts loading it). Consecutive frames of the same event are blended a
 * little so the cutout edge does not shimmer.
 */
export function personMask(image: TexImageSource, key: string, time: number): PersonMask | null {
  if (!segmenter) {
    void prepareSegmenter()
    return null
  }
  const result = segmenter.segment(image)
  try {
    const mask = result.confidenceMasks?.[0]
    if (!mask) return null
    const values = mask.getAsFloat32Array()
    const data = new Uint8Array(values.length)
    for (let i = 0; i < values.length; i++) data[i] = Math.max(0, Math.min(255, Math.round(values[i] * 255)))
    const out = { data, width: mask.width, height: mask.height }
    const last = previous.get(key)
    if (last && last.mask.data.length === data.length && Math.abs(time - last.time) < 0.1 && time !== last.time) {
      for (let i = 0; i < data.length; i++) data[i] = (data[i] * 2 + last.mask.data[i]) / 3
    }
    previous.set(key, { time, mask: out })
    return out
  } finally {
    result.close()
  }
}

// Object segmentation (MagicTouch): the object under a point.

export interface ObjectMask {
  /** Object confidence 0..1 per pixel, row 0 at the top, at the image's size. */
  data: Float32Array
  width: number
  height: number
}

export interface ObjectSegmenter {
  /** True when it runs on the GPU (fast enough for every frame). */
  gpu: boolean
  /** The object under (x, y), fractions of the image. */
  segment(image: TexImageSource, x: number, y: number): ObjectMask | null
}

let objects: Promise<ObjectSegmenter> | null = null

export function objectSegmenter(): Promise<ObjectSegmenter> {
  objects ??= (async () => {
    const files = await wasmFileset()
    // This task does not take the model as a buffer: it gets a blob: URL.
    const model = await assetBlobUrl(magicTouchUrl, 'application/octet-stream')
    let gpu = true
    const task = await withDelegate((delegate) => {
      gpu = delegate === 'GPU'
      return InteractiveSegmenterLegacy.createFromOptions(files, {
        baseOptions: { modelAssetPath: model, delegate },
        outputConfidenceMasks: true,
        outputCategoryMask: false
      })
    })
    return {
      gpu,
      segment(image, x, y) {
        const result = task.segment(image, { keypoint: { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) } })
        try {
          const mask = result.confidenceMasks?.[0]
          return mask ? { data: mask.getAsFloat32Array().slice(), width: mask.width, height: mask.height } : null
        } finally {
          result.close()
        }
      }
    }
  })()
  objects.catch((err: unknown) => {
    objects = null
    console.error('[vision] cannot load the object segmenter', err)
  })
  return objects
}

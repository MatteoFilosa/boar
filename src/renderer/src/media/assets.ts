import { bridge } from '../platform'

/**
 * Bytes of a bundled asset URL: fetched in the dev server (http) and the
 * browser, read through the main process in the packaged app (file://, where
 * fetch() is not available).
 */
export async function assetBytes(url: string): Promise<Uint8Array> {
  if (url.startsWith('file:') && bridge) return bridge.readAsset(url)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Cannot load ${url} (${response.status})`)
  return new Uint8Array(await response.arrayBuffer())
}

/** A blob: URL with the asset's bytes (for loaders that fetch or inject scripts by URL). */
export async function assetBlobUrl(url: string, type: string): Promise<string> {
  const bytes = await assetBytes(url)
  return URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }))
}

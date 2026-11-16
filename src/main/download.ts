import { net } from 'electron'
import { createWriteStream } from 'node:fs'
import { rename, rm } from 'node:fs/promises'

/**
 * Downloads `url` to `target` through a `.part` file (renamed when complete,
 * removed on failure). `progress(received, total)` about every 2 MB.
 */
export async function downloadFile(
  url: string,
  target: string,
  progress: (received: number, total: number) => void,
  expectedBytes = 0
): Promise<void> {
  const partial = `${target}.part`
  const response = await net.fetch(url)
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status})`)
  const total = Number(response.headers.get('content-length')) || expectedBytes
  const file = createWriteStream(partial)
  const reader = response.body.getReader()
  let received = 0
  let lastReport = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (!file.write(value)) await new Promise<void>((resolve) => file.once('drain', () => resolve()))
      if (received - lastReport > 2 * 1024 * 1024) {
        lastReport = received
        progress(received, total)
      }
    }
    await new Promise<void>((resolve, reject) => file.end((err?: Error | null) => (err ? reject(err) : resolve())))
    await rename(partial, target)
  } catch (err) {
    file.destroy()
    await rm(partial, { force: true })
    throw err
  }
}

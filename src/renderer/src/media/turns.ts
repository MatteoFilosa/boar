/**
 * Runs at most `slots` jobs at once, the others in order as places free up.
 * Thumbnails and waveforms decode whole files: opening a project started a
 * decoder for every file at once, and with many 4K clips their picture buffers
 * filled the video memory (8 clips: about 4 GB) until the GPU process quit.
 */
export function takeTurns(slots: number): <T>(job: () => Promise<T>) => Promise<T> {
  let running = 0
  const waiting: (() => void)[] = []
  return async (job) => {
    if (running < slots) running++
    // A finished job hands its place over.
    else await new Promise<void>((resolve) => waiting.push(resolve))
    try {
      return await job()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else running--
    }
  }
}

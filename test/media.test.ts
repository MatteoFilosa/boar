import { describe, expect, test } from 'vitest'
import { takeTurns } from '@/media/turns'

describe('background decoding takes turns', () => {
  /** A job that waits until `release` is called, noting how many run at once. */
  function jobs(): { start: (name: string) => () => Promise<string>; release: (name: string) => void; order: string[]; peak: () => number } {
    const gates = new Map<string, () => void>()
    const order: string[] = []
    let running = 0
    let peak = 0
    return {
      start: (name) => async () => {
        running++
        peak = Math.max(peak, running)
        order.push(name)
        await new Promise<void>((resolve) => gates.set(name, resolve))
        running--
        return name
      },
      release: (name) => gates.get(name)?.(),
      order,
      peak: () => peak
    }
  }
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  test('never more than the slots at once, the rest in order', async () => {
    const turns = takeTurns(2)
    const j = jobs()
    const results = ['a', 'b', 'c', 'd', 'e'].map((name) => turns(j.start(name)))
    await settle()
    expect(j.order).toEqual(['a', 'b'])
    j.release('b')
    await settle()
    expect(j.order).toEqual(['a', 'b', 'c'])
    for (const name of ['a', 'c', 'd', 'e']) {
      j.release(name)
      await settle()
    }
    expect(await Promise.all(results)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(j.order).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(j.peak()).toBe(2)
  })

  test('a failed job frees its place for the next one', async () => {
    const turns = takeTurns(1)
    const j = jobs()
    const failed = turns(() => Promise.reject(new Error('cannot decode')))
    const second = turns(j.start('second'))
    await expect(failed).rejects.toThrow('cannot decode')
    await settle()
    const third = turns(j.start('third'))
    await settle()
    expect(j.order).toEqual(['second'])
    j.release('second')
    await settle()
    j.release('third')
    expect([await second, await third]).toEqual(['second', 'third'])
    expect(j.peak()).toBe(1)
  })
})

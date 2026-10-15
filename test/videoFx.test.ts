import { describe, expect, test } from 'vitest'
import { VIDEO_FX, createFx } from '@/core/fx'
import { passesFor } from '@/engine/videoFx'

describe('video FX passes', () => {
  test('every video effect has shader passes', () => {
    for (const def of VIDEO_FX) {
      const fx = createFx(def.type)!
      // Remove Background waits for its person mask.
      const passes = passesFor(fx, 1, def.type === 'removeBg' ? 'person' : null)
      expect(passes.length, def.type).toBeGreaterThan(0)
    }
  })

  test('Brightness and Contrast is the Color Corrector with the rest neutral', () => {
    const simple = createFx('brightnessContrast')!
    simple.params.brightness = 0.2
    simple.params.contrast = -0.3
    const full = createFx('colorCorrector')!
    full.params.brightness = 0.2
    full.params.contrast = -0.3
    expect(passesFor(simple, 1, null)).toEqual(passesFor(full, 1, null))
  })

  test('at its defaults it leaves the picture as it is', () => {
    expect(passesFor(createFx('brightnessContrast')!, 1, null)).toEqual(passesFor(createFx('colorCorrector')!, 1, null))
  })
})

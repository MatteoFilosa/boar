import { describe, expect, test } from 'vitest'
import { SAFE_ZONES, boxOverlaps, coveredAreas, coveredSides, fillsFrame, safeRect, safeSpec } from '@/core/safeZones'
import { coveredEvents } from '@/core/eventBox'
import { type ShapeContent, shapeForFrame } from '@/core/shapes'
import { clip, load, media, project, s, state, track } from './helpers'

const W = 1080
const H = 1920
const box = (cx: number, cy: number, w: number, h: number, angle = 0): { cx: number; cy: number; w: number; h: number; angle: number } => ({ cx, cy, w, h, angle })

describe('safe zones', () => {
  test('vertical frames get the app margins, horizontal ones action safe', () => {
    expect(safeSpec('tiktok', W, H)).toBe(SAFE_ZONES.tiktok)
    expect(safeSpec('tiktok', 1920, 1080)).toBe(SAFE_ZONES.tv)
    const r = safeRect(SAFE_ZONES.tiktok, W, H)
    expect([r.x, r.y, r.w, r.h].map(Math.round)).toEqual([120, 240, 840, 1020])
    const reels = safeRect(SAFE_ZONES.reels, W, H)
    expect([reels.x, reels.y, reels.w, reels.h].map(Math.round)).toEqual([65, 269, 950, 979])
  })

  test("TikTok's button column reaches into the safe rectangle", () => {
    const buttons = coveredAreas(SAFE_ZONES.tiktok, W, H).find((a) => a.side === 'buttons')
    expect(buttons && [buttons.rect.x, buttons.rect.y, buttons.rect.w, buttons.rect.h].map(Math.round)).toEqual([780, 840, 180, 420])
    expect(coveredAreas(SAFE_ZONES.reels, W, H).map((a) => a.side)).toEqual(['top', 'bottom', 'left', 'right'])
  })

  test('boxes are checked against what covers them', () => {
    const spec = SAFE_ZONES.tiktok
    expect(coveredSides(box(540, 650, 600, 300), spec, W, H)).toEqual([])
    // Touching the edge of the safe area is not covered.
    expect(coveredSides(box(540, 1160, 400, 200), spec, W, H)).toEqual([])
    expect(coveredSides(box(540, 1200, 600, 200), spec, W, H)).toEqual(['bottom', 'buttons'])
    expect(coveredSides(box(540, 150, 900, 100), spec, W, H)).toEqual(['top'])
    expect(coveredSides(box(540, 700, 0, 0), spec, W, H)).toEqual([])
  })

  test('a turned box only counts where it really is', () => {
    // A diamond whose bounding square reaches the corner of a rectangle, but not the diamond itself.
    const diamond = box(200, 200, 100, 100, Math.PI / 4)
    expect(boxOverlaps(diamond, { x: 240, y: 240, w: 100, h: 100 })).toBe(false)
    expect(boxOverlaps(box(200, 200, 100, 100), { x: 240, y: 240, w: 100, h: 100 })).toBe(true)
    expect(boxOverlaps(diamond, { x: 260, y: 150, w: 100, h: 100 })).toBe(true)
  })

  test('only a picture smaller than the frame can be covered', () => {
    expect(fillsFrame(box(540, 960, 1080, 1920), W, H)).toBe(true)
    expect(fillsFrame(box(540, 960, 1080, 1000), W, H)).toBe(false)
  })

  test('texts, shapes and pictures under the app UI at the cursor', () => {
    const rect = (y: number): ShapeContent => ({ ...(shapeForFrame('rectangle', W, H) as ShapeContent), x: 0.5, y, w: 0.4, h: 0.05 })
    const p = project(
      [track('shapes'), track('hidden'), track('main')],
      [
        clip('low', 'shapes', 0, 5, { mediaId: '', shape: rect(0.9) }),
        clip('mid', 'shapes', 5, 5, { mediaId: '', shape: rect(0.5) }),
        clip('muted', 'hidden', 0, 5, { mediaId: '', shape: rect(0.95) }),
        clip('bg', 'main', 0, 10, { mediaId: 'tall' })
      ]
    )
    p.settings = { ...p.settings, width: W, height: H }
    p.tracks[1].muted = true
    load(p, { media: [media('tall', { width: W, height: H })] })
    const at = (t: number): string[] => coveredEvents(state().project, s(t), SAFE_ZONES.reels).map((h) => `${h.event.id}:${h.sides.join('+')}`)
    expect(at(1)).toEqual(['low:bottom'])
    expect(at(6)).toEqual([])
  })
})

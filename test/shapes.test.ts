import { describe, expect, test } from 'vitest'
import * as A from '@/core/actions'
import {
  type ShapeContent,
  convertShape,
  moveShape,
  normalizeShape,
  outlineLength,
  shapeBox,
  shapeForFrame,
  shapeFromBox,
  shapeMotion,
  turnShape
} from '@/core/shapes'
import { parseProject, serializeProject } from '@/core/projectFile'
import { clip, ev, load, media, project, s, sec, state, track } from './helpers'

const round = (v: number): number => Math.round(v * 1000) / 1000
const box = (b: { cx: number; cy: number; w: number; h: number; angle: number }): number[] => [b.cx, b.cy, b.w, b.h, b.angle].map(round)
const shape = (kind: string): ShapeContent => shapeForFrame(kind, 1920, 1080) as ShapeContent

describe('shapes', () => {
  test('presets keep their proportions in any frame', () => {
    for (const [w, h] of [
      [1920, 1080],
      [1080, 1920]
    ]) {
      const circle = shapeBox(shapeForFrame('ellipse', w, h) as ShapeContent, w, h)
      expect(round(circle.w)).toBe(round(circle.h))
      const rect = shapeBox(shapeForFrame('rectangle', w, h) as ShapeContent, w, h)
      expect(round(rect.w / rect.h)).toBe(round(0.56 / 0.36))
    }
    expect(shapeForFrame('solid', 1080, 1920)).toMatchObject({ x: 0.5, y: 0.5, w: 1, h: 1, width: 0, fillOpacity: 1 })
    expect(shapeForFrame('nope', 1920, 1080)).toBeNull()
  })

  test('a box reads back as the same rectangle', () => {
    const b = { cx: 600, cy: 400, w: 300, h: 120, angle: Math.PI / 6 }
    const s = { ...shape('rectangle'), ...shapeFromBox(shape('rectangle'), b, 1920, 1080) }
    expect(s.rotation).toBeCloseTo(30)
    expect(box(shapeBox(s, 1920, 1080))).toEqual(box(b))
  })

  test("an arrow's box runs from its tail (left side) to its tip (right side)", () => {
    const arrow = { ...shape('arrow'), x1: 0.25, y1: 0.5, x2: 0.75, y2: 0.5 }
    const b = shapeBox(arrow, 1920, 1080)
    expect([b.cx, b.cy, b.w, b.angle].map(round)).toEqual([960, 540, 960, 0])
    // Moved and lengthened through its box: both ends follow.
    expect(shapeFromBox(arrow, { ...b, cx: 1000, w: 1000 }, 1920, 1080)).toEqual({ x1: 500 / 1920, y1: 0.5, x2: 1500 / 1920, y2: 0.5 })
  })

  test('moving an arrow moves both ends', () => {
    const arrow = { ...shape('arrow'), x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.4 }
    const moved = moveShape(arrow, 192, -108, 1920, 1080)
    expect([moved.x1, moved.y1, moved.x2, moved.y2].map((v) => round(v as number))).toEqual([0.2, 0.1, 0.4, 0.3])
  })

  test('a quarter turn of an arrow turns it around its middle, clockwise on screen', () => {
    const arrow = { ...shape('arrow'), x1: 900 / 1920, y1: 0.5, x2: 1020 / 1920, y2: 0.5 }
    const turned = turnShape(arrow, 90, 1920, 1080)
    // Pointing right before, down after.
    expect([turned.x1! * 1920, turned.y1! * 1080, turned.x2! * 1920, turned.y2! * 1080].map(round)).toEqual([960, 480, 960, 600])
  })

  test('a box becomes the arrow along its diagonal, and back', () => {
    const rect = { ...shape('rectangle'), x: 0.5, y: 0.5, w: 0.25, h: 0.25 }
    const arrow = convertShape(rect, 'arrow', 1920, 1080)
    expect([arrow.x1, arrow.y1, arrow.x2, arrow.y2].map(round)).toEqual([0.375, 0.625, 0.625, 0.375])
    const back = convertShape(arrow, 'ellipse', 1920, 1080)
    expect([back.kind, back.x, back.y, back.w, back.h].map((v) => (typeof v === 'number' ? round(v) : v))).toEqual(['ellipse', 0.5, 0.5, 0.25, 0.25])
  })

  test('outline lengths for the draw-on animation', () => {
    expect(outlineLength('ellipse', 200, 200, 0)).toBeCloseTo(Math.PI * 200)
    expect(outlineLength('rectangle', 300, 100, 0)).toBe(800)
    // Corners as round as they get: two half circles and the straight parts.
    expect(outlineLength('rectangle', 300, 100, 1000)).toBeCloseTo(400 + Math.PI * 100)
  })

  test('animations: draw-on, pop in, fade out', () => {
    const s = { ...shape('rectangle'), animIn: 'draw' as const, animOut: 'fade' as const, animDuration: 0.4 }
    expect(shapeMotion(s, { t: 0.2, length: 4 }).draw).toBeCloseTo(0.5)
    expect(shapeMotion(s, { t: 2, length: 4 })).toEqual({ alpha: 1, scale: 1, draw: 1 })
    expect(shapeMotion(s, { t: 4, length: 4 }).alpha).toBe(0)
    expect(shapeMotion({ ...s, animIn: 'pop' }, { t: 0, length: 4 }).scale).toBeCloseTo(0)
    // Thumbnails have no clock: the whole shape.
    expect(shapeMotion(s)).toEqual({ alpha: 1, scale: 1, draw: 1 })
  })

  test('saved shapes get the fields added since, an unknown kind becomes a rectangle', () => {
    expect(normalizeShape({ kind: 'arrow', color: '#00ff00' })).toMatchObject({ kind: 'arrow', color: '#00ff00', width: 10, shadow: true })
    expect(normalizeShape({ kind: 'star' as never }).kind).toBe('rectangle')
  })
})

describe('shape events', () => {
  test('a shape goes on a free track on top, selected, as one undo step', () => {
    load(project([track('v')], [clip('a', 'v', 0, 10)]), { media: [media('m')] })
    const id = A.addShapeEvent('arrow', s(2))!
    const e = ev(id)
    expect(e.shape?.kind).toBe('arrow')
    expect([sec(e.start), sec(e.length)]).toEqual([2, 4])
    const tracks = state().project.tracks
    expect(tracks[0].id).toBe(e.trackId)
    expect(tracks[0].name).toBe('Shapes')
    expect(state().selection).toEqual([id])
    A.undo()
    expect(state().project.events.some((x) => x.id === id)).toBe(false)
    expect(state().project.tracks).toHaveLength(1)
  })

  test('the given look goes on with it, and a second shape at the same time gets its own track', () => {
    load(project([track('v')], []), { media: [media('m')] })
    const first = A.addShapeEvent('rectangle', 0, null, { patch: { color: '#00ff00', width: 12 } })!
    const second = A.addShapeEvent('ellipse', s(1))!
    expect(ev(first).shape).toMatchObject({ kind: 'rectangle', color: '#00ff00', width: 12 })
    expect(ev(second).trackId).not.toBe(ev(first).trackId)
  })

  test('shapes turn with Ctrl+R and never change speed', () => {
    load(project([track('v')], []), { media: [media('m')] })
    const id = A.addShapeEvent('rectangle', 0)!
    expect(A.rotateEvents([id], 90)).toBe(1)
    expect(ev(id).shape?.rotation).toBe(90)
    expect(A.canStretch(ev(id))).toBe(false)
  })

  test('Paste Event Attributes gives a shape the look of another, not its place', () => {
    load(project([track('v')], []), { media: [media('m')] })
    const from = A.addShapeEvent('rectangle', 0, null, { patch: { color: '#00ff00', width: 20, fill: '#000000', x: 0.2 } })!
    const to = A.addShapeEvent('ellipse', s(5), null, { patch: { x: 0.7 } })!
    A.selectEvents([from], 'replace')
    A.copySelection()
    expect(A.pasteEventAttributes(['textStyle'], [to])).toBe(1)
    expect(ev(to).shape).toMatchObject({ kind: 'ellipse', x: 0.7, color: '#00ff00', width: 20, fill: '#000000' })
  })

  test('shapes survive a save and reopen; older projects have none', () => {
    load(project([track('v')], []), { media: [media('m')] })
    const id = A.addShapeEvent('arrow', 0, null, { patch: { animIn: 'draw' } })!
    const json = serializeProject(state().project, [])
    const back = parseProject(json).project.events.find((e) => e.id === id)
    expect(back?.shape).toEqual(ev(id).shape)
    const old = JSON.parse(json)
    delete old.project.events[0].shape
    expect(parseProject(JSON.stringify(old)).project.events[0].shape).toBeNull()
  })
})

// Rotating with the mouse (preview handles, Event Pan/Crop): the cursor of the
// rotation zones and the angle snapping.

const cache = new Map<number, string>()

/**
 * A curved double arrow. The glyph bulges to the upper left (top-left corner);
 * `degrees` turns it for the other corners and for objects already rotated.
 */
export function rotateCursor(degrees: number): string {
  const step = (((Math.round(degrees / 15) * 15) % 360) + 360) % 360
  const cached = cache.get(step)
  if (cached) return cached
  const arc = 'M9 21 A11 11 0 0 1 20 10'
  const heads = 'M5.5 20 L9 24.5 L12.5 20 Z M19 6.5 L23.5 10 L19 13.5 Z'
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">` +
    `<g transform="rotate(${step} 16 16)" stroke-linejoin="round">` +
    `<path d="${arc}" fill="none" stroke="#fff" stroke-width="4.5"/>` +
    `<path d="${heads}" fill="#fff" stroke="#fff" stroke-width="2.5"/>` +
    `<path d="${arc}" fill="none" stroke="#000" stroke-width="2"/>` +
    `<path d="${heads}" fill="#000"/>` +
    `</g></svg>`
  const value = `url("data:image/svg+xml,${encodeURIComponent(svg)}") 16 16, crosshair`
  cache.set(step, value)
  return value
}

/** Base cursor angle of each corner of a box (nw, ne, se, sw). */
export const CORNER_CURSOR_ANGLE = { nw: 0, ne: 90, se: 180, sw: 270 } as const

/** Snaps degrees: 15° steps with Shift, else to the nearest quarter turn when close (Alt turns freely). */
export function snapAngle(degrees: number, e: { shiftKey: boolean; altKey: boolean }): number {
  if (e.shiftKey) return Math.round(degrees / 15) * 15
  const quarter = Math.round(degrees / 90) * 90
  return !e.altKey && Math.abs(degrees - quarter) < 3 ? quarter : degrees
}

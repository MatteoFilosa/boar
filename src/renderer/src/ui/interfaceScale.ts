import { setOption, setStatus } from '../core/actions'
import { useEditor } from '../core/store'
import { bridge } from '../platform'

// View › Interface Size (Ctrl++ / Ctrl+- / Ctrl+0): the whole window zooms
// like a web page, so text, buttons and the timeline grow together and every
// canvas stays sharp. Remembered in the editor options.

const STEPS = [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]

export const interfaceScaleLabel = (scale: number): string => `${Math.round(scale * 100)}%`

/** Applies the remembered size now and whenever it changes. */
export function startInterfaceScale(): void {
  if (!bridge) return
  bridge.setZoomFactor(useEditor.getState().options.uiScale)
  useEditor.subscribe((s, p) => {
    if (s.options.uiScale !== p.options.uiScale) bridge?.setZoomFactor(s.options.uiScale)
  })
}

/** One step bigger or smaller, or back to 100% (0). */
export function stepInterfaceScale(direction: 1 | -1 | 0): void {
  if (!bridge) {
    setStatus('In the browser preview use the browser zoom: Interface Size works in the desktop app')
    return
  }
  const current = useEditor.getState().options.uiScale
  let next = 1
  if (direction > 0) next = STEPS.find((s) => s > current + 0.001) ?? STEPS[STEPS.length - 1]
  else if (direction < 0) next = [...STEPS].reverse().find((s) => s < current - 0.001) ?? STEPS[0]
  setOption('uiScale', next)
  setStatus(`Interface size ${interfaceScaleLabel(next)}`)
}

import { useEditor } from '../core/store'
import { coveredEvents } from '../core/eventBox'
import { SAFE_ZONES, type SafeGuide, type SafeSide, type SafeZoneSpec, boxCorners, coveredAreas, safeRect, safeSpec } from '../core/safeZones'

/** Names in the guides menu. */
export const GUIDE_LABELS: Record<SafeGuide, string> = {
  reels: SAFE_ZONES.reels.label,
  tiktok: SAFE_ZONES.tiktok.label,
  shorts: SAFE_ZONES.shorts.label
}

const SIDE_LABELS: Record<SafeSide, string> = {
  top: 'top bar',
  bottom: 'name and caption',
  left: 'left edge',
  right: 'right edge',
  buttons: 'buttons'
}

/** Position and size in percent of the frame. */
const place = (x: number, y: number, w: number, h: number, W: number, H: number): React.CSSProperties => ({
  left: `${(x / W) * 100}%`,
  top: `${(y / H) * 100}%`,
  width: `${(w / W) * 100}%`,
  height: `${(h / H) * 100}%`
})

/**
 * Placeholders where the app draws its own interface (no real icons): the top
 * bar, the column of buttons and the account name with the caption, inside
 * the covered areas so the picture shows what the margins are for.
 */
function AppPlaceholders({ spec, W, H }: { spec: SafeZoneSpec; W: number; H: number }): React.JSX.Element {
  const u = W / 1080
  const topMid = (spec.top * H) / 2
  const column = spec.buttons ? (spec.buttons.x + spec.buttons.w / 2) * W : W - 70 * u
  const buttons = spec.buttons ? 5 : 4
  const step = spec.buttons ? 140 * u : 125 * u
  const bar = (key: string, x: number, y: number, w: number, h: number): React.JSX.Element => (
    <div key={key} className="safe-ui" style={place(x, y - h / 2, w, h, W, H)} />
  )
  const dot = (key: string, cx: number, cy: number, d: number): React.JSX.Element => (
    <div key={key} className="safe-ui" style={place(cx - d / 2, cy - d / 2, d, d, W, H)} />
  )
  return (
    <>
      {bar('title', 40 * u, topMid, 170 * u, 28 * u)}
      {dot('camera', W - 68 * u, topMid, 56 * u)}
      {Array.from({ length: buttons }, (_, i) => dot(`b${i}`, column, H - 150 * u - i * step, 72 * u))}
      {dot('avatar', 68 * u, H - 330 * u, 56 * u)}
      {bar('name', 110 * u, H - 330 * u, 220 * u, 26 * u)}
      {bar('caption1', 40 * u, H - 260 * u, 520 * u, 20 * u)}
      {bar('caption2', 40 * u, H - 225 * u, 400 * u, 20 * u)}
      {bar('sound', 40 * u, H - 180 * u, 300 * u, 20 * u)}
    </>
  )
}

/**
 * Guides drawn over the preview only (never rendered). Vertical projects show
 * the areas a short video app covers (margins from the platform's ad
 * guidelines); horizontal ones show action and title safe. Texts, shapes and
 * pictures reaching into them are outlined with what covers them.
 */
export function SafeZones(): React.JSX.Element {
  const project = useEditor((s) => s.project)
  const cursor = useEditor((s) => s.cursor)
  const guide = useEditor((s) => s.options.safeGuide)
  const { width: W, height: H } = project.settings
  const vertical = H > W
  const spec = safeSpec(guide, W, H)
  const safe = safeRect(spec, W, H)
  const hits = coveredEvents(project, cursor, spec)
  return (
    <div className="safe-overlay">
      {vertical && coveredAreas(spec, W, H).map((a, i) => <div key={i} className="safe-band" style={place(a.rect.x, a.rect.y, a.rect.w, a.rect.h, W, H)} />)}
      {vertical && <AppPlaceholders spec={spec} W={W} H={H} />}
      <div className="safe-rect" style={place(safe.x, safe.y, safe.w, safe.h, W, H)} />
      {!vertical && <div className="safe-rect inner" style={{ inset: '10%' }} />}
      {hits.map(({ event, box, sides }) => {
        const corners = boxCorners(box)
        const top = Math.min(...corners.map((c) => c[1]))
        const left = Math.min(...corners.map((c) => c[0]))
        const what = vertical ? `Under the ${sides.map((s) => SIDE_LABELS[s]).join(', ')}` : 'Outside action safe'
        return (
          <div key={event.id}>
            <div
              className="safe-hit"
              style={{ ...place(box.cx - box.w / 2, box.cy - box.h / 2, box.w, box.h, W, H), transform: `rotate(${box.angle}rad)` }}
            />
            <span
              className={`safe-hit-label${top < H * 0.04 ? ' inside' : ''}`}
              style={{ left: `${(Math.max(0, left) / W) * 100}%`, top: `${(Math.max(0, top) / H) * 100}%` }}
            >
              {what}
            </span>
          </div>
        )
      })}
      <span className="safe-label">{vertical ? `${spec.label} · ${spec.source}` : 'Action safe 5% · title safe 10%'}</span>
    </div>
  )
}

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { FONT_CATALOG, FONT_CATEGORIES, fontInfo, loadAllFonts, loadFont } from '../core/fonts'

/** Font dropdown that shows every font in its own typeface, grouped like a type catalog. */
export function FontPicker({ value, onChange }: { value: string; onChange: (family: string) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [up, setUp] = useState(false)
  const [filter, setFilter] = useState('')
  const [, setLoaded] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void loadFont(value).then(() => setLoaded((n) => n + 1))
  }, [value])

  useEffect(() => {
    if (!open) return
    void loadAllFonts().then(() => setLoaded((n) => n + 1))
    const onDown = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [open])

  useLayoutEffect(() => {
    if (open) listRef.current?.querySelector('.fp-item.active')?.scrollIntoView({ block: 'center' })
  }, [open])

  const q = filter.trim().toLowerCase()
  const info = fontInfo(value)
  return (
    <div className="font-picker" ref={ref}>
      <button
        className="select fp-button"
        style={{ fontFamily: `"${value}", "Segoe UI", sans-serif`, fontWeight: info?.regular ?? 400 }}
        onClick={(e) => {
          // Open upward when there is no room below (the Text window sits at the bottom).
          const r = e.currentTarget.getBoundingClientRect()
          setUp(r.bottom + 430 > window.innerHeight && r.top > window.innerHeight - r.bottom)
          setOpen(!open)
        }}
        title="Font"
      >
        <span>{value}</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className={`fp-popup${up ? ' up' : ''}`}>
          <input
            className="input fp-search"
            placeholder="Search fonts…"
            value={filter}
            autoFocus
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                setOpen(false)
              }
            }}
          />
          <div className="fp-list" ref={listRef}>
            {FONT_CATEGORIES.map((category) => {
              const fonts = FONT_CATALOG.filter((f) => f.category === category && (!q || f.family.toLowerCase().includes(q)))
              if (fonts.length === 0) return null
              return (
                <div key={category}>
                  <div className="fp-category">{category}</div>
                  {fonts.map((f) => (
                    <button
                      key={f.family}
                      className={`fp-item${f.family === value ? ' active' : ''}`}
                      style={{ fontFamily: `"${f.family}", "Segoe UI", sans-serif`, fontWeight: f.bold }}
                      onClick={() => {
                        onChange(f.family)
                        setOpen(false)
                      }}
                    >
                      {f.family}
                    </button>
                  ))}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

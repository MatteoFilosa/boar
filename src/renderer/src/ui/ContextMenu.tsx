import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { Check, ChevronRight, type LucideIcon } from 'lucide-react'
import { type CommandId, commands } from './commands'
import { shortcutLabel } from './shortcuts'
import { COMMAND_ICONS, DANGER_COMMANDS } from './icons'

export interface MenuItem {
  label: string
  command?: CommandId
  run?: () => void
  disabled?: boolean
  checked?: boolean
  /** Current choice in a list of options that keep their icons (check mark on the right). */
  selected?: boolean
  /** Defaults to the command's icon. */
  icon?: LucideIcon | MenuIconComponent
  /** Destructive action: icon drawn in red. */
  danger?: boolean
  /** Opens a nested menu on hover. */
  submenu?: MenuEntry[]
}

/** Custom menu icons (e.g. fade curve shapes) take the same props as lucide icons. */
export type MenuIconComponent = (props: { size?: number; strokeWidth?: number }) => React.JSX.Element

export type MenuEntry = MenuItem | 'separator' | { header: string }

/** Check mark for toggles, else the item's icon (shared by the menu bar and the right-click menu). */
export function MenuIcon({ item }: { item: MenuItem }): React.JSX.Element {
  const Icon = item.icon ?? (item.command ? COMMAND_ICONS[item.command] : undefined)
  const danger = item.danger ?? (item.command ? DANGER_COMMANDS.has(item.command) : false)
  return (
    <span className={`menu-check${danger ? ' danger' : ''}`}>
      {item.checked !== undefined ? (
        item.checked ? (
          <Check size={14} />
        ) : null
      ) : Icon ? (
        <Icon size={14} strokeWidth={danger ? 2.6 : 2} />
      ) : null}
    </span>
  )
}

interface OpenMenu {
  x: number
  y: number
  entries: MenuEntry[]
  /** 'above' opens upward from y (menus anchored to the bottom toolbar). */
  placement: 'below' | 'above'
  id: number
}

const useContextMenu = create<{ menu: OpenMenu | null }>()(() => ({ menu: null }))

let menuCount = 0

export function openContextMenu(x: number, y: number, entries: MenuEntry[], placement: 'below' | 'above' = 'below'): void {
  useContextMenu.setState({ menu: { x, y, entries, placement, id: ++menuCount } })
}

const close = (): void => useContextMenu.setState({ menu: null })

/** The entries of one menu level; items with a submenu open it beside themselves on hover. */
function MenuEntries({ entries }: { entries: MenuEntry[] }): React.JSX.Element {
  const [open, setOpen] = useState<{ index: number; rect: DOMRect } | null>(null)
  return (
    <>
      {entries.map((entry, i) =>
        entry === 'separator' ? (
          <div key={`sep-${i}`} className="menu-sep" onMouseEnter={() => setOpen(null)} />
        ) : 'header' in entry ? (
          <div key={`h-${i}`} className="menu-header">
            {entry.header}
          </div>
        ) : (
          <button
            key={`${i}-${entry.label}`}
            className={`menu-item${open?.index === i ? ' open' : ''}${entry.selected ? ' selected' : ''}`}
            disabled={entry.disabled}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={(e) => setOpen(entry.submenu ? { index: i, rect: e.currentTarget.getBoundingClientRect() } : null)}
            onClick={(e) => {
              if (entry.submenu) {
                setOpen({ index: i, rect: e.currentTarget.getBoundingClientRect() })
                return
              }
              close()
              if (entry.run) entry.run()
              else if (entry.command) commands[entry.command]()
            }}
          >
            <MenuIcon item={entry} />
            <span className="menu-label">{entry.label}</span>
            {entry.submenu ? (
              <ChevronRight size={13} className="menu-arrow" />
            ) : entry.selected ? (
              <Check size={13} className="menu-arrow" />
            ) : (
              <span className="menu-shortcut">{entry.command ? shortcutLabel(entry.command) : ''}</span>
            )}
          </button>
        )
      )}
      {open && (() => {
        const entry = entries[open.index]
        return entry !== 'separator' && !('header' in entry) && entry.submenu ? <Submenu entries={entry.submenu} anchor={open.rect} /> : null
      })()}
    </>
  )
}

/** A nested menu to the right of its item (to the left when there is no room). */
function Submenu({ entries, anchor }: { entries: MenuEntry[]; anchor: DOMRect }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: anchor.right - 2, y: anchor.top - 5, ready: false })
  useLayoutEffect(() => {
    if (!ref.current) return
    const r = ref.current.getBoundingClientRect()
    const right = anchor.right - 2
    const x = right + r.width > window.innerWidth - 4 ? Math.max(4, anchor.left - r.width + 2) : right
    setPos({ x, y: Math.max(4, Math.min(anchor.top - 5, window.innerHeight - r.height - 4)), ready: true })
  }, [anchor])
  return (
    <div
      ref={ref}
      className="menu-popup context-menu submenu"
      style={{ left: pos.x, top: pos.y, visibility: pos.ready ? 'visible' : 'hidden' }}
    >
      <MenuEntries entries={entries} />
    </div>
  )
}

/** Right-click menu, rendered once at the app root. */
export function ContextMenu(): React.JSX.Element | null {
  const menu = useContextMenu((s) => s.menu)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })

  useLayoutEffect(() => {
    if (!menu || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    const top = menu.placement === 'above' ? menu.y - r.height : menu.y
    setPos({
      x: Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 4)),
      y: Math.max(4, Math.min(top, window.innerHeight - r.height - 4))
    })
  }, [menu])

  useEffect(() => {
    if (!menu) return
    const onDown = (e: PointerEvent): void => {
      // Submenus are rendered inside the root popup's subtree.
      if (!ref.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  if (!menu) return null
  return (
    <div ref={ref} className="menu-popup context-menu" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      <MenuEntries key={menu.id} entries={menu.entries} />
    </div>
  )
}

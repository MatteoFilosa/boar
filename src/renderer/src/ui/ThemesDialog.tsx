import { useRef, useState } from 'react'
import { Check, Download, FolderOpen, Trash2 } from 'lucide-react'
import * as A from '../core/actions'
import { useEditor } from '../core/store'
import { bridge } from '../platform'
import { FloatingWindow } from './FloatingWindow'
import {
  type Theme,
  addUserTheme,
  allThemes,
  parseTheme,
  removeUserTheme,
  resolvedColors,
  themeById,
  themeFileText
} from './themes'

/** A small picture of the theme: panels, timeline rows, an event and the accent. */
function Swatch({ theme }: { theme: Theme }): React.JSX.Element {
  const c = resolvedColors(theme)
  return (
    <div className="theme-swatch" style={{ background: theme.backdrop?.gradient ?? c.bg }}>
      <div style={{ background: c.chrome, borderColor: c.line }} className="theme-swatch-bar">
        <i style={{ background: c.accent }} />
        <i style={{ background: c['text-faint'] }} />
      </div>
      <div className="theme-swatch-body">
        <div style={{ background: c.panel }} />
        <div style={{ background: c.workspace }} />
      </div>
      <div className="theme-swatch-tracks" style={{ background: c['timeline-bg'] }}>
        <div style={{ background: c['track-a'] }}>
          <b style={{ background: c.accent }} />
        </div>
        <div style={{ background: c['track-b'] }} />
      </div>
    </div>
  )
}

/** Options › Themes: built-in themes and theme files the user loads. */
export function ThemesDialog(): React.JSX.Element {
  const current = useEditor((s) => s.options.theme)
  // Read on every render: loaded files, removals and agents change the list.
  const themes = allThemes()
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = async (files: FileList | File[] | null): Promise<void> => {
    for (const file of Array.from(files ?? [])) {
      try {
        if (file.size > 200_000) throw new Error('The file is too big for a theme')
        const theme = addUserTheme(parseTheme(await file.text()))
        A.setOption('theme', theme.id)
        setMessage({ text: `Loaded "${theme.name}"`, error: false })
      } catch (err) {
        setMessage({ text: `${file.name}: ${(err as Error).message}`, error: true })
      }
    }
  }

  const exportTheme = async (): Promise<void> => {
    const theme = themeById(current)
    const text = themeFileText(theme)
    if (bridge) {
      const path = await bridge.saveTheme(text, theme.name)
      if (path) setMessage({ text: `Saved ${path}`, error: false })
      return
    }
    const link = document.createElement('a')
    link.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
    link.download = `${theme.name}.boartheme.json`
    link.click()
    setTimeout(() => URL.revokeObjectURL(link.href), 1000)
  }

  const remove = (theme: Theme): void => {
    removeUserTheme(theme.id)
    if (current === theme.id) A.setOption('theme', 'dark')
    setMessage({ text: `Removed "${theme.name}"`, error: false })
  }

  return (
    <FloatingWindow id="themes" className="themes-window" title="Themes">
      <div
        className="modal-body"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) e.preventDefault()
        }}
        onDrop={(e) => {
          e.preventDefault()
          void load(e.dataTransfer.files)
        }}
      >
        <div className="theme-grid">
          {themes.map((theme) => (
            <button
              key={theme.id}
              className={`theme-card${theme.id === current ? ' selected' : ''}`}
              title={theme.author ? `${theme.name} by ${theme.author}` : theme.name}
              onClick={() => A.setOption('theme', theme.id)}
            >
              <Swatch theme={theme} />
              <span className="theme-name">
                {theme.id === current && <Check size={12} />}
                {theme.name}
              </span>
              {theme.id.startsWith('user:') && (
                <span
                  className="theme-remove"
                  role="button"
                  title="Remove this theme"
                  onClick={(e) => {
                    e.stopPropagation()
                    remove(theme)
                  }}
                >
                  <Trash2 size={12} />
                </span>
              )}
            </button>
          ))}
        </div>
        <p className="dim theme-help">
          A theme is a small JSON file with the interface colors: export one to get a complete template, change the colors you
          like and load it back, or share it. Drop theme files here to load them.
        </p>
        {message && <div className={`render-result ${message.error ? 'error' : 'ok'}`}>{message.text}</div>}
        <div className="modal-actions">
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            multiple
            hidden
            onChange={(e) => {
              void load(e.target.files)
              e.target.value = ''
            }}
          />
          <button className="btn" onClick={() => void exportTheme()} title="Save the current theme as a file, with every color written out">
            <Download size={13} /> Export Theme...
          </button>
          <button className="btn primary" onClick={() => fileRef.current?.click()}>
            <FolderOpen size={13} /> Load Theme File...
          </button>
        </div>
      </div>
    </FloatingWindow>
  )
}

import { useEffect, useRef } from 'react'
import { addTextEvent, setDockTab } from '../core/actions'
import { useEditor, type DockTab } from '../core/store'
import { TEXT_PRESETS } from '../core/text'
import { ProjectMedia } from './ProjectMedia'
import { PresetThumb } from './TextEditor'
import { startMediaDrag } from './mediaDrag'
import { FxBrowser } from './FxBrowser'
import { Explorer } from './Explorer'
import { TransitionBrowser } from './TransitionBrowser'
import { TranscriptPanel } from './TranscriptPanel'
import { ShortsPanel } from './ShortsPanel'

const TABS: { id: DockTab; label: string; title: string }[] = [
  { id: 'media', label: 'Project Media', title: 'Media used in this project' },
  { id: 'transcript', label: 'Transcript', title: 'Edit the speech as text: delete words to cut the video, remove fillers' },
  { id: 'shorts', label: 'Shorts', title: 'Turn a long video into vertical Shorts' },
  { id: 'explorer', label: 'Explorer', title: 'Your media folders: sound effects, stock footage, downloads' },
  { id: 'fx', label: 'Video FX', title: 'Video effects: drag onto an event' },
  { id: 'afx', label: 'Audio FX', title: 'Audio effects: drag onto an event' },
  { id: 'generators', label: 'Generators', title: 'Media Generators: titles and text' },
  { id: 'transitions', label: 'Transitions', title: 'Transitions' }
]

function Planned({ title, items }: { title: string; items: string[] }): React.JSX.Element {
  return (
    <div className="planned">
      <p className="planned-title">{title}</p>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  )
}

function Generators(): React.JSX.Element {
  return (
    <div className="generators">
      <div className="gen-title">Titles &amp; Text — drag to the timeline or double-click</div>
      <div className="gen-grid">
        {TEXT_PRESETS.map((p) => (
          <div
            key={p.id}
            className="gen-tile"
            title={`${p.description}\nDrag to the timeline or double-click to add at the cursor.`}
            onPointerDown={(e) => e.button === 0 && startMediaDrag(`text:${p.id}`, e.clientX, e.clientY)}
            onDoubleClick={() => addTextEvent(p.id, useEditor.getState().cursor)}
          >
            <PresetThumb preset={p} />
            <span>{p.label}</span>
          </div>
        ))}
      </div>
      <Planned title="Planned generators" items={['Solid color and gradients', 'Animated text (pop-in, typewriter, word-by-word captions)']} />
    </div>
  )
}

export function Dock(): React.JSX.Element {
  const tab = useEditor((s) => s.dockTab)
  const tabsRef = useRef<HTMLDivElement>(null)
  // A tab opened from elsewhere (e.g. an AI agent opening Shorts) scrolls into view.
  useEffect(() => {
    tabsRef.current?.querySelector('.dock-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [tab])
  return (
    <div className="dock">
      <div
        className="dock-tabs"
        ref={tabsRef}
        onWheel={(e) => {
          if (tabsRef.current) tabsRef.current.scrollLeft += e.deltaY + e.deltaX
        }}
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`dock-tab${tab === t.id ? ' active' : ''}`}
            title={t.title}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setDockTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="dock-body">
        {tab === 'media' && <ProjectMedia />}
        {tab === 'transitions' && <TransitionBrowser />}
        {tab === 'explorer' && <Explorer />}
        {tab === 'fx' && <FxBrowser kind="video" />}
        {tab === 'afx' && <FxBrowser kind="audio" />}
        {tab === 'generators' && <Generators />}
        {tab === 'transcript' && <TranscriptPanel />}
        {tab === 'shorts' && <ShortsPanel />}
      </div>
    </div>
  )
}

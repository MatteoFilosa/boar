import { useEffect } from 'react'
import { Dialogs } from './ui/Dialogs'
import { ContextMenu } from './ui/ContextMenu'
import { CelebrationLayer } from './ui/BoarProgress'
import { Dock } from './ui/Dock'
import { MasterBus } from './ui/MasterBus'
import { MediaDragGhost, StatusBar, useSplit } from './ui/Chrome'
import { MenuBar } from './ui/MenuBar'
import { Toolbar } from './ui/Toolbar'
import { VideoPreview } from './ui/VideoPreview'
import { Timeline } from './ui/timeline/Timeline'
import { useGlobalShortcuts } from './ui/shortcuts'
import { getEngine } from './engine/preview'
import { useEditor } from './core/store'
import { isDirty, projectName, recoverAutosave, saveProject, startLaunchProjects } from './core/session'
import { startAutosave } from './core/autosave'
import { checkForUpdates } from './ui/updates'
import { startAgentHost } from './agent/host'
import * as A from './core/actions'
import { bridge } from './platform'

export function App(): React.JSX.Element {
  useGlobalShortcuts()
  const [topHeight, startTopResize] = useSplit('top', 360, 180, 900)
  const [dockWidth, startDockResize] = useSplit('dock', 470, 260, 1100)

  useEffect(() => {
    getEngine()
    startAgentHost()
    window.__boarReady = true
    window.__boarSave = () => saveProject(false)
    startAutosave()
    // A project left unsaved by a crash first, then the one Boar was opened with,
    // then the problem log when Boar or this page stopped unexpectedly.
    void recoverAutosave()
      .then(startLaunchProjects)
      .then(() => bridge?.takeCrashNotice())
      .then((notice) => {
        if (notice) A.openDialog({ kind: 'log', notice })
      })
    const stopProblems = bridge?.onProblem((message) => A.setStatus(message))
    // A few seconds after opening, so the check never slows down the start.
    const timer = window.setTimeout(() => {
      if (useEditor.getState().options.checkUpdates) void checkForUpdates(false)
    }, 3000)
    return () => {
      window.clearTimeout(timer)
      stopProblems?.()
    }
  }, [])

  // Window title "Name * - Boar"; the main process reads __boarUnsaved on close.
  useEffect(() => {
    const update = (): void => {
      const s = useEditor.getState()
      const dirty = isDirty()
      window.__boarUnsaved = dirty ? projectName(s.projectPath) : null
      document.title = `${projectName(s.projectPath)}${dirty ? ' *' : ''} - Boar`
    }
    update()
    return useEditor.subscribe((s, p) => {
      if (
        s.project !== p.project ||
        s.savedProject !== p.savedProject ||
        s.projectPath !== p.projectPath ||
        s.transcripts !== p.transcripts ||
        s.savedTranscripts !== p.savedTranscripts ||
        s.shorts !== p.shorts ||
        s.savedShorts !== p.savedShorts ||
        s.media !== p.media ||
        s.savedMediaKey !== p.savedMediaKey
      ) {
        update()
      }
    })
  }, [])

  return (
    <div
      className="app"
      // Files dropped outside a drop zone are ignored instead of opened by the window.
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => e.preventDefault()}
    >
      <MenuBar />
      <Toolbar />
      <div className="top-area" style={{ height: topHeight }}>
        <div style={{ width: dockWidth }} className="top-dock">
          <Dock />
        </div>
        <div className="splitter-v" onPointerDown={(e) => startDockResize(e, 'x')} />
        <VideoPreview />
        <MasterBus />
      </div>
      <div className="splitter-h" onPointerDown={(e) => startTopResize(e, 'y')} />
      <Timeline />
      <StatusBar />
      <Dialogs />
      <ContextMenu />
      <CelebrationLayer />
      <MediaDragGhost />
    </div>
  )
}

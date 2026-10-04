import { useState } from 'react'
import { X } from 'lucide-react'
import * as A from '../core/actions'
import { mediaById, useEditor } from '../core/store'
import { type FrameRate, STANDARD_RATES, nearestStandardRate, rateLabel } from '../core/time'
import type { ProjectSettings } from '../core/types'
import { BINDINGS, shortcutLabel } from './shortcuts'
import { ALT, MOD } from '../platform'
import type { CommandId } from './commands'
import { PanCropDialog } from './PanCropDialog'
import { TextEditor } from './TextEditor'
import { RenderDialog } from './RenderDialog'
import logo from '../assets/logo.png'
import { CaptionsDialog } from './CaptionsDialog'
import { MaskDialog } from './MaskDialog'
import { FxWindow } from './FxWindow'
import { YoutubeDialog } from './YoutubeDialog'
import { SaveSfxDialog } from './SaveSfxDialog'
import { SilenceDialog } from './SilenceDialog'
import { DuckingDialog } from './DuckingDialog'
import { TransitionWindow } from './TransitionBrowser'
import { ReframeDialog } from './ReframeDialog'
import { AutoZoomDialog } from './AutoZoomDialog'
import { AgentDialog } from './AgentDialog'
import { UpdateDialog } from './UpdateDialog'
import { ThemesDialog } from './ThemesDialog'

function Modal({ title, children, width = 460 }: { title: string; children: React.ReactNode; width?: number }): React.JSX.Element {
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && A.closeDialog()}>
      <div className="modal" style={{ width }} role="dialog" aria-label={title}>
        <div className="modal-title">
          <span>{title}</span>
          <button className="tool-btn" title="Close (Esc)" onClick={A.closeDialog}>
            <X size={14} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}

interface Template {
  label: string
  width: number
  height: number
  rate: FrameRate
}

const TEMPLATES: Template[] = [
  { label: 'HD 1080p 29.970 fps (1920x1080)', width: 1920, height: 1080, rate: { num: 30000, den: 1001 } },
  { label: 'HD 1080p 25 fps (1920x1080)', width: 1920, height: 1080, rate: { num: 25, den: 1 } },
  { label: 'HD 1080p 30 fps (1920x1080)', width: 1920, height: 1080, rate: { num: 30, den: 1 } },
  { label: 'HD 1080p 59.940 fps (1920x1080)', width: 1920, height: 1080, rate: { num: 60000, den: 1001 } },
  { label: 'HD 1080p 60 fps (1920x1080)', width: 1920, height: 1080, rate: { num: 60, den: 1 } },
  { label: 'HD 720p 29.970 fps (1280x720)', width: 1280, height: 720, rate: { num: 30000, den: 1001 } },
  { label: 'UHD 4K 29.970 fps (3840x2160)', width: 3840, height: 2160, rate: { num: 30000, den: 1001 } },
  { label: 'Vertical 9:16 30 fps (1080x1920)', width: 1080, height: 1920, rate: { num: 30, den: 1 } },
  { label: 'Vertical 9:16 60 fps (1080x1920)', width: 1080, height: 1920, rate: { num: 60, den: 1 } },
  { label: 'Square 1:1 30 fps (1080x1080)', width: 1080, height: 1080, rate: { num: 30, den: 1 } },
  { label: 'Portrait 4:5 30 fps (1080x1350)', width: 1080, height: 1350, rate: { num: 30, den: 1 } }
]

const sameRate = (a: FrameRate, b: FrameRate): boolean => a.num * b.den === b.num * a.den
const rateKey = (r: FrameRate): string => `${r.num}/${r.den}`

function ProjectPropertiesDialog(): React.JSX.Element {
  const current = useEditor((s) => s.project.settings)
  const allMedia = useEditor((s) => s.media)
  const media = allMedia.filter((m) => m.status === 'ready' && m.kind === 'video')
  const [draft, setDraft] = useState<ProjectSettings>(() => ({ ...current, frameRate: { ...current.frameRate } }))
  const template = TEMPLATES.findIndex(
    (t) => t.width === draft.width && t.height === draft.height && sameRate(t.rate, draft.frameRate)
  )
  const evenize = (v: number): number => Math.max(16, Math.min(8192, Math.round(v / 2) * 2))

  return (
    <Modal title="Project Properties" width={500}>
      <div className="form">
        <label>Template</label>
        <select
          className="select"
          value={template}
          onChange={(e) => {
            const t = TEMPLATES[Number(e.target.value)]
            if (t) setDraft({ ...draft, width: t.width, height: t.height, frameRate: { ...t.rate } })
          }}
        >
          <option value={-1}>Custom</option>
          {TEMPLATES.map((t, i) => (
            <option key={t.label} value={i}>
              {t.label}
            </option>
          ))}
        </select>

        <label>Match media settings</label>
        <select
          className="select"
          value=""
          disabled={media.length === 0}
          onChange={(e) => {
            const m = mediaById(e.target.value)
            if (m) setDraft({ ...draft, width: m.width, height: m.height, frameRate: m.fps ? nearestStandardRate(m.fps) : draft.frameRate })
          }}
        >
          <option value="">{media.length ? 'Choose a video…' : 'No video imported'}</option>
          {media.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} ({m.width}x{m.height})
            </option>
          ))}
        </select>

        <label>Width</label>
        <input
          className="input"
          type="number"
          value={draft.width}
          step={2}
          onChange={(e) => setDraft({ ...draft, width: Number(e.target.value) })}
          onBlur={() => setDraft({ ...draft, width: evenize(draft.width) })}
        />
        <label>Height</label>
        <input
          className="input"
          type="number"
          value={draft.height}
          step={2}
          onChange={(e) => setDraft({ ...draft, height: Number(e.target.value) })}
          onBlur={() => setDraft({ ...draft, height: evenize(draft.height) })}
        />
        <label>Frame rate</label>
        <select
          className="select"
          value={rateKey(draft.frameRate)}
          onChange={(e) => {
            const r = STANDARD_RATES.find((x) => rateKey(x.rate) === e.target.value)
            if (r) setDraft({ ...draft, frameRate: { ...r.rate } })
          }}
        >
          {STANDARD_RATES.map((r) => (
            <option key={r.label} value={rateKey(r.rate)}>
              {r.label}
            </option>
          ))}
        </select>
        <label>Audio sample rate</label>
        <select
          className="select"
          value={draft.sampleRate}
          onChange={(e) => setDraft({ ...draft, sampleRate: Number(e.target.value) })}
        >
          <option value={48000}>48,000 Hz</option>
          <option value={44100}>44,100 Hz</option>
        </select>
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={A.closeDialog}>
          Cancel
        </button>
        <button
          className="btn primary"
          onClick={() => {
            A.setProjectSettings({ ...draft, width: evenize(draft.width), height: evenize(draft.height) })
            A.closeDialog()
          }}
        >
          OK
        </button>
      </div>
    </Modal>
  )
}

function MatchMediaDialog({ mediaId }: { mediaId: string }): React.JSX.Element {
  const media = mediaById(mediaId)
  const settings = useEditor((s) => s.project.settings)
  if (!media) return <></>
  const rate = media.fps ? rateLabel(nearestStandardRate(media.fps)) : '?'
  return (
    <Modal title="Match project settings?">
      <p>
        <b>{media.name}</b> is {media.width}x{media.height} at {rate} fps.
        <br />
        The project is {settings.width}x{settings.height} at {rateLabel(settings.frameRate)} fps.
      </p>
      <p className="dim">Matching avoids black bars and frame rate conversion (e.g. vertical phone videos).</p>
      <div className="modal-actions">
        <button className="btn" onClick={A.closeDialog}>
          Keep project settings
        </button>
        <button
          className="btn primary"
          onClick={() => {
            A.matchProjectToMedia(mediaId)
            A.closeDialog()
          }}
        >
          Match media
        </button>
      </div>
    </Modal>
  )
}

const DESCRIPTIONS: Partial<Record<CommandId, string>> = {
  playStop: 'Play / pause (Options can make it return to the start)',
  playPause: 'Play / pause',
  play: 'Play',
  pause: 'Pause',
  backOneSecond: 'Back one second',
  split: 'Split events at cursor',
  deleteSelection: 'Delete selected events (or selected track)',
  rippleDelete: 'Delete and close the gap (ripple)',
  copy: 'Copy events',
  cut: 'Cut events',
  paste: 'Paste events at the cursor',
  openProject: 'Open project',
  saveProject: 'Save project',
  saveProjectAs: 'Save project as',
  render: 'Render As',
  undo: 'Undo',
  redo: 'Redo',
  selectAll: 'Select all events',
  group: 'Group selected events',
  ungroup: 'Remove selected events from group',
  addMarker: 'Insert marker',
  toggleLoop: 'Loop playback',
  toggleSnapping: 'Enable snapping',
  toggleQuantize: 'Quantize to frames',
  toggleCrossfades: 'Automatic crossfades',
  addVideoTrack: 'Insert video track',
  addAudioTrack: 'Insert audio track',
  importMedia: 'Import media',
  newProject: 'New project',
  properties: 'Project properties',
  goToStart: 'Go to start',
  goToEnd: 'Go to end',
  previousFrame: 'Previous frame',
  nextFrame: 'Next frame',
  previousEditPoint: 'Previous edit point',
  nextEditPoint: 'Next edit point',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  fullScreenPreview: 'Full screen preview (Esc to exit)',
  rotateClockwise: 'Rotate selected video, image or text 90° clockwise',
  rotateCounterclockwise: 'Rotate selected video, image or text 90° counterclockwise',
  searchCommands: 'Search commands, options and effects'
}

const MOUSE = [
  ['Wheel', 'Zoom timeline at the mouse'],
  [`${MOD}+Wheel`, 'Scroll left / right'],
  ['Shift+Wheel', 'Scroll tracks up / down'],
  ['Drag event', 'Move (also to another track of the same kind)'],
  [`${ALT} while dragging`, 'Ignore snapping'],
  ['Drag event edge', 'Trim'],
  [`${MOD}+drag event edge`, 'Change speed'],
  ['Drag event top corner', 'Fade in / fade out'],
  ['Overlap two events', 'Automatic crossfade'],
  ['Drag on empty area', 'Select events in a rectangle'],
  ['Preview: drag just outside a corner', 'Rotate (Shift: 15° steps)'],
  ['Right-click / Alt+click marker', 'Delete marker']
]

function ShortcutsDialog(): React.JSX.Element {
  const seen = new Set<CommandId>()
  const rows = BINDINGS.filter((b) => {
    if (seen.has(b.command)) return false
    seen.add(b.command)
    return true
  })
  return (
    <Modal title="Keyboard and mouse" width={560}>
      <div className="shortcuts">
        <table>
          <tbody>
            {rows.map((b) => (
              <tr key={b.command}>
                <td className="kbd">{shortcutLabel(b.command)}</td>
                <td>{DESCRIPTIONS[b.command] ?? b.command}</td>
              </tr>
            ))}
            {MOUSE.map(([k, d]) => (
              <tr key={k}>
                <td className="kbd">{k}</td>
                <td>{d}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  )
}

function AboutDialog(): React.JSX.Element {
  return (
    <Modal title="About Boar">
      <div className="about-head">
        <img src={logo} alt="" />
        <p>
          <b>Boar</b> {__APP_VERSION__} — a video editor with a multitrack timeline and local AI tools. By Matteo Filosa.
        </p>
      </div>
      <p className="dim">
        Built with Electron, React and WebCodecs. Runs on Intel, NVIDIA and AMD GPUs without vendor-specific code.
      </p>
    </Modal>
  )
}

export function Dialogs(): React.JSX.Element | null {
  const dialog = useEditor((s) => s.dialog)
  if (!dialog) return null
  switch (dialog.kind) {
    case 'projectProperties':
      return <ProjectPropertiesDialog />
    case 'matchMedia':
      return <MatchMediaDialog mediaId={dialog.mediaId} />
    case 'panCrop':
      return <PanCropDialog eventId={dialog.eventId} />
    case 'text':
      return <TextEditor eventId={dialog.eventId} />
    case 'render':
      return <RenderDialog />
    case 'captions':
      return <CaptionsDialog />
    case 'mask':
      return <MaskDialog eventId={dialog.eventId} />
    case 'fx':
      return <FxWindow key={dialog.eventId} eventId={dialog.eventId} focus={dialog.focus} />
    case 'youtube':
      return <YoutubeDialog />
    case 'saveSfx':
      return <SaveSfxDialog eventId={dialog.eventId} />
    case 'silence':
      return <SilenceDialog />
    case 'themes':
      return <ThemesDialog />
    case 'ducking':
      return <DuckingDialog />
    case 'transition':
      return <TransitionWindow eventId={dialog.eventId} />
    case 'reframe':
      return <ReframeDialog />
    case 'autoZoom':
      return <AutoZoomDialog />
    case 'agents':
      return <AgentDialog />
    case 'shortcuts':
      return <ShortcutsDialog />
    case 'about':
      return <AboutDialog />
    case 'update':
      return <UpdateDialog info={dialog.info} error={dialog.error} />
  }
}

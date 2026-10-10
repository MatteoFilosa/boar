import { useState } from 'react'
import { X } from 'lucide-react'
import * as A from '../core/actions'
import { type EventAttribute, mediaById, useEditor } from '../core/store'
import { fxDef } from '../core/fx'
import { type FrameRate, STANDARD_RATES, nearestStandardRate, rateLabel } from '../core/time'
import type { ProjectSettings } from '../core/types'
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
import { ReverseDialog } from './ReverseDialog'
import { AutoZoomDialog } from './AutoZoomDialog'
import { AgentDialog } from './AgentDialog'
import { UpdateDialog } from './UpdateDialog'
import { ThemesDialog } from './ThemesDialog'
import { ShortcutsWindow } from './ShortcutsWindow'

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

/** What the copied events would paste, per attribute. */
function copiedSummary(key: EventAttribute): string {
  const events = A.copiedEvents()
  const media = events.filter((e) => !e.text)
  switch (key) {
    case 'fx': {
      const names = [...new Set(events.flatMap((e) => e.fx.map((f) => fxDef(f.type)?.label ?? f.type)))]
      return names.length ? names.join(', ') : 'none (removes the effects)'
    }
    case 'panCrop': {
      const keys = media.find((e) => e.kind === 'video')?.panCrop.length ?? 0
      return keys === 0 ? 'default framing' : keys === 1 ? 'one framing' : `${keys} keyframes`
    }
    case 'mask': {
      const mask = events.find((e) => e.kind === 'video')?.mask
      return mask ? (mask.shape === 'custom' ? 'custom shape' : mask.shape) : 'none (removes the masks)'
    }
    case 'gain':
      return events.map((e) => `${e.kind === 'video' ? 'level' : 'volume'} ${Math.round(e.gain * 100)}%`).filter((v, i, a) => a.indexOf(v) === i).join(', ')
    case 'textStyle': {
      const text = events.find((e) => e.text)?.text
      return text ? `${text.font}, ${text.size} px` : 'no text event copied'
    }
  }
}

/** Edit › Selectively Paste Event Attributes: choose what the copied event gives to the selected ones. */
function PasteAttributesDialog(): React.JSX.Element {
  const remembered = useEditor((s) => s.options.pasteAttributes)
  const [chosen, setChosen] = useState<Set<EventAttribute>>(() => new Set(remembered))
  const count = useEditor((s) => s.selection.length)
  const paste = (): void => {
    const list = A.EVENT_ATTRIBUTES.map((a) => a.key).filter((k) => chosen.has(k))
    A.setOption('pasteAttributes', list)
    A.closeDialog()
    A.pasteEventAttributes(list)
  }
  return (
    <Modal title="Selectively Paste Event Attributes" width={500}>
      <p className="dim" style={{ marginTop: 0 }}>
        From the copied event to the {count} selected event{count === 1 ? '' : 's'}. Keyframes keep their place from the start of each event.
      </p>
      <div className="paste-attrs">
        {A.EVENT_ATTRIBUTES.map((a) => (
          <label key={a.key} className="te-check">
            <input
              type="checkbox"
              checked={chosen.has(a.key)}
              onChange={(e) =>
                setChosen((c) => {
                  const next = new Set(c)
                  if (e.target.checked) next.add(a.key)
                  else next.delete(a.key)
                  return next
                })
              }
            />
            <span>
              {a.label}
              <span className="dim"> · {copiedSummary(a.key)}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={A.closeDialog}>
          Cancel
        </button>
        <button className="btn primary" disabled={chosen.size === 0 || count === 0} onClick={paste}>
          Paste
        </button>
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
    case 'pasteAttributes':
      return <PasteAttributesDialog />
    case 'ducking':
      return <DuckingDialog />
    case 'transition':
      return <TransitionWindow eventId={dialog.eventId} side={dialog.side} />
    case 'reframe':
      return <ReframeDialog />
    case 'reverse':
      return <ReverseDialog />
    case 'autoZoom':
      return <AutoZoomDialog />
    case 'agents':
      return <AgentDialog />
    case 'shortcuts':
      return <ShortcutsWindow />
    case 'about':
      return <AboutDialog />
    case 'update':
      return <UpdateDialog info={dialog.info} error={dialog.error} />
  }
}

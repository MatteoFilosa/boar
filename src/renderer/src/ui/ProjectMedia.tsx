import { useState } from 'react'
import { AlertTriangle, AudioLines, FolderInput, Image as ImageIcon, LoaderCircle, Trash2 } from 'lucide-react'
import * as A from '../core/actions'
import { useEditor } from '../core/store'
import { formatDuration, rateLabel, nearestStandardRate } from '../core/time'
import type { MediaItem } from '../core/types'
import { importFiles, openImportDialog } from '../media/importer'
import { startMediaDrag } from './mediaDrag'
import { shortcutLabel } from './shortcuts'

function describe(m: MediaItem): string {
  if (m.status === 'error') return m.error
  if (m.status === 'analyzing') return 'Analyzing…'
  const parts: string[] = []
  if (m.kind !== 'image') parts.push(formatDuration(m.duration))
  if (m.width) parts.push(`${m.width}x${m.height}`)
  if (m.fps) parts.push(`${rateLabel(nearestStandardRate(m.fps))} fps`)
  if (m.kind === 'audio' && m.sampleRate) parts.push(`${(m.sampleRate / 1000).toFixed(1)} kHz`)
  return parts.join(' · ')
}

function MediaTile({ media, selected, onSelect }: { media: MediaItem; selected: boolean; onSelect: () => void }): React.JSX.Element {
  return (
    <div
      className={`media-tile${selected ? ' selected' : ''}${media.status === 'error' ? ' error' : ''}`}
      title={`${media.name}\n${describe(media)}${media.path ? `\n${media.path}` : ''}\nDrag to the timeline or double-click to add at the cursor.`}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        onSelect()
        if (media.status === 'ready') startMediaDrag(media.id, e.clientX, e.clientY)
      }}
      onDoubleClick={() => A.addMediaToTimeline(media.id, useEditor.getState().cursor)}
    >
      <div className="media-thumb">
        {media.poster ? (
          <img src={media.poster} alt="" draggable={false} />
        ) : media.kind === 'audio' ? (
          <AudioLines size={28} />
        ) : media.kind === 'image' ? (
          <ImageIcon size={28} />
        ) : null}
        {media.status === 'analyzing' && <LoaderCircle className="spin media-badge" size={16} />}
        {media.status === 'error' && <AlertTriangle className="media-badge warn" size={16} />}
      </div>
      <div className="media-name">{media.name}</div>
      <div className="media-info">{describe(media)}</div>
    </div>
  )
}

export function ProjectMedia(): React.JSX.Element {
  const media = useEditor((s) => s.media)
  const [selected, setSelected] = useState<string | null>(null)
  const [dropping, setDropping] = useState(false)

  return (
    <div
      className={`project-media${dropping ? ' dropping' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDropping(true)
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDropping(false)
        importFiles(Array.from(e.dataTransfer.files))
      }}
    >
      <div className="panel-toolbar">
        <button className="tool-btn" title={`Import media (${shortcutLabel('importMedia')})`} onClick={() => openImportDialog()}>
          <FolderInput size={15} />
        </button>
        <button
          className="tool-btn"
          title="Remove from project (only media not used on the timeline)"
          disabled={!selected}
          onClick={() => {
            if (selected && A.removeUnusedMedia([selected]) > 0) setSelected(null)
          }}
        >
          <Trash2 size={15} />
        </button>
        <span className="panel-toolbar-info">
          {media.length} item{media.length === 1 ? '' : 's'}
        </span>
      </div>
      {media.length === 0 ? (
        <div className="empty-hint">
          <p>Drop video, audio or image files here</p>
          <p>
            or use <b>File › Import Media</b> ({shortcutLabel('importMedia')})
          </p>
        </div>
      ) : (
        <div className="media-grid">
          {media.map((m) => (
            <MediaTile key={m.id} media={m} selected={selected === m.id} onSelect={() => setSelected(m.id)} />
          ))}
        </div>
      )}
    </div>
  )
}

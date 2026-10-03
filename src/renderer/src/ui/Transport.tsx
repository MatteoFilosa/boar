import { ChevronFirst, ChevronLast, Pause, Play, Repeat, SkipBack, Square, StepBack, StepForward } from 'lucide-react'
import { useEditor } from '../core/store'
import { projectEnd } from '../core/timeline'
import { formatTimecode } from '../core/time'
import { ToolButton } from './Toolbar'

/** Playback controls and timecode, under the preview. */
export function Transport(): React.JSX.Element {
  const playing = useEditor((s) => s.playing)
  const loop = useEditor((s) => s.options.loop)
  const cursor = useEditor((s) => s.cursor)
  const rate = useEditor((s) => s.project.settings.frameRate)
  const end = useEditor((s) => projectEnd(s.project))
  return (
    <div className="transport">
      <ToolButton icon={Repeat} title="Loop playback" command="toggleLoop" active={loop} />
      <ToolButton icon={SkipBack} title="Play from start" command="playFromStart" />
      <ToolButton icon={Play} title="Play" command="play" active={playing} tone="play" />
      <ToolButton icon={Pause} title="Pause" command="playPause" tone="pause" />
      <ToolButton icon={Square} title="Stop" command="stop" tone="stop" />
      <div className="transport-nav">
        <div className="tool-sep" />
        <ToolButton icon={ChevronFirst} title="Go to start" command="goToStart" />
        <ToolButton icon={StepBack} title="Previous frame" command="previousFrame" />
        <ToolButton icon={StepForward} title="Next frame" command="nextFrame" />
        <ToolButton icon={ChevronLast} title="Go to end" command="goToEnd" />
      </div>
      <div className="transport-time">
        <span className="tc">{formatTimecode(cursor, rate)}</span>
        <span className="tc-dim">/ {formatTimecode(end, rate)}</span>
      </div>
    </div>
  )
}

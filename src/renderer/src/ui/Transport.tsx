import {
  Blend,
  ChevronFirst,
  ChevronLast,
  Magnet,
  Pause,
  Play,
  Repeat,
  SkipBack,
  Square,
  StepBack,
  StepForward
} from 'lucide-react'
import { useEditor } from '../core/store'
import { projectEnd } from '../core/timeline'
import { formatTimecode } from '../core/time'
import { RippleButton } from './RippleButton'
import { ToolButton } from './Toolbar'

export function Transport(): React.JSX.Element {
  const playing = useEditor((s) => s.playing)
  const options = useEditor((s) => s.options)
  const cursor = useEditor((s) => s.cursor)
  const rate = useEditor((s) => s.project.settings.frameRate)
  const end = useEditor((s) => projectEnd(s.project))
  return (
    <div className="transport">
      <ToolButton icon={Repeat} title="Loop playback" command="toggleLoop" active={options.loop} />
      <ToolButton icon={SkipBack} title="Play from start" command="playFromStart" />
      <ToolButton icon={Play} title="Play" command="play" active={playing} />
      <ToolButton icon={Pause} title="Pause" command="playPause" />
      <ToolButton icon={Square} title="Stop" command="stop" />
      <div className="tool-sep" />
      <ToolButton icon={ChevronFirst} title="Go to start" command="goToStart" />
      <ToolButton icon={StepBack} title="Previous frame" command="previousFrame" />
      <ToolButton icon={StepForward} title="Next frame" command="nextFrame" />
      <ToolButton icon={ChevronLast} title="Go to end" command="goToEnd" />
      <div className="transport-time">
        <span className="tc">{formatTimecode(cursor, rate)}</span>
        <span className="tc-dim">/ {formatTimecode(end, rate)}</span>
      </div>
      <div className="transport-tools">
        <ToolButton icon={Magnet} title="Enable snapping" command="toggleSnapping" active={options.snapping} />
        <ToolButton icon={Blend} title="Automatic crossfades" command="toggleCrossfades" active={options.autoCrossfade} />
        <RippleButton placement="above" />
      </div>
    </div>
  )
}

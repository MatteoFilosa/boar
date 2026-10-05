import * as A from '../core/actions'
import { useEditor } from '../core/store'
import { FLICKS_PER_SECOND } from '../core/time'
import { getEngine } from '../engine/preview'
import { importPaths, loadDemoMedia, openImportDialog } from '../media/importer'
import { openProject, saveProject } from '../core/session'
import { bridge } from '../platform'
import { toggleFullScreenPreview } from './fullScreen'
import { checkForUpdates } from './updates'

/**
 * Ctrl+V: an image on the system clipboard (a screenshot, "Copy image" in the
 * browser) goes on a new video track on top, at the cursor; otherwise the
 * copied events are pasted.
 */
async function paste(): Promise<void> {
  const path = bridge ? await bridge.clipboardImage().catch(() => null) : null
  if (!path) {
    A.pasteAtCursor()
    return
  }
  const media = await importPaths([path])[0]
  if (media) A.addMediaToTimeline(media.id, useEditor.getState().cursor, 'top')
}

/** Every user command, shared by menus, toolbar and keyboard shortcuts. */
export const commands = {
  newProject: A.newProject,
  openProject: (): void => void openProject(),
  saveProject: (): void => void saveProject(false),
  saveProjectAs: (): void => void saveProject(true),
  importMedia: (): void => openImportDialog(),
  properties: (): void => A.openDialog({ kind: 'projectProperties' }),
  render: (): void => {
    getEngine().pause()
    A.openDialog({ kind: 'render' })
  },
  undo: A.undo,
  redo: A.redo,
  // With a time selection, S / Delete / Shift+Delete act on that portion.
  split: (): void => (A.timeSelectionActive() ? A.splitAtTimeSelection() : A.splitAtCursor()),
  deleteSelection: (): void => A.deleteCommand(false),
  rippleDelete: (): void => A.deleteCommand(true),
  toggleRipple: (): void => A.toggleOption('autoRipple'),
  trimToSelection: A.trimToTimeSelection,
  selectInTimeSelection: A.selectEventsInTimeSelection,
  zoomToSelection: A.zoomToTimeSelection,
  clearTimeSelection: A.clearTimeSelection,
  playSelection: (): void => {
    const range = useEditor.getState().timeSelection
    if (!range) return
    getEngine().pause()
    A.setCursor(range.start)
    getEngine().play()
  },
  copy: (): void => void A.copySelection(),
  cut: A.cutSelection,
  paste: (): void => void paste(),
  removeFades: A.removeFadesFromSelection,
  selectAll: A.selectAll,
  group: A.groupSelection,
  ungroup: A.ungroupSelection,
  zoomIn: (): void => A.zoomStep(1),
  zoomOut: (): void => A.zoomStep(-1),
  zoomFit: A.zoomToFit,
  addVideoTrack: (): void => A.addTrack('video'),
  addAudioTrack: (): void => A.addTrack('audio'),
  addMarker: A.addMarkerAtCursor,
  panCrop: (): void => A.openPanCrop(),
  insertText: (): void => void A.addTextEvent('title', useEditor.getState().cursor),
  youtube: (): void => {
    if (!useEditor.getState().options.linkDownloads) {
      A.setStatus('Download from Link is an optional feature: enable it in Options')
      return
    }
    getEngine().pause()
    A.openDialog({ kind: 'youtube' })
  },
  toggleLinkDownloads: A.toggleLinkDownloads,
  saveSoundEffect: (): void => A.openSaveSoundEffect(),
  removeSilences: (): void => {
    getEngine().pause()
    A.openDialog({ kind: 'silence' })
  },
  autoReframe: (): void => {
    getEngine().pause()
    A.openDialog({ kind: 'reframe' })
  },
  blurredBackground: (): void => void A.blurredBackground(useEditor.getState().selection),
  splitScreen: (): void => void A.splitScreen(useEditor.getState().selection),
  pictureInPicture: (): void => void A.pictureInPicture(useEditor.getState().selection, 'topRight'),
  aiAgents: (): void => A.openDialog({ kind: 'agents' }),
  highlightKeywords: (): void => void A.enhanceCaptions('emphasis'),
  addEmoji: (): void => void A.enhanceCaptions('emoji'),
  autoZoom: (): void => {
    getEngine().pause()
    A.openDialog({ kind: 'autoZoom' })
  },
  removeBackground: (): void => void A.addFx(useEditor.getState().selection, 'removeBg'),
  autoDucking: (): void => {
    getEngine().pause()
    A.openDialog({ kind: 'ducking' })
  },
  captions: (): void => {
    getEngine().pause()
    A.openDialog({ kind: 'captions' })
  },
  editText: (): void => A.openTextEditor(),
  mask: (): void => A.openMaskEditor(),
  videoFx: (): void => A.openFxWindow('video'),
  audioFx: (): void => A.openFxWindow('audio'),
  fillFrame: (): void => A.reframeVideoEvents('fill'),
  fitFrame: (): void => A.reframeVideoEvents('fit'),
  rotateClockwise: (): void => void A.rotateEvents(useEditor.getState().selection, 90),
  rotateCounterclockwise: (): void => void A.rotateEvents(useEditor.getState().selection, -90),
  resetRotation: (): void => void A.rotateEvents(useEditor.getState().selection, 'reset'),
  toggleSafeAreas: (): void => A.setOption('safeAreas', !useEditor.getState().options.safeAreas),
  fullScreenPreview: toggleFullScreenPreview,
  toggleSnapping: (): void => A.toggleOption('snapping'),
  toggleCrossfades: (): void => A.toggleOption('autoCrossfade'),
  toggleQuantize: (): void => A.toggleOption('quantize'),
  toggleLoop: (): void => A.toggleOption('loop'),
  play: (): void => getEngine().play(),
  pause: (): void => getEngine().pause(),
  stop: (): void => getEngine().stop(),
  // Space: pauses where it is, or (Options) stops back at the start position.
  playStop: (): void => getEngine().togglePlay(useEditor.getState().options.spaceReturns),
  playPause: (): void => getEngine().togglePlay(false),
  playFromStart: (): void => getEngine().playFromStart(),
  previousFrame: (): void => A.stepFrames(-1),
  nextFrame: (): void => A.stepFrames(1),
  previousEditPoint: (): void => A.jumpToEditPoint(-1),
  nextEditPoint: (): void => A.jumpToEditPoint(1),
  goToStart: A.goToStart,
  goToEnd: A.goToEnd,
  backOneSecond: (): void => A.setCursor(useEditor.getState().cursor - FLICKS_PER_SECOND),
  shortcuts: (): void => (useEditor.getState().dialog?.kind === 'shortcuts' ? A.closeDialog() : A.openDialog({ kind: 'shortcuts' })),
  searchCommands: (): void => document.querySelector<HTMLInputElement>('#command-search')?.select(),
  about: (): void => A.openDialog({ kind: 'about' }),
  checkForUpdates: (): void => void checkForUpdates(true),
  toggleUpdateCheck: (): void => A.toggleOption('checkUpdates'),
  toggleProxies: (): void => A.toggleOption('proxies'),
  toggleSpaceReturns: (): void => A.toggleOption('spaceReturns'),
  themes: (): void => A.openDialog({ kind: 'themes' }),
  loadDemoMedia: (): void => void loadDemoMedia()
}

export type CommandId = keyof typeof commands

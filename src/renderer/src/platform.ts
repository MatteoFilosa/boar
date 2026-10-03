import type { Transcript } from './core/captions'

/** API exposed by src/preload/index.ts. Absent when the UI runs in a plain browser. */
export interface BoarBridge {
  platform: string
  pathForFile(file: File): string
  /** Shows a save dialog; only paths returned here can be written. */
  pickExportPath(suggestedName: string): Promise<string | null>
  openFile(path: string): Promise<number>
  writeFile(id: number, position: number, data: Uint8Array): Promise<void>
  closeFile(id: number): Promise<void>
  discardFile(path: string): Promise<void>
  revealFile(path: string): Promise<void>
  /** Writes a project, asking for a path when there is none (or saveAs). Null if cancelled. */
  saveProject(json: string, currentPath: string | null, saveAs: boolean): Promise<string | null>
  openProject(): Promise<{ path: string; json: string } | null>
  captionsStatus(): Promise<CaptionStatus>
  downloadModel(id: string): Promise<void>
  /** Phrases and token-level times of the speech in a media range (see core/captions.ts). */
  transcribe(request: TranscribeRequest): Promise<Transcript>
  onCaptionProgress(callback: (progress: CaptionProgress) => void): () => void
  /** Bytes of a bundled file:// asset (packaged app). */
  readAsset(url: string): Promise<Uint8Array>
  /** Media library folders picked by the user (Explorer tab). */
  libraryFolders(): Promise<LibraryFolder[]>
  addLibraryFolder(): Promise<string | null>
  removeLibraryFolder(path: string): Promise<void>
  listLibrary(dir: string): Promise<LibraryEntry[]>
  revealInLibrary(path: string): Promise<void>
  /** Writes a new file into a library folder (never overwrites); returns its path. */
  saveToLibrary(dir: string, name: string, ext: string, data: Uint8Array): Promise<string>
  /** Saves the clipboard image as a PNG file; null when the clipboard has no image. */
  clipboardImage(): Promise<string | null>
  claimClipboard(): Promise<void>
  youtubeStatus(): Promise<YoutubeStatus>
  installYtDlp(): Promise<void>
  updateYtDlp(): Promise<string>
  downloadYoutube(request: YoutubeRequest): Promise<string>
  cancelYoutube(): Promise<void>
  onYoutubeProgress(callback: (progress: YoutubeProgress) => void): () => void
  /** Requests from AI agents through the MCP server (src/main/mcp.ts). */
  onAgentRequest(callback: (request: AgentRequest) => void): () => void
  agentRespond(id: number, ok: boolean, value: unknown): void
  agentStatus(): Promise<AgentStatus>
  agentSetEnabled(enabled: boolean): Promise<AgentStatus>
  agentNewToken(): Promise<AgentStatus>
}

export interface AgentRequest {
  id: number
  kind: 'list' | 'call' | 'prompts' | 'prompt'
  payload: unknown
  /** Name of the agent (from its MCP initialize request). */
  client: string
}

export interface AgentStatus {
  enabled: boolean
  listening: boolean
  port: number
  url: string
  token: string
  error: string
  client: string
  bridgePath: string
  bridgeCommand: string
  bridgeEnv: Record<string, string>
  configPath: string
}

export interface LibraryFolder {
  path: string
  name: string
  exists: boolean
}

export interface LibraryEntry {
  name: string
  path: string
  dir: boolean
  size: number
  modified: number
}

export interface YoutubeStatus {
  ytdlp: { path: string; version: string } | null
  ffmpeg: boolean
}

export interface YoutubeRequest {
  url: string
  format: 'mp4' | 'mp3'
  maxHeight: number
  folder: string
}

export interface YoutubeProgress {
  phase: 'install' | 'download' | 'convert'
  progress: number
  text: string
}

export interface WhisperModelInfo {
  id: string
  file: string
  sizeMB: number
  note: string
  installed: boolean
}

export interface CaptionStatus {
  ffmpeg: boolean
  whisper: boolean
  models: WhisperModelInfo[]
}

export interface TranscribeRequest {
  path: string
  start: number
  duration: number
  model: string
  language: string
}

export interface CaptionProgress {
  phase: 'download' | 'transcribe'
  progress: number
}

/** Scheme served by the main process for media of opened projects (see src/main/media-protocol.ts). */
export const mediaPathUrl = (path: string): string => `boar-media://local/${encodeURIComponent(path)}`

declare global {
  /** package.json version, set by Vite. */
  const __APP_VERSION__: string
  interface Window {
    boar?: BoarBridge
    /** Set once the UI has mounted; read by the Electron smoke test. */
    __boarReady?: boolean
    /** Unsaved changes; read by the main process before closing the window. */
    __boarDirty?: boolean
  }
}

export const bridge: BoarBridge | null = window.boar ?? null
export const isElectron = bridge !== null
export const isMac = bridge ? bridge.platform === 'darwin' : /Mac/.test(navigator.platform)
/** Modifier names for help texts: Cmd and Option on a Mac. */
export const MOD = isMac ? '⌘' : 'Ctrl'
export const ALT = isMac ? '⌥' : 'Alt'

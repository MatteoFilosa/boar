import { contextBridge, ipcRenderer, webUtils } from 'electron'

// Keep in sync with BoarBridge in src/renderer/src/platform.ts.
contextBridge.exposeInMainWorld('boar', {
  platform: process.platform,
  pathForFile(file: File): string {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  pickExportPath: (suggestedName: string): Promise<string | null> => ipcRenderer.invoke('export:pick', suggestedName),
  openFile: (path: string): Promise<number> => ipcRenderer.invoke('export:open', path),
  writeFile: (id: number, position: number, data: Uint8Array): Promise<void> =>
    ipcRenderer.invoke('export:write', id, position, data),
  closeFile: (id: number): Promise<void> => ipcRenderer.invoke('export:close', id),
  discardFile: (path: string): Promise<void> => ipcRenderer.invoke('export:discard', path),
  revealFile: (path: string): Promise<void> => ipcRenderer.invoke('shell:reveal', path),
  saveProject: (json: string, currentPath: string | null, saveAs: boolean): Promise<string | null> =>
    ipcRenderer.invoke('project:save', json, currentPath, saveAs),
  openProject: (): Promise<{ path: string; json: string } | null> => ipcRenderer.invoke('project:open'),
  saveTheme: (json: string, name: string): Promise<string | null> => ipcRenderer.invoke('theme:save', json, name),
  captionsStatus: (): Promise<unknown> => ipcRenderer.invoke('captions:status'),
  downloadModel: (id: string): Promise<void> => ipcRenderer.invoke('captions:download', id),
  startTranscription: (request: unknown): Promise<number> => ipcRenderer.invoke('captions:start', request),
  sendTranscriptionAudio: (id: number, data: Uint8Array): Promise<void> => ipcRenderer.invoke('captions:audio', id, data),
  finishTranscription: (id: number): Promise<unknown> => ipcRenderer.invoke('captions:finish', id),
  cancelTranscription: (id: number): Promise<void> => ipcRenderer.invoke('captions:cancel', id),
  onCaptionProgress(callback: (progress: unknown) => void): () => void {
    const listener = (_event: unknown, progress: unknown): void => callback(progress)
    ipcRenderer.on('captions:progress', listener)
    return () => ipcRenderer.removeListener('captions:progress', listener)
  },
  readAsset: (url: string): Promise<Uint8Array> => ipcRenderer.invoke('app:readAsset', url),
  findProxy: (source: string): Promise<string | null> => ipcRenderer.invoke('proxy:find', source),
  createProxy: (source: string): Promise<number> => ipcRenderer.invoke('proxy:create', source),
  writeProxy: (id: number, position: number, data: Uint8Array): Promise<void> => ipcRenderer.invoke('proxy:write', id, position, data),
  finishProxy: (id: number): Promise<string> => ipcRenderer.invoke('proxy:finish', id),
  abortProxy: (id: number): Promise<void> => ipcRenderer.invoke('proxy:abort', id),
  deleteProxy: (source: string): Promise<void> => ipcRenderer.invoke('proxy:delete', source),
  setProgress: (value: number): void => ipcRenderer.send('app:progress', value),
  libraryFolders: (): Promise<unknown> => ipcRenderer.invoke('library:folders'),
  addLibraryFolder: (): Promise<string | null> => ipcRenderer.invoke('library:addFolder'),
  removeLibraryFolder: (path: string): Promise<void> => ipcRenderer.invoke('library:removeFolder', path),
  listLibrary: (dir: string): Promise<unknown> => ipcRenderer.invoke('library:list', dir),
  revealInLibrary: (path: string): Promise<void> => ipcRenderer.invoke('library:reveal', path),
  saveToLibrary: (dir: string, name: string, ext: string, data: Uint8Array): Promise<string> =>
    ipcRenderer.invoke('library:save', dir, name, ext, data),
  clipboardImage: (): Promise<string | null> => ipcRenderer.invoke('clipboard:image'),
  claimClipboard: (): Promise<void> => ipcRenderer.invoke('clipboard:claim'),
  youtubeStatus: (): Promise<unknown> => ipcRenderer.invoke('youtube:status'),
  installYtDlp: (): Promise<void> => ipcRenderer.invoke('youtube:install'),
  updateYtDlp: (): Promise<string> => ipcRenderer.invoke('youtube:update'),
  downloadYoutube: (request: unknown): Promise<string> => ipcRenderer.invoke('youtube:download', request),
  cancelYoutube: (): Promise<void> => ipcRenderer.invoke('youtube:cancel'),
  onYoutubeProgress(callback: (progress: unknown) => void): () => void {
    const listener = (_event: unknown, progress: unknown): void => callback(progress)
    ipcRenderer.on('youtube:progress', listener)
    return () => ipcRenderer.removeListener('youtube:progress', listener)
  },
  onAgentRequest(callback: (request: unknown) => void): () => void {
    const listener = (_event: unknown, request: unknown): void => callback(request)
    ipcRenderer.on('agent:request', listener)
    return () => ipcRenderer.removeListener('agent:request', listener)
  },
  agentRespond: (id: number, ok: boolean, value: unknown): void => ipcRenderer.send('agent:response', id, ok, value),
  agentStatus: (): Promise<unknown> => ipcRenderer.invoke('agent:status'),
  agentSetEnabled: (enabled: boolean): Promise<unknown> => ipcRenderer.invoke('agent:setEnabled', enabled),
  agentNewToken: (): Promise<unknown> => ipcRenderer.invoke('agent:newToken'),
  checkUpdate: (): Promise<unknown> => ipcRenderer.invoke('update:check'),
  downloadUpdate: (): Promise<void> => ipcRenderer.invoke('update:download'),
  cancelUpdate: (): Promise<void> => ipcRenderer.invoke('update:cancel'),
  installUpdate: (now: boolean): Promise<void> => ipcRenderer.invoke('update:install', now),
  openUpdatePage: (): Promise<void> => ipcRenderer.invoke('update:page'),
  onUpdateProgress(callback: (progress: number) => void): () => void {
    const listener = (_event: unknown, progress: number): void => callback(progress)
    ipcRenderer.on('update:progress', listener)
    return () => ipcRenderer.removeListener('update:progress', listener)
  }
})

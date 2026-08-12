import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  CaptureStatus,
  CoachError,
  CoachResult,
  ScreenPermissionInfo
} from '../../shared/types'

export type { AppSettings, CaptureStatus, CoachError, CoachResult, ScreenPermissionInfo }

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_: unknown, payload: T) => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api = {
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Partial<AppSettings> & { apiKey?: string }): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:set', patch),
  clearApiKey: (): Promise<AppSettings> => ipcRenderer.invoke('settings:clear-key'),

  coachFromText: (text: string): Promise<CoachResult | CoachError> =>
    ipcRenderer.invoke('coach:from-text', text),
  coachFromAudio: (payload: {
    base64: string
    mimeType: string
  }): Promise<CoachResult | CoachError> => ipcRenderer.invoke('coach:from-audio', payload),

  getScreenPermission: (): Promise<ScreenPermissionInfo> =>
    ipcRenderer.invoke('permissions:screen-info'),
  requestScreenPermission: (): Promise<ScreenPermissionInfo> =>
    ipcRenderer.invoke('permissions:request-screen'),
  openScreenSettings: (): Promise<void> => ipcRenderer.invoke('permissions:open-settings'),
  showPermissionHelp: (): Promise<ScreenPermissionInfo> =>
    ipcRenderer.invoke('permissions:show-help'),
  getDesktopSources: (): Promise<{ id: string; name: string }[]> =>
    ipcRenderer.invoke('desktop:get-sources'),

  startListening: () => ipcRenderer.send('listening:start'),
  stopListening: () => ipcRenderer.send('listening:stop'),
  hideOverlay: () => ipcRenderer.send('overlay:hide'),
  quit: () => ipcRenderer.send('overlay:quit'),

  emitCaptureStatus: (status: CaptureStatus) => ipcRenderer.send('capture:status', status),
  emitTranscript: (data: CoachResult) => ipcRenderer.send('capture:transcript', data),
  emitHint: (data: CoachResult) => ipcRenderer.send('capture:hint', data),

  onCaptureStatus: (cb: (status: CaptureStatus) => void) => on<CaptureStatus>('capture:status', cb),
  onTranscript: (cb: (data: CoachResult) => void) => on<CoachResult>('capture:transcript', cb),
  onHint: (cb: (data: CoachResult) => void) => on<CoachResult>('capture:hint', cb),
  onListeningState: (cb: (value: boolean) => void) => on<boolean>('listening:state', cb),
  onSettingsChanged: (cb: (settings: AppSettings) => void) =>
    on<AppSettings>('settings:changed', cb),
  onScreenPermission: (cb: (info: ScreenPermissionInfo) => void) =>
    on<ScreenPermissionInfo>('permissions:screen', cb),
  onHotkeysFailed: (cb: (accelerators: string[]) => void) => on<string[]>('hotkeys:failed', cb),
  onListeningStart: (cb: () => void) => on<void>('listening:start', cb),
  onListeningStop: (cb: () => void) => on<void>('listening:stop', cb)
}

export type CopilotApi = typeof api

contextBridge.exposeInMainWorld('copilot', api)

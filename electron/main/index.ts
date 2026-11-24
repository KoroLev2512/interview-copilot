import { app, BrowserWindow, desktopCapturer, ipcMain, screen, systemPreferences } from 'electron'
import { join } from 'path'
import { config } from 'dotenv'
import { existsSync } from 'fs'
import { CoachService } from './coach'
import { registerHotkeys, unregisterHotkeys } from './hotkeys'
import {
  getScreenPermissionInfo,
  openScreenRecordingSettings,
  setupDisplayMediaHandler,
  showPermissionHelpDialog,
  triggerScreenCapturePrompt
} from './permissions'
import { SettingsStore } from './settings'
import type { AppSettings, CaptureStatus, CoachResult } from '../../shared/types'

app.setName('Interview Copilot')

const isDev = !app.isPackaged
const isDebug = Boolean(process.env.COPILOT_DEBUG)
const COMPACT_HEIGHT = 320
const FULL_HEIGHT = 560

if (process.platform === 'darwin') {
  app.commandLine.appendSwitch(
    'enable-features',
    'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride'
  )
}

loadEnvFiles()

const settings = new SettingsStore()
const coach = new CoachService(settings)

let overlayWindow: BrowserWindow | null = null
let captureWindow: BrowserWindow | null = null
let listening = false

/** В собранном .app cwd = «/», поэтому .env ищем ещё и в userData и рядом с приложением. */
function loadEnvFiles(): void {
  const candidates = [
    join(process.cwd(), '.env'),
    join(app.getPath('userData'), '.env'),
    join(app.getAppPath(), '.env')
  ]
  for (const path of candidates) {
    if (existsSync(path)) config({ path, override: false })
  }
}

function sendToOverlay(channel: string, payload?: unknown): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  overlayWindow.webContents.send(channel, payload)
}

function broadcastScreenPermission(): void {
  sendToOverlay('permissions:screen', getScreenPermissionInfo())
}

function createOverlayWindow(): void {
  const { width } = screen.getPrimaryDisplay().workAreaSize

  overlayWindow = new BrowserWindow({
    width: 420,
    height: settings.get().compact ? COMPACT_HEIGHT : FULL_HEIGHT,
    minWidth: 320,
    minHeight: 200,
    x: width - 440,
    y: 48,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: true,
    vibrancy: 'under-window',
    visualEffectState: 'active',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true
    }
  })

  // Overlay не должен попадать в шаринг экрана Zoom/Meet/Teams.
  overlayWindow.setContentProtection(true)
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  overlayWindow.setAlwaysOnTop(true, 'screen-saver')

  loadRenderer(overlayWindow)

  overlayWindow.on('ready-to-show', () => {
    overlayWindow?.show()
    broadcastScreenPermission()
  })

  overlayWindow.on('closed', () => {
    overlayWindow = null
  })
}

function createCaptureWindow(): void {
  captureWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      // Скрытому окну нельзя засыпать, иначе запись рвётся, когда overlay не в фокусе.
      backgroundThrottling: false,
      // AudioContext для сведения микрофона стартует без пользовательского жеста.
      autoplayPolicy: 'no-user-gesture-required'
    }
  })

  loadRenderer(captureWindow, 'capture')

  // Окно скрыто, поэтому иначе его консоль и ошибки захвата увидеть негде.
  if (isDebug) captureWindow.webContents.openDevTools({ mode: 'detach' })

  captureWindow.on('closed', () => {
    captureWindow = null
  })
}

function loadRenderer(win: BrowserWindow, hash?: string): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devUrl) {
    win.loadURL(hash ? `${devUrl}#${hash}` : devUrl)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), hash ? { hash } : undefined)
  }
}

function toggleOverlay(): void {
  if (!overlayWindow) {
    createOverlayWindow()
    return
  }
  if (overlayWindow.isVisible()) {
    overlayWindow.hide()
  } else {
    overlayWindow.showInactive()
    overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  }
}

function startListening(): void {
  if (listening) return
  listening = true
  coach.resetSession()
  void triggerScreenCapturePrompt().then(broadcastScreenPermission)
  captureWindow?.webContents.send('listening:start')
  sendToOverlay('listening:state', true)
}

function stopListening(): void {
  if (!listening) return
  listening = false
  captureWindow?.webContents.send('listening:stop')
  sendToOverlay('listening:state', false)
}

function toggleListening(): void {
  if (listening) stopListening()
  else startListening()
}

function toggleCompact(): void {
  const next = !settings.get().compact
  settings.set({ compact: next })
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    const [w] = overlayWindow.getSize()
    overlayWindow.setSize(w, next ? COMPACT_HEIGHT : FULL_HEIGHT, true)
  }
  sendToOverlay('settings:changed', settings.get())
}

function registerIpc(): void {
  ipcMain.handle('settings:get', () => settings.get())

  ipcMain.handle('settings:set', (_, patch: Partial<AppSettings> & { apiKey?: string }) => {
    settings.set(patch)
    const next = settings.get()
    sendToOverlay('settings:changed', next)
    return next
  })

  ipcMain.handle('settings:clear-key', () => {
    settings.clearApiKey()
    const next = settings.get()
    sendToOverlay('settings:changed', next)
    return next
  })

  ipcMain.handle('permissions:screen-info', () => getScreenPermissionInfo())

  ipcMain.handle('permissions:request-screen', async () => {
    const info = await triggerScreenCapturePrompt()
    broadcastScreenPermission()
    return info
  })

  ipcMain.handle('permissions:open-settings', () => {
    openScreenRecordingSettings()
  })

  ipcMain.handle('permissions:show-help', async () => {
    const info = getScreenPermissionInfo()
    await showPermissionHelpDialog(info)
    return info
  })

  ipcMain.handle('coach:from-text', (_, text: string) => coach.suggestFromText(text))

  ipcMain.handle('coach:from-audio', (_, payload: { base64: string; mimeType: string }) => {
    const buffer = Buffer.from(payload.base64, 'base64')
    return coach.suggestFromAudio(buffer, payload.mimeType)
  })

  ipcMain.handle('desktop:get-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 128, height: 128 }
    })
    return sources.map((s) => ({ id: s.id, name: s.name }))
  })

  ipcMain.on('capture:status', (_, status: CaptureStatus) => {
    if (isDebug) console.log('[capture] status:', status)
    sendToOverlay('capture:status', status)
  })

  ipcMain.on('capture:transcript', (_, data: CoachResult) => {
    if (isDebug) console.log('[capture] transcript:', JSON.stringify(data.transcript))
    sendToOverlay('capture:transcript', data)
  })

  ipcMain.on('capture:hint', (_, data: CoachResult) => {
    sendToOverlay('capture:hint', data)
  })

  ipcMain.on('listening:start', startListening)
  ipcMain.on('listening:stop', stopListening)
  ipcMain.on('overlay:hide', () => overlayWindow?.hide())
  ipcMain.on('overlay:quit', () => app.quit())
}

async function ensureMacPermissions(): Promise<void> {
  if (process.platform !== 'darwin') return

  const mic = systemPreferences.getMediaAccessStatus('microphone')
  if (mic !== 'granted') await systemPreferences.askForMediaAccess('microphone')

  await triggerScreenCapturePrompt()
  broadcastScreenPermission()
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    overlayWindow?.show()
    overlayWindow?.focus()
  })

  app.whenReady().then(async () => {
    setupDisplayMediaHandler()
    // Хендлеры — до окон: рендерер дёргает settings:get сразу на маунте.
    registerIpc()

    createOverlayWindow()
    createCaptureWindow()

    const failed = registerHotkeys({ toggleOverlay, toggleListening, toggleCompact })
    if (failed.length) sendToOverlay('hotkeys:failed', failed)

    // Диалог доступа к микрофону блокирует поток, поэтому только после registerIpc().
    await ensureMacPermissions()
  })

  app.on('activate', () => {
    if (!overlayWindow) createOverlayWindow()
    if (!captureWindow) createCaptureWindow()
  })
}

app.on('will-quit', unregisterHotkeys)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

import { clipboard, desktopCapturer, dialog, shell, session, systemPreferences } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import type { ScreenPermissionInfo } from '../../shared/types'

export type { ScreenPermissionInfo }

export function getElectronAppPath(): string {
  const devPath = join(process.cwd(), 'node_modules/electron/dist/Electron.app')
  if (existsSync(devPath)) return devPath
  return process.execPath.replace(/\/Contents\/MacOS\/[^/]+$/, '.app') || process.execPath
}

export function getScreenPermissionInfo(): ScreenPermissionInfo {
  const status = systemPreferences.getMediaAccessStatus('screen')
  const electronAppPath = getElectronAppPath()

  let hint =
    'В списке ищите «Electron» (режим разработки) или «Interview Copilot». Если их нет — добавьте вручную через «+».'

  if (status === 'denied') {
    hint =
      'Доступ запрещён. Включите переключатель для Electron в настройках или добавьте Electron.app вручную через «+», затем перезапустите приложение (Cmd+Q).'
  } else if (status === 'not-determined') {
    hint =
      'Нажмите «Запросить доступ» — macOS должна показать диалог. Если списка нет, добавьте Electron.app вручную через «+» в настройках.'
  } else if (status === 'granted') {
    hint = 'Запись экрана разрешена. Можно нажимать «Слушать созвон».'
  }

  return { status, electronAppPath, hint }
}

/** Forces macOS to register the app in Screen Recording (TCC). */
export async function triggerScreenCapturePrompt(): Promise<ScreenPermissionInfo> {
  if (process.platform !== 'darwin') return getScreenPermissionInfo()

  try {
    await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 128, height: 128 },
      fetchWindowIcons: false
    })
  } catch (err) {
    console.error('[permissions] desktopCapturer.getSources failed:', err)
  }

  return getScreenPermissionInfo()
}

export function openScreenRecordingSettings(): void {
  shell.openExternal(
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
  )
}

export async function showPermissionHelpDialog(info: ScreenPermissionInfo): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: info.status === 'granted' ? 'info' : 'warning',
    title: 'Доступ к записи экрана и звука',
    message:
      info.status === 'granted'
        ? 'Доступ уже выдан'
        : 'Добавьте приложение в настройки macOS',
    detail: [
      info.hint,
      '',
      'Путь для ручного добавления через «+»:',
      info.electronAppPath,
      '',
      'Также проверьте в списке: Cursor, Terminal, iTerm — если запускали npm run dev оттуда.',
      '',
      'После включения: Cmd+Q → снова npm run dev.'
    ].join('\n'),
    buttons: ['Открыть настройки', 'Скопировать путь', 'OK'],
    defaultId: 0,
    cancelId: 2
  })

  if (response === 0) openScreenRecordingSettings()
  if (response === 1) {
    clipboard.writeText(info.electronAppPath)
  }
}

export function setupDisplayMediaHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 128, height: 128 }
        })
        const source = sources[0]
        if (!source) {
          callback({})
          return
        }
        callback({
          video: source,
          audio: 'loopback'
        })
      } catch (err) {
        console.error('[permissions] displayMedia handler failed:', err)
        callback({})
      }
    },
    { useSystemPicker: false }
  )
}

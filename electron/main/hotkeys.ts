import { globalShortcut } from 'electron'
import { HOTKEYS } from '../../shared/types'

type Handlers = {
  toggleOverlay: () => void
  toggleListening: () => void
  toggleCompact: () => void
}

/** @returns список хоткеев, которые macOS не отдал (заняты другим приложением). */
export function registerHotkeys(handlers: Handlers): string[] {
  const failed: string[] = []

  for (const [name, accelerator] of Object.entries(HOTKEYS)) {
    const handler = handlers[name as keyof Handlers]
    const ok = globalShortcut.register(accelerator, handler)
    if (!ok) {
      failed.push(accelerator)
      console.warn(`[hotkeys] не удалось зарегистрировать ${accelerator}`)
    }
  }

  return failed
}

export function unregisterHotkeys(): void {
  globalShortcut.unregisterAll()
}

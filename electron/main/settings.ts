import Store from 'electron-store'
import { safeStorage } from 'electron'
import type { AppSettings } from '../../shared/types'

/** То, что реально лежит на диске: настройки + зашифрованный ключ. */
type Persisted = Omit<AppSettings, 'hasApiKey'> & {
  /** base64 от safeStorage.encryptString, либо plain-текст если шифрование недоступно. */
  apiKey: string
  apiKeyEncrypted: boolean
}

const defaults: Persisted = {
  role: 'Backend / Full-stack',
  stack: 'TypeScript, Node.js, PostgreSQL, React',
  language: 'auto',
  chunkSeconds: clampChunk(Number(process.env.CHUNK_SECONDS) || 6),
  vadThreshold: 0.012,
  notes: '',
  compact: false,
  apiKey: '',
  apiKeyEncrypted: false
}

function clampChunk(value: number): number {
  if (!Number.isFinite(value)) return 6
  return Math.min(20, Math.max(3, Math.round(value)))
}

function clampThreshold(value: number): number {
  if (!Number.isFinite(value)) return 0.012
  return Math.min(0.2, Math.max(0, value))
}

export class SettingsStore {
  private store = new Store<Persisted>({ name: 'settings', defaults })

  /** Настройки для рендерера — без самого ключа. */
  get(): AppSettings {
    const { apiKey, apiKeyEncrypted, ...rest } = this.store.store
    void apiKey
    void apiKeyEncrypted
    return { ...rest, hasApiKey: this.getApiKey().length > 0 }
  }

  set(patch: Partial<AppSettings> & { apiKey?: string }): void {
    const { apiKey, hasApiKey, ...rest } = patch
    void hasApiKey

    if (rest.chunkSeconds !== undefined) rest.chunkSeconds = clampChunk(Number(rest.chunkSeconds))
    if (rest.vadThreshold !== undefined) rest.vadThreshold = clampThreshold(Number(rest.vadThreshold))

    this.store.set(rest)

    // Пустая строка от UI = «не менять»; сброс делает clearApiKey().
    if (typeof apiKey === 'string' && apiKey.trim()) this.setApiKey(apiKey.trim())
  }

  /** Ключ из настроек, иначе из окружения (.env). */
  getApiKey(): string {
    const stored = this.store.get('apiKey', '')
    if (stored) {
      if (!this.store.get('apiKeyEncrypted', false)) return stored
      try {
        return safeStorage.decryptString(Buffer.from(stored, 'base64'))
      } catch (err) {
        console.error('[settings] не удалось расшифровать ключ:', err)
      }
    }
    return process.env.OPENAI_API_KEY?.trim() || ''
  }

  setApiKey(key: string): void {
    let encrypted = false
    let value = key

    try {
      if (safeStorage.isEncryptionAvailable()) {
        value = safeStorage.encryptString(key).toString('base64')
        encrypted = true
      }
    } catch (err) {
      console.error('[settings] safeStorage недоступен, ключ сохранён как есть:', err)
    }

    this.store.set({ apiKey: value, apiKeyEncrypted: encrypted })
  }

  clearApiKey(): void {
    this.store.set({ apiKey: '', apiKeyEncrypted: false })
  }
}

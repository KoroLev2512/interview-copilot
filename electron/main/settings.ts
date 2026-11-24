import Store from 'electron-store'
import { safeStorage } from 'electron'
import type { AppSettings } from '../../shared/types'

/** То, что реально лежит на диске: настройки + зашифрованный ключ. */
type Persisted = Omit<AppSettings, 'hasApiKey' | 'chunkSeconds'> & {
  /**
   * Только явный выбор в UI. Пока его нет — берём CHUNK_SECONDS из .env,
   * поэтому в defaults это поле класть нельзя: conf пишет defaults на диск.
   */
  chunkSeconds?: number
  /** Версия формата файла настроек — для одноразовых миграций. */
  settingsVersion?: number
  /** base64 от safeStorage.encryptString, либо plain-текст если шифрование недоступно. */
  apiKey: string
  apiKeyEncrypted: boolean
}

const defaults: Persisted = {
  role: 'Backend / Full-stack',
  stack: 'TypeScript, Node.js, PostgreSQL, React',
  language: 'auto',
  vadThreshold: 0.012,
  notes: '',
  captureMic: false,
  compact: false,
  apiKey: '',
  apiKeyEncrypted: false
}

const SETTINGS_VERSION = 2
/** Что раньше всегда записывалось в файл как default — .env тогда ещё не был прочитан. */
const LEGACY_CHUNK_DEFAULT = 6

/** Читается на каждый вызов: модуль импортируется раньше, чем main загрузит .env. */
function envChunkSeconds(): number {
  return clampChunk(Number(process.env.CHUNK_SECONDS) || 6)
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

  constructor() {
    this.migrate()
  }

  /**
   * v1 записывал chunkSeconds = 6 в файл ещё до чтения .env, и CHUNK_SECONDS
   * навсегда переставал действовать. Отличить это от выбора «6» в UI нельзя,
   * поэтому шестёрку отдаём обратно .env — с ним по умолчанию те же 6 с.
   */
  private migrate(): void {
    if ((this.store.get('settingsVersion') ?? 1) >= SETTINGS_VERSION) return
    if (this.store.get('chunkSeconds') === LEGACY_CHUNK_DEFAULT) this.store.delete('chunkSeconds')
    this.store.set('settingsVersion', SETTINGS_VERSION)
  }

  /** Явный выбор из UI, иначе CHUNK_SECONDS, иначе 6. */
  private chunkSeconds(): number {
    const stored = this.store.get('chunkSeconds')
    return stored === undefined ? envChunkSeconds() : clampChunk(stored)
  }

  /** Настройки для рендерера — без самого ключа. */
  get(): AppSettings {
    const { apiKey, apiKeyEncrypted, settingsVersion, ...rest } = this.store.store
    void apiKey
    void apiKeyEncrypted
    void settingsVersion
    return { ...rest, chunkSeconds: this.chunkSeconds(), hasApiKey: this.getApiKey().length > 0 }
  }

  set(patch: Partial<AppSettings> & { apiKey?: string }): void {
    const { apiKey, hasApiKey, chunkSeconds, ...rest } = patch
    void hasApiKey

    if (rest.vadThreshold !== undefined) rest.vadThreshold = clampThreshold(Number(rest.vadThreshold))

    this.store.set(rest)

    // UI шлёт форму целиком: сохраняем длину чанка, только если её реально сдвинули,
    // иначе любое «Сохранить» навсегда перекрыло бы CHUNK_SECONDS.
    if (chunkSeconds !== undefined) {
      const next = clampChunk(Number(chunkSeconds))
      if (next !== this.chunkSeconds()) this.store.set('chunkSeconds', next)
    }

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

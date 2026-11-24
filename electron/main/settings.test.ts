import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsStore } from './settings'

/** Содержимое settings.json: тест может засеять его до создания стора. */
const { disk, crypto } = vi.hoisted(() => ({
  disk: { data: {} as Record<string, unknown> },
  crypto: { available: true, failDecrypt: false }
}))

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => crypto.available,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => {
      if (crypto.failDecrypt) throw new Error('keychain locked')
      return b.toString().slice('enc:'.length)
    }
  }
}))

/** Как conf: при создании дописывает defaults в файл — именно это и ломало CHUNK_SECONDS. */
vi.mock('electron-store', () => ({
  default: class {
    constructor(opts: { defaults: Record<string, unknown> }) {
      disk.data = { ...opts.defaults, ...disk.data }
    }
    get store() {
      return { ...disk.data }
    }
    get(key: string, fallback?: unknown) {
      return key in disk.data ? disk.data[key] : fallback
    }
    set(key: string | Record<string, unknown>, value?: unknown) {
      if (typeof key === 'string') disk.data[key] = value
      else Object.assign(disk.data, key)
    }
    delete(key: string) {
      delete disk.data[key]
    }
  }
}))

beforeEach(() => {
  disk.data = {}
  crypto.available = true
  crypto.failDecrypt = false
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.stubEnv('CHUNK_SECONDS', '')
  vi.stubEnv('OPENAI_API_KEY', '')
})

describe('длина чанка', () => {
  it('по умолчанию 6 с', () => {
    expect(new SettingsStore().get().chunkSeconds).toBe(6)
  })

  it('берёт CHUNK_SECONDS и не записывает его в файл', () => {
    vi.stubEnv('CHUNK_SECONDS', '9')
    expect(new SettingsStore().get().chunkSeconds).toBe(9)
    expect(disk.data).not.toHaveProperty('chunkSeconds')
  })

  it('читает CHUNK_SECONDS на каждый вызов, а не при импорте модуля', () => {
    const store = new SettingsStore()
    vi.stubEnv('CHUNK_SECONDS', '11')
    expect(store.get().chunkSeconds).toBe(11)
  })

  it('«Сохранить» с нетронутым ползунком не перекрывает .env', () => {
    vi.stubEnv('CHUNK_SECONDS', '9')
    const store = new SettingsStore()
    store.set({ ...store.get(), role: 'Frontend' })

    expect(disk.data).not.toHaveProperty('chunkSeconds')
    vi.stubEnv('CHUNK_SECONDS', '10')
    expect(store.get().chunkSeconds).toBe(10)
  })

  it('сдвинутый в UI ползунок важнее .env', () => {
    vi.stubEnv('CHUNK_SECONDS', '9')
    const store = new SettingsStore()
    store.set({ chunkSeconds: 12 })
    vi.stubEnv('CHUNK_SECONDS', '4')
    expect(store.get().chunkSeconds).toBe(12)
  })

  it.each([
    ['100', 20],
    ['1', 3],
    ['7.6', 8],
    ['abc', 6]
  ])('CHUNK_SECONDS=%s ограничивается до %i', (env, expected) => {
    vi.stubEnv('CHUNK_SECONDS', env)
    expect(new SettingsStore().get().chunkSeconds).toBe(expected)
  })
})

describe('миграция v1 → v2', () => {
  it('записанная по умолчанию шестёрка уступает .env, остальное не трогаем', () => {
    disk.data = { chunkSeconds: 6, role: 'Data Engineer' }
    vi.stubEnv('CHUNK_SECONDS', '9')

    const settings = new SettingsStore().get()

    expect(settings.chunkSeconds).toBe(9)
    expect(settings.role).toBe('Data Engineer')
    expect(disk.data.settingsVersion).toBe(2)
  })

  it('выбранное в UI значение, отличное от 6, сохраняется', () => {
    disk.data = { chunkSeconds: 10 }
    vi.stubEnv('CHUNK_SECONDS', '9')
    expect(new SettingsStore().get().chunkSeconds).toBe(10)
  })

  it('выполняется один раз: шестёрка, выбранная после миграции, остаётся', () => {
    disk.data = { chunkSeconds: 6, settingsVersion: 2 }
    vi.stubEnv('CHUNK_SECONDS', '9')
    expect(new SettingsStore().get().chunkSeconds).toBe(6)
  })
})

describe('прочие поля', () => {
  it('порог тишины ограничивается диапазоном 0–0.2', () => {
    const store = new SettingsStore()
    store.set({ vadThreshold: 5 })
    expect(store.get().vadThreshold).toBe(0.2)
    store.set({ vadThreshold: -1 })
    expect(store.get().vadThreshold).toBe(0)
  })

  it('get() не отдаёт ключ и служебные поля в рендерер', () => {
    const store = new SettingsStore()
    store.set({ apiKey: 'sk-secret' })
    const settings = store.get() as Record<string, unknown>

    expect(settings).not.toHaveProperty('apiKey')
    expect(settings).not.toHaveProperty('apiKeyEncrypted')
    expect(settings).not.toHaveProperty('settingsVersion')
    expect(settings.hasApiKey).toBe(true)
  })
})

describe('ключ OpenAI', () => {
  it('хранится зашифрованным и читается обратно', () => {
    const store = new SettingsStore()
    store.set({ apiKey: '  sk-secret  ' })

    expect(disk.data.apiKeyEncrypted).toBe(true)
    expect(disk.data.apiKey).not.toContain('sk-secret')
    expect(store.getApiKey()).toBe('sk-secret')
  })

  it('без safeStorage хранится как есть', () => {
    crypto.available = false
    const store = new SettingsStore()
    store.set({ apiKey: 'sk-plain' })

    expect(disk.data).toMatchObject({ apiKey: 'sk-plain', apiKeyEncrypted: false })
    expect(store.getApiKey()).toBe('sk-plain')
  })

  it('пустая строка из UI не стирает сохранённый ключ', () => {
    const store = new SettingsStore()
    store.set({ apiKey: 'sk-secret' })
    store.set({ apiKey: '', role: 'QA' })
    expect(store.getApiKey()).toBe('sk-secret')
  })

  it('без сохранённого ключа берёт OPENAI_API_KEY', () => {
    vi.stubEnv('OPENAI_API_KEY', ' sk-env ')
    expect(new SettingsStore().getApiKey()).toBe('sk-env')
  })

  it('clearApiKey возвращает к ключу из .env', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-env')
    const store = new SettingsStore()
    store.set({ apiKey: 'sk-ui' })
    store.clearApiKey()
    expect(store.getApiKey()).toBe('sk-env')
  })

  it('если ключ не расшифровать, падает обратно на .env', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-env')
    const store = new SettingsStore()
    store.set({ apiKey: 'sk-ui' })
    crypto.failDecrypt = true
    expect(store.getApiKey()).toBe('sk-env')
  })
})

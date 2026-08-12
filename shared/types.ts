export type AppSettings = {
  role: string
  stack: string
  language: 'ru' | 'en' | 'auto'
  /** Длина аудио-чанка в секундах. */
  chunkSeconds: number
  /** Порог RMS: тише — чанк не уходит в Whisper. 0 отключает фильтр. */
  vadThreshold: number
  /** Свободные заметки/резюме — уходят в промпт как контекст. */
  notes: string
  /** Компактный режим: только вопрос и тезисы. */
  compact: boolean
  /** Ключ хранится отдельно; здесь только флаг для UI. */
  hasApiKey: boolean
}

export type Hint = {
  id: string
  question: string
  hints: string[]
  createdAt: number
}

export type CoachResult = {
  transcript: string
  question: string
  hints: string[]
  isQuestion: boolean
  /** Заполняется только когда есть тезисы. */
  id?: string
}

export type CoachError = { error: string }

export type ScreenPermissionInfo = {
  status: 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'
  electronAppPath: string
  hint: string
}

export type CaptureStatus = 'idle' | 'listening' | 'processing' | `error:${string}`

export const HOTKEYS = {
  toggleOverlay: 'Command+Shift+Space',
  toggleListening: 'Command+Shift+L',
  toggleCompact: 'Command+Shift+K'
} as const

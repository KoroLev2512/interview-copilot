import OpenAI, { toFile } from 'openai'
import { randomUUID } from 'crypto'
import type { CoachError, CoachResult } from '../../shared/types'
import { findNewQuestions, normalizeSentence } from './question'
import type { SettingsStore } from './settings'

/**
 * Whisper на тишине и шуме уверенно выдаёт заученные фразы из субтитров.
 * Такие чанки выбрасываем, иначе копилот отвечает на несуществующие вопросы.
 */
const HALLUCINATIONS = [
  'спасибо за просмотр',
  'подписывайтесь на канал',
  'продолжение следует',
  'редактор субтитров',
  'субтитры сделал',
  'корректор',
  'thanks for watching',
  'thank you for watching',
  'please subscribe',
  'subtitles by',
  'amara.org'
]

/** Сколько уже отправленных в GPT предложений помним, чтобы не спрашивать повторно. */
const ASKED_LIMIT = 50
/** Сколько последних чанков держим как контекст фразы. */
const CONTEXT_CHUNKS = 4

type VerboseTranscription = {
  text?: string
  segments?: { no_speech_prob?: number; text?: string }[]
}

export class CoachService {
  private client: OpenAI | null = null
  private clientKey = ''
  /** Последние распознанные чанки — фраза часто рвётся по границе. */
  private context: string[] = []
  /** Нормализованные вопросы, по которым GPT уже отвечал в этой сессии прослушивания. */
  private asked = new Set<string>()

  constructor(private settings: SettingsStore) {}

  /** Клиент пересоздаётся, когда пользователь меняет ключ в UI. */
  private getClient(): OpenAI | null {
    const apiKey = this.settings.getApiKey()
    if (!apiKey) {
      this.client = null
      this.clientKey = ''
      return null
    }
    if (!this.client || this.clientKey !== apiKey) {
      this.client = new OpenAI({
        apiKey,
        baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
        maxRetries: 1,
        timeout: 30_000
      })
      this.clientKey = apiKey
    }
    return this.client
  }

  private get models() {
    return {
      stt: process.env.STT_MODEL || 'whisper-1',
      coach: process.env.COACH_MODEL || 'gpt-4o-mini'
    }
  }

  hasKey(): boolean {
    return this.settings.getApiKey().length > 0
  }

  resetContext(): void {
    this.context = []
  }

  /** Новая сессия прослушивания: забываем и хвост, и отвеченные вопросы. */
  resetSession(): void {
    this.resetContext()
    this.asked.clear()
  }

  private markAsked(sentences: string[]): void {
    for (const s of sentences) {
      this.asked.delete(normalizeSentence(s))
      this.asked.add(normalizeSentence(s))
    }
    // Set хранит порядок вставки — выкидываем самые старые.
    for (const old of this.asked) {
      if (this.asked.size <= ASKED_LIMIT) break
      this.asked.delete(old)
    }
  }

  async suggestFromAudio(buffer: Buffer, mimeType: string): Promise<CoachResult | CoachError> {
    const client = this.getClient()
    if (!client) return { error: 'Добавьте ключ OpenAI в «Профиль»' }

    const ext = mimeType.includes('webm') ? 'webm' : mimeType.includes('mp4') ? 'mp4' : 'wav'
    const stt = this.models.stt

    let transcript = ''
    try {
      const file = await toFile(buffer, `chunk.${ext}`, { type: mimeType })
      const verbose = stt.includes('whisper')

      const transcription = (await client.audio.transcriptions.create({
        file,
        model: stt,
        // Хвост предыдущего чанка помогает дословно продолжить оборванную фразу.
        prompt: this.context.join(' ').slice(-220) || undefined,
        response_format: verbose ? 'verbose_json' : 'json'
      })) as VerboseTranscription

      if (verbose && isSilence(transcription)) {
        return { transcript: '', question: '', hints: [], isQuestion: false }
      }

      transcript = (transcription.text || '').trim()
    } catch (err) {
      return { error: describeError(err, 'распознавание') }
    }

    if (!transcript || isHallucination(transcript)) {
      return { transcript: '', question: '', hints: [], isQuestion: false }
    }

    this.context.push(transcript)
    if (this.context.length > CONTEXT_CHUNKS) this.context.shift()

    const tail = this.context.join(' ').trim()
    return this.buildHints(tail, transcript)
  }

  async suggestFromText(text: string): Promise<CoachResult | CoachError> {
    if (!this.getClient()) return { error: 'Добавьте ключ OpenAI в «Профиль»' }
    const transcript = text.trim()
    if (!transcript) return { transcript: '', question: '', hints: [], isQuestion: false }
    // Ручной ввод — уже готовый вопрос, детектор пропускаем.
    return this.buildHints(transcript, transcript, true)
  }

  /**
   * @param tail склеенный контекст последних чанков — по нему ищем вопрос
   * @param visible что показать в «Услышано»
   * @param force пропустить детектор вопроса (ручной ввод)
   */
  private async buildHints(
    tail: string,
    visible: string,
    force = false
  ): Promise<CoachResult | CoachError> {
    // Хвост держит до 4 чанков: без учёта «уже спрашивали» один и тот же вопрос
    // уходил бы в GPT на каждом следующем чанке, пока GPT не вернёт тезисы.
    const newQuestions = force ? [] : findNewQuestions(tail, this.asked)

    if (!force && !newQuestions.length) {
      return { transcript: visible, question: '', hints: [], isQuestion: false }
    }

    const { role, stack, language, notes } = this.settings.get()

    const langHint =
      language === 'auto'
        ? 'Reply in the same language as the question.'
        : language === 'ru'
          ? 'Reply in Russian.'
          : 'Reply in English.'

    const notesHint = notes.trim()
      ? `\nCandidate background — use it to keep bullets personal and concrete:\n${notes.trim().slice(0, 2000)}`
      : ''

    let raw = '{}'
    try {
      const completion = await this.getClient()!.chat.completions.create({
        model: this.models.coach,
        temperature: 0.3,
        messages: [
          {
            role: 'system',
            content: `You help someone practice technical interviews. The transcript may be noisy or cut mid-sentence — infer the most likely question. Target role: ${role}. Stack focus: ${stack}. ${langHint} Return JSON only: {"question":"...","hints":["bullet1","bullet2","bullet3"]} with 3-5 short bullets, one sentence each, concrete over generic. If the transcript holds no answerable technical question, return {"question":"","hints":[]}.${notesHint}`
          },
          {
            role: 'user',
            content: `Heard on the call:\n${tail}`
          }
        ],
        response_format: { type: 'json_object' }
      })
      raw = completion.choices[0]?.message?.content || '{}'
      // Отмечаем только после ответа: при сетевой ошибке вопрос стоит переспросить.
      this.markAsked(newQuestions)
    } catch (err) {
      return { error: describeError(err, 'подсказки') }
    }

    let parsed: { question?: string; hints?: string[] } = {}
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = { question: tail, hints: [raw] }
    }

    const hints = (parsed.hints || []).filter(
      (h): h is string => typeof h === 'string' && h.trim().length > 0
    )

    if (!hints.length) {
      return { transcript: visible, question: '', hints: [], isQuestion: false }
    }

    // Вопрос закрыт — обнуляем контекст, иначе следующий чанк переспросит то же самое.
    this.resetContext()

    return {
      transcript: visible,
      question: (parsed.question || tail).trim(),
      hints,
      isQuestion: true,
      id: randomUUID()
    }
  }
}

function isSilence(transcription: VerboseTranscription): boolean {
  const segments = transcription.segments
  if (!segments?.length) return false
  return segments.every((s) => (s.no_speech_prob ?? 0) >= 0.6)
}

function isHallucination(text: string): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim()
  if (normalized.length < 4) return true
  // Мусор ловим только в короткой реплике: в длинной фразе это может быть по делу.
  return normalized.length < 90 && HALLUCINATIONS.some((phrase) => normalized.includes(phrase))
}

function describeError(err: unknown, stage: string): string {
  if (err instanceof OpenAI.APIError) {
    if (err.status === 401) return 'OpenAI отклонил ключ (401). Проверьте ключ в «Профиль».'
    if (err.status === 429) return 'Лимит OpenAI исчерпан (429). Проверьте баланс или подождите.'
    return `Ошибка OpenAI (${stage}, ${err.status ?? '—'}): ${err.message}`
  }
  if (err instanceof Error) return `Сбой (${stage}): ${err.message}`
  return `Неизвестный сбой (${stage}).`
}

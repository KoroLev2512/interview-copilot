import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../../shared/types'
import { CoachService, isHallucination, isSilence } from './coach'
import type { SettingsStore } from './settings'

const { transcribe, complete } = vi.hoisted(() => ({
  transcribe: vi.fn(),
  complete: vi.fn()
}))

vi.mock('openai', () => {
  class APIError extends Error {
    constructor(
      public status: number,
      message: string
    ) {
      super(message)
    }
  }
  class OpenAI {
    static APIError = APIError
    audio = { transcriptions: { create: transcribe } }
    chat = { completions: { create: complete } }
  }
  return { default: OpenAI, toFile: vi.fn(async () => ({})) }
})

const { default: OpenAI } = await import('openai')
const APIError = OpenAI.APIError as unknown as new (status: number, message: string) => Error

const baseSettings: AppSettings = {
  role: 'Backend',
  stack: 'Node.js',
  language: 'auto',
  chunkSeconds: 6,
  vadThreshold: 0.012,
  notes: '',
  captureMic: false,
  compact: false,
  hasApiKey: true
}

function makeCoach(opts: { apiKey?: string; settings?: Partial<AppSettings> } = {}) {
  const settings = {
    getApiKey: () => opts.apiKey ?? 'sk-test',
    get: () => ({ ...baseSettings, ...opts.settings })
  } as unknown as SettingsStore
  return new CoachService(settings)
}

/** Ответ Whisper в verbose_json: речь есть. */
function heard(text: string) {
  transcribe.mockResolvedValueOnce({ text, segments: [{ no_speech_prob: 0.05, text }] })
}

function gptReplies(payload: unknown) {
  complete.mockResolvedValueOnce({
    choices: [{ message: { content: typeof payload === 'string' ? payload : JSON.stringify(payload) } }]
  })
}

const audio = () => Buffer.from('fake-audio')
const MIME = 'audio/webm;codecs=opus'

beforeEach(() => {
  transcribe.mockReset()
  complete.mockReset()
})

describe('isSilence', () => {
  it('тишина, если все сегменты с высокой no_speech_prob', () => {
    expect(isSilence({ segments: [{ no_speech_prob: 0.9 }, { no_speech_prob: 0.6 }] })).toBe(true)
  })

  it('не тишина, если хоть один сегмент с речью', () => {
    expect(isSilence({ segments: [{ no_speech_prob: 0.9 }, { no_speech_prob: 0.1 }] })).toBe(false)
  })

  it('без сегментов решить нельзя — не тишина', () => {
    expect(isSilence({ text: 'abc' })).toBe(false)
  })
})

describe('isHallucination', () => {
  it.each(['Спасибо за просмотр!', 'Субтитры сделал DimaTorzok', 'Thanks for watching.', 'ok'])(
    'мусор: %s',
    (text) => {
      expect(isHallucination(text)).toBe(true)
    }
  )

  it('длинная фраза с тем же оборотом — по делу', () => {
    const text =
      'Мы добавили в плеер экран «спасибо за просмотр», и после этого конверсия в подписку выросла на треть'
    expect(isHallucination(text)).toBe(false)
  })

  it('обычная речь — не мусор', () => {
    expect(isHallucination('Расскажи про индексы в Postgres')).toBe(false)
  })
})

describe('CoachService.suggestFromAudio', () => {
  it('без ключа сразу просит ключ и не ходит в API', async () => {
    const result = await makeCoach({ apiKey: '' }).suggestFromAudio(audio(), MIME)
    expect(result).toEqual({ error: expect.stringContaining('ключ OpenAI') })
    expect(transcribe).not.toHaveBeenCalled()
  })

  it('тишину по no_speech_prob не отправляет в GPT', async () => {
    transcribe.mockResolvedValueOnce({ text: 'Продолжение следует', segments: [{ no_speech_prob: 0.95 }] })
    const result = await makeCoach().suggestFromAudio(audio(), MIME)
    expect(result).toMatchObject({ transcript: '', isQuestion: false })
    expect(complete).not.toHaveBeenCalled()
  })

  it('галлюцинацию Whisper не отправляет в GPT', async () => {
    heard('Спасибо за просмотр!')
    const result = await makeCoach().suggestFromAudio(audio(), MIME)
    expect(result).toMatchObject({ transcript: '', isQuestion: false })
    expect(complete).not.toHaveBeenCalled()
  })

  it('утверждение показывает в «Услышано», но GPT не зовёт', async () => {
    heard('Когда я пришёл в команду, мы переписали биллинг.')
    const result = await makeCoach().suggestFromAudio(audio(), MIME)
    expect(result).toEqual({
      transcript: 'Когда я пришёл в команду, мы переписали биллинг.',
      question: '',
      hints: [],
      isQuestion: false
    })
    expect(complete).not.toHaveBeenCalled()
  })

  it('на вопрос возвращает тезисы и сбрасывает контекст', async () => {
    const coach = makeCoach()
    heard('Расскажи, как работает event loop.')
    gptReplies({ question: 'Как работает event loop?', hints: ['Стек вызовов', ' ', 'Очередь задач'] })

    const result = await coach.suggestFromAudio(audio(), MIME)

    expect(result).toMatchObject({
      question: 'Как работает event loop?',
      hints: ['Стек вызовов', 'Очередь задач'],
      isQuestion: true,
      id: expect.any(String)
    })

    // Контекст сброшен: следующий чанк уходит в Whisper без подсказки-хвоста.
    heard('Хорошо.')
    await coach.suggestFromAudio(audio(), MIME)
    expect(transcribe.mock.calls[1][0].prompt).toBeUndefined()
  })

  it('передаёт в Whisper хвост прошлых чанков, чтобы склеить оборванную фразу', async () => {
    const coach = makeCoach()
    heard('Мы обсуждали кэширование')
    await coach.suggestFromAudio(audio(), MIME)
    heard('на уровне CDN.')
    await coach.suggestFromAudio(audio(), MIME)
    expect(transcribe.mock.calls[1][0].prompt).toBe('Мы обсуждали кэширование')
  })

  it('не спрашивает GPT повторно, если тот уже ответил «вопроса нет»', async () => {
    const coach = makeCoach()
    heard('Что такое замыкание в JavaScript?')
    gptReplies({ question: '', hints: [] })
    await coach.suggestFromAudio(audio(), MIME)

    // Вопрос остаётся в хвосте из 4 чанков, но второй раз в GPT не уходит.
    heard('Ну, там есть нюансы.')
    const result = await coach.suggestFromAudio(audio(), MIME)

    expect(complete).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ isQuestion: false })
  })

  it('после сетевой ошибки переспрашивает тот же вопрос', async () => {
    const coach = makeCoach()
    heard('Что такое замыкание в JavaScript?')
    complete.mockRejectedValueOnce(new Error('socket hang up'))
    const failed = await coach.suggestFromAudio(audio(), MIME)
    expect(failed).toEqual({ error: expect.stringContaining('socket hang up') })

    heard('Ну, там есть нюансы.')
    gptReplies({ question: 'Что такое замыкание?', hints: ['Функция + окружение'] })
    const retried = await coach.suggestFromAudio(audio(), MIME)

    expect(complete).toHaveBeenCalledTimes(2)
    expect(retried).toMatchObject({ isQuestion: true })
  })

  it('resetSession забывает отвеченные вопросы', async () => {
    const coach = makeCoach()
    heard('Что такое замыкание в JavaScript?')
    gptReplies({ question: '', hints: [] })
    await coach.suggestFromAudio(audio(), MIME)

    coach.resetSession()
    heard('Что такое замыкание в JavaScript?')
    gptReplies({ question: '', hints: [] })
    await coach.suggestFromAudio(audio(), MIME)

    expect(complete).toHaveBeenCalledTimes(2)
  })

  it('понятно объясняет 401 и 429', async () => {
    const coach = makeCoach()
    transcribe.mockRejectedValueOnce(new APIError(401, 'bad key'))
    expect(await coach.suggestFromAudio(audio(), MIME)).toEqual({
      error: expect.stringContaining('401')
    })
    transcribe.mockRejectedValueOnce(new APIError(429, 'quota'))
    expect(await coach.suggestFromAudio(audio(), MIME)).toEqual({
      error: expect.stringContaining('Лимит')
    })
  })
})

describe('CoachService.suggestFromText', () => {
  it('ручной ввод идёт в GPT даже без признаков вопроса', async () => {
    gptReplies({ question: 'Про биллинг', hints: ['Тезис'] })
    const result = await makeCoach().suggestFromText('биллинг и идемпотентность')
    expect(complete).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ isQuestion: true, hints: ['Тезис'] })
  })

  it('пустой ввод не тратит запрос', async () => {
    const result = await makeCoach().suggestFromText('   ')
    expect(result).toMatchObject({ isQuestion: false, hints: [] })
    expect(complete).not.toHaveBeenCalled()
  })

  it('язык и заметки из профиля попадают в системный промпт', async () => {
    gptReplies({ question: 'q', hints: ['h'] })
    await makeCoach({ settings: { language: 'ru', notes: '5 лет Node.js' } }).suggestFromText(
      'Расскажи про себя'
    )
    const system = complete.mock.calls[0][0].messages[0].content as string
    expect(system).toContain('Reply in Russian.')
    expect(system).toContain('5 лет Node.js')
  })

  it('если GPT вернул не JSON, показывает ответ как один тезис', async () => {
    gptReplies('Просто текст без JSON')
    const result = await makeCoach().suggestFromText('Что такое CAP-теорема?')
    expect(result).toMatchObject({
      question: 'Что такое CAP-теорема?',
      hints: ['Просто текст без JSON'],
      isQuestion: true
    })
  })
})

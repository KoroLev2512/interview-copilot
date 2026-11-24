import { describe, expect, it } from 'vitest'
import {
  findNewQuestions,
  isQuestionSentence,
  normalizeSentence,
  splitSentences
} from './question'

describe('isQuestionSentence', () => {
  it.each([
    'Расскажи, как работает event loop в Node.js.',
    'Окей, хорошо, а объясни разницу между let и var',
    'Чем отличается процесс от потока',
    'В чём разница между REST и GraphQL',
    'В чем разница между REST и GraphQL',
    'Что такое замыкание в JavaScript',
    'Как бы ты спроектировал rate limiter',
    'Почему ты выбрал PostgreSQL, а не Mongo',
    'Что будет, если два запроса придут одновременно',
    'Как устроен индекс в Postgres',
    'Можешь привести пример из своего опыта',
    'И сколько там было запросов в секунду?',
    'So, can you walk me through your last project',
    'How would you scale this service',
    'What is the difference between a mutex and a semaphore',
    'Okay, tell me about your experience with Kubernetes.',
    'Why do we need idempotency keys'
  ])('вопрос: %s', (sentence) => {
    expect(isQuestionSentence(sentence)).toBe(true)
  })

  it.each([
    'Когда я пришёл в команду, мы переписали биллинг.',
    'Как работал у нас кэш, я уже не помню точно',
    'Это то, как мы делали деплой.',
    'When I joined, we had a monolith.',
    'How it worked was pretty simple.',
    'Что ж, давайте начнём.',
    'Я объяснял это команде на ретро.',
    'We compared three options last year.',
    'That is how we did it.',
    'Спасибо, отлично.'
  ])('не вопрос: %s', (sentence) => {
    expect(isQuestionSentence(sentence)).toBe(false)
  })

  it.each(['Да?', 'Слышно меня?', 'Okay?', 'Ну что?'])(
    'короткая реплика со знаком вопроса — не вопрос: %s',
    (sentence) => {
      expect(isQuestionSentence(sentence)).toBe(false)
    }
  )

  it('кириллица не ломает границы слов: «чемодан» не равен «чем»', () => {
    expect(isQuestionSentence('Чемодан я собрал ещё вчера вечером')).toBe(false)
  })
})

describe('splitSentences', () => {
  it('режет по концу предложения и выкидывает пустые куски', () => {
    expect(splitSentences('Привет. Как дела?  Отлично!   ')).toEqual([
      'Привет.',
      'Как дела?',
      'Отлично!'
    ])
  })

  it('не режет внутри предложения без пробела после точки', () => {
    expect(splitSentences('Версия Node.js 22 вышла.')).toEqual(['Версия Node.js 22 вышла.'])
  })
})

describe('normalizeSentence', () => {
  it('игнорирует регистр, пунктуацию и лишние пробелы', () => {
    expect(normalizeSentence('Расскажи,  как работает Event Loop?')).toBe(
      normalizeSentence('расскажи как работает event loop.')
    )
  })
})

describe('findNewQuestions', () => {
  it('возвращает только вопросительные предложения хвоста', () => {
    const tail = 'Мы обсудили проект. Расскажи, как работает event loop. Ну, там есть очереди.'
    expect(findNewQuestions(tail, new Set())).toEqual(['Расскажи, как работает event loop.'])
  })

  it('пропускает вопросы, которые уже отправляли', () => {
    const asked = new Set([normalizeSentence('Расскажи, как работает event loop')])
    const tail = 'Расскажи, как работает event loop. Ну, там есть очереди.'
    expect(findNewQuestions(tail, asked)).toEqual([])
  })

  it('находит новый вопрос рядом с уже отправленным', () => {
    const asked = new Set([normalizeSentence('Что такое замыкание?')])
    const tail = 'Что такое замыкание? А чем отличается let от var?'
    expect(findNewQuestions(tail, asked)).toEqual(['А чем отличается let от var?'])
  })
})

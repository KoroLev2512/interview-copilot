/**
 * Детектор вопроса в транскрипте созвона. Решает только «звать ли GPT»:
 * сам вопрос GPT формулирует по всему хвосту.
 *
 * Смотрим на начало каждого предложения, а не на слова где попало: «how», «когда»,
 * «как работал» постоянно встречаются в обычных утверждениях.
 */

/** Кириллица не входит в \b, поэтому границы слова — через Unicode-классы. */
const W_START = '(?<![\\p{L}\\p{N}])'
const W_END = '(?![\\p{L}\\p{N}])'

function words(list: string[]): RegExp {
  return new RegExp(`^${W_START}(?:${list.join('|')})${W_END}`, 'iu')
}

/** Слова-паразиты в начале фразы: «Окей, хорошо, а расскажи…». */
const FILLER = new RegExp(
  `^${W_START}(?:а|и|ну|так|окей|ок|хорошо|ладно|давай(?:те)?|слушай(?:те)?|вот|so|okay|ok|and|alright|right|now|well|cool|great|sure)${W_END}[\\s,.!:;—-]*`,
  'iu'
)

/** Сами по себе означают вопрос или просьбу ответить. */
const STRONG_START = words([
  // RU: просьбы и устойчивые вопросные обороты
  'расскажи(?:те)?',
  'объясни(?:те)?',
  'поясни(?:те)?',
  'опиши(?:те)?',
  'сравни(?:те)?',
  'приведи(?:те)?',
  'назови(?:те)?',
  'перечисли(?:те)?',
  'представь(?:те)?',
  'допустим',
  'что такое',
  'что будет,? если',
  'что произойд[её]т,? если',
  'в ч[её]м разница',
  'чем (?:отлича\\p{L}*|разнятся)',
  // Только настоящее время: «как работал у нас кэш» — это рассказ, а не вопрос.
  'как (?:работает|работают|устроен[аоы]?|реализован[аоы]?|реализуется|реализовать)',
  'зачем нуж\\p{L}*',
  'можешь',
  'можете',
  'могли бы',
  'мог бы',
  'приходилось ли',
  'был(?:о|а)? ли',
  'есть ли',
  // EN
  'tell me',
  'walk me through',
  'explain',
  'describe',
  'compare',
  'give me',
  'imagine',
  'suppose',
  "let's say",
  'can you',
  'could you',
  'would you',
  'will you',
  'have you',
  'do you',
  'did you',
  'are you',
  'is there',
  'are there',
  'what is',
  "what's",
  'what are',
  'what happens',
  'how does',
  'how do',
  'how would',
  'how is',
  'how are',
  'how can',
  'why does',
  'why do',
  'why is',
  'why would'
])

/** Вопросительные слова, которые часто начинают и утверждения: нужен второй сигнал. */
const WEAK_START = words([
  'что',
  'как(?:ой|ая|ое|ие|им|ую)?',
  'почему',
  'зачем',
  'когда',
  'где',
  'куда',
  'кто',
  'чем',
  'сколько',
  'what',
  'how',
  'why',
  'when',
  'where',
  'who',
  'which'
])

/** Обращение к собеседнику или условность — вместе со слабым словом это уже вопрос. */
const ADDRESSEE = new RegExp(
  `${W_START}(?:ты|вы|тебе|вам|твой|ваш\\p{L}*|бы|you|your|would|should)${W_END}`,
  'iu'
)

/** Короче — это «Да?», «Слышно?», а не технический вопрос. */
const MIN_CHARS = 12
const MIN_WORDS = 3

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+/u)
    .map((s) => s.trim())
    .filter(Boolean)
}

function stripFillers(sentence: string): string {
  let s = sentence.trim()
  for (let prev = ''; prev !== s; ) {
    prev = s
    s = s.replace(FILLER, '').trim()
  }
  return s
}

export function isQuestionSentence(sentence: string): boolean {
  const s = stripFillers(sentence)
  if (s.length < MIN_CHARS || s.split(/\s+/u).length < MIN_WORDS) return false

  if (/\?\s*$/u.test(s)) return true
  if (STRONG_START.test(s)) return true
  return WEAK_START.test(s) && ADDRESSEE.test(s)
}

/** Нормализация для «уже спрашивали»: Whisper по-разному ставит регистр и пунктуацию. */
export function normalizeSentence(sentence: string): string {
  return sentence
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** Вопросительные предложения хвоста, которые ещё не отправляли в GPT. */
export function findNewQuestions(tail: string, asked: ReadonlySet<string>): string[] {
  return splitSentences(tail).filter(
    (s) => isQuestionSentence(s) && !asked.has(normalizeSentence(s))
  )
}

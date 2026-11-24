import { useCallback, useEffect, useState } from 'react'
import type {
  AppSettings,
  CaptureStatus,
  CoachResult,
  ScreenPermissionInfo
} from '../../../electron/preload/index'
import { HOTKEYS, type Hint } from '../../../shared/types'

type Status = 'idle' | 'listening' | 'processing' | 'error'

const MAX_HISTORY = 20

export default function App() {
  const [status, setStatus] = useState<Status>('idle')
  const [listening, setListening] = useState(false)
  const [screenPerm, setScreenPerm] = useState<ScreenPermissionInfo | null>(null)
  const [transcript, setTranscript] = useState('')
  const [history, setHistory] = useState<Hint[]>([])
  const [manual, setManual] = useState('')
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [draft, setDraft] = useState<AppSettings | null>(null)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [error, setError] = useState('')
  const [hotkeyWarning, setHotkeyWarning] = useState<string[]>([])
  const [copied, setCopied] = useState('')

  const pushHint = useCallback((data: CoachResult) => {
    if (!data.hints.length) return
    setHistory((prev) => {
      // Тот же вопрос мог прийти повторно из следующего чанка.
      if (prev[0]?.question === data.question) return prev
      const entry: Hint = {
        id: data.id || `${Date.now()}`,
        question: data.question,
        hints: data.hints,
        createdAt: Date.now()
      }
      return [entry, ...prev].slice(0, MAX_HISTORY)
    })
  }, [])

  useEffect(() => {
    void window.copilot.getSettings().then((s) => {
      setSettings(s)
      setDraft(s)
    })
    void window.copilot.getScreenPermission().then(setScreenPerm)

    const offStatus = window.copilot.onCaptureStatus((s: CaptureStatus) => {
      if (s.startsWith('error:')) {
        setStatus('error')
        setError(s.slice('error:'.length))
        return
      }
      setError('')
      setStatus(s as Status)
    })
    const offTx = window.copilot.onTranscript((data) => setTranscript(data.transcript))
    const offHint = window.copilot.onHint(pushHint)
    const offPerm = window.copilot.onScreenPermission(setScreenPerm)
    const offListening = window.copilot.onListeningState(setListening)
    const offSettings = window.copilot.onSettingsChanged((s) => {
      setSettings(s)
      setDraft((prev) => (prev ? { ...prev, compact: s.compact } : s))
    })
    const offHotkeys = window.copilot.onHotkeysFailed(setHotkeyWarning)

    return () => {
      offStatus()
      offTx()
      offHint()
      offPerm()
      offListening()
      offSettings()
      offHotkeys()
    }
  }, [pushHint])

  const busy = status === 'processing'
  const compact = settings?.compact ?? false
  const needsKey = settings !== null && !settings.hasApiKey
  const needsScreen = screenPerm !== null && screenPerm.status !== 'granted'

  function toggleListen() {
    setError('')
    if (listening) window.copilot.stopListening()
    else window.copilot.startListening()
  }

  async function askManual() {
    const text = manual.trim()
    if (!text) return
    setStatus('processing')
    setError('')

    const result = await window.copilot.coachFromText(text)
    if ('error' in result) {
      setError(result.error)
      setStatus('error')
      return
    }

    setTranscript(result.transcript)
    pushHint(result)
    if (!result.hints.length) setError('В тексте не нашлось технического вопроса')
    else setManual('')
    setStatus(listening ? 'listening' : 'idle')
  }

  async function saveSettings() {
    if (!draft) return
    const next = await window.copilot.setSettings({ ...draft, apiKey: apiKeyInput })
    setSettings(next)
    setDraft(next)
    setApiKeyInput('')
    setShowSettings(false)
  }

  async function clearKey() {
    const next = await window.copilot.clearApiKey()
    setSettings(next)
    setDraft(next)
    setApiKeyInput('')
  }

  async function copyHints(entry: Hint) {
    await navigator.clipboard.writeText(entry.hints.map((h) => `• ${h}`).join('\n'))
    setCopied(entry.id)
    setTimeout(() => setCopied(''), 1200)
  }

  return (
    <div className={`panel ${compact ? 'compact' : ''}`}>
      <header className="titlebar">
        <h1>Interview Copilot</h1>
        <div className="titlebar-right">
          <span className={`badge ${listening ? 'live' : ''} ${status === 'error' ? 'bad' : ''}`}>
            {busy ? 'думаю…' : listening ? 'слушаю' : 'пауза'}
          </span>
          <button
            className="icon"
            title={`Скрыть (${HOTKEYS.toggleOverlay})`}
            onClick={() => window.copilot.hideOverlay()}
          >
            —
          </button>
          <button className="icon" title="Выйти" onClick={() => window.copilot.quit()}>
            ✕
          </button>
        </div>
      </header>

      <div className="content">
        {needsKey && (
          <div className="section perm">
            <p className="warn">Нет ключа OpenAI — подсказки не заработают.</p>
            <p className="muted small">Вставьте ключ в «Профиль» или положите его в .env.</p>
            <button className="primary" onClick={() => setShowSettings(true)}>
              Открыть профиль
            </button>
          </div>
        )}

        {needsScreen && (
          <div className="section perm">
            <p className="warn">
              {screenPerm?.hint || 'Нужен доступ к записи экрана и системного звука.'}
            </p>
            <p className="muted small">
              В настройках: Screen &amp; System Audio Recording → включите <strong>Electron</strong>{' '}
              или добавьте вручную через «+»:
            </p>
            <p className="mono small">{screenPerm?.electronAppPath}</p>
            <div className="controls">
              <button
                className="primary"
                onClick={async () => {
                  const info = await window.copilot.requestScreenPermission()
                  setScreenPerm(info)
                  if (info.status !== 'granted') await window.copilot.showPermissionHelp()
                }}
              >
                Запросить доступ
              </button>
              <button onClick={() => window.copilot.openScreenSettings()}>Настройки macOS</button>
            </div>
          </div>
        )}

        <div className="controls">
          <button className="primary" onClick={toggleListen}>
            {listening ? 'Стоп' : 'Слушать созвон'}
          </button>
          <button onClick={() => setShowSettings((v) => !v)}>Профиль</button>
          {history.length > 0 && <button onClick={() => setHistory([])}>Очистить</button>}
        </div>

        {error && <p className="warn">{error}</p>}

        {hotkeyWarning.length > 0 && (
          <p className="muted small">
            Хоткеи заняты другим приложением: {hotkeyWarning.join(', ')}
          </p>
        )}

        {showSettings && draft && (
          <div className="section settings">
            <h2>Профиль для подсказок</h2>

            <label>Ключ OpenAI</label>
            <input
              type="password"
              placeholder={settings?.hasApiKey ? '•••••••• сохранён' : 'sk-...'}
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
            />
            {settings?.hasApiKey && (
              <button className="link" onClick={clearKey}>
                Удалить сохранённый ключ
              </button>
            )}

            <label>Роль</label>
            <input
              value={draft.role}
              onChange={(e) => setDraft({ ...draft, role: e.target.value })}
            />

            <label>Стек</label>
            <input
              value={draft.stack}
              onChange={(e) => setDraft({ ...draft, stack: e.target.value })}
            />

            <label>Опыт и заметки (уходят в промпт)</label>
            <textarea
              className="notes"
              placeholder="5 лет Node.js, вёл миграцию на Postgres 15, писал свой rate limiter…"
              value={draft.notes}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            />

            <label>Язык ответов</label>
            <select
              value={draft.language}
              onChange={(e) =>
                setDraft({ ...draft, language: e.target.value as AppSettings['language'] })
              }
            >
              <option value="auto">Как в вопросе</option>
              <option value="ru">Русский</option>
              <option value="en">English</option>
            </select>

            <label>Длина чанка: {draft.chunkSeconds} с</label>
            <input
              type="range"
              min={3}
              max={20}
              step={1}
              value={draft.chunkSeconds}
              onChange={(e) => setDraft({ ...draft, chunkSeconds: Number(e.target.value) })}
            />

            <label>
              Порог тишины: {draft.vadThreshold === 0 ? 'выключен' : draft.vadThreshold.toFixed(3)}
            </label>
            <input
              type="range"
              min={0}
              max={0.05}
              step={0.002}
              value={draft.vadThreshold}
              onChange={(e) => setDraft({ ...draft, vadThreshold: Number(e.target.value) })}
            />
            <p className="muted small">
              Чанки тише порога не уходят в Whisper — тишина не тратит деньги.
            </p>

            <label className="check">
              <input
                type="checkbox"
                checked={draft.captureMic}
                onChange={(e) => setDraft({ ...draft, captureMic: e.target.checked })}
              />
              Записывать и мой микрофон
            </label>
            <p className="muted small">
              Ваша речь тоже попадёт в распознавание. Применяется со следующего старта
              прослушивания.
            </p>

            <div className="controls">
              <button className="primary" onClick={saveSettings}>
                Сохранить
              </button>
              <button onClick={() => setShowSettings(false)}>Отмена</button>
            </div>

            <p className="muted small hotkeys">
              {HOTKEYS.toggleOverlay} — скрыть/показать · {HOTKEYS.toggleListening} — старт/стоп ·{' '}
              {HOTKEYS.toggleCompact} — компактный режим
            </p>
          </div>
        )}

        {!compact && (
          <>
            <div className="section">
              <h2>Ручной вопрос</h2>
              <textarea
                className="manual"
                placeholder="Вставьте вопрос с созвона, если аудио не сработало"
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void askManual()
                }}
              />
              <button onClick={askManual} disabled={busy}>
                Подсказать
              </button>
            </div>

            <div className="section">
              <h2>Услышано</h2>
              <p>
                {transcript || <span className="muted">Пока пусто — включите «Слушать созвон»</span>}
              </p>
            </div>
          </>
        )}

        {history.map((entry) => (
          <div className="section hints" key={entry.id}>
            <div className="hints-head">
              <h2>Вопрос</h2>
              <button className="link" onClick={() => copyHints(entry)}>
                {copied === entry.id ? 'скопировано' : 'копировать'}
              </button>
            </div>
            <p>{entry.question}</p>
            <h2>Тезисы для ответа</h2>
            <ul>
              {entry.hints.map((h, i) => (
                <li key={`${entry.id}-${i}`}>{h}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  )
}

import { useEffect, useRef } from 'react'
import type { CoachResult } from '../../../electron/preload/index'

/** Скрытое окно: захватывает системный звук через getDisplayMedia (loopback на macOS). */
export default function CaptureWorker() {
  /** Сведённый поток, который пишет MediaRecorder. */
  const streamRef = useRef<MediaStream | null>(null)
  /** Исходные потоки — их треки надо глушить отдельно, иначе macOS держит индикатор записи. */
  const systemStreamRef = useRef<MediaStream | null>(null)
  const micStreamRef = useRef<MediaStream | null>(null)
  const runningRef = useRef(false)
  const audioCtxRef = useRef<AudioContext | null>(null)
  /** Пик RMS за текущий чанк — по нему решаем, отправлять ли его в Whisper. */
  const peakRef = useRef(0)
  const vadRef = useRef(0.012)
  /** Запросы к API идут по очереди, чтобы транскрипты не перемешались. */
  const queueRef = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    const offStart = window.copilot.onListeningStart(() => void start())
    const offStop = window.copilot.onListeningStop(() => stop())
    return () => {
      offStart()
      offStop()
      stop()
    }
  }, [])

  async function start() {
    if (runningRef.current) return
    runningRef.current = true
    window.copilot.emitCaptureStatus('listening')

    try {
      const settings = await window.copilot.getSettings()
      const chunkMs = Math.max(3, settings.chunkSeconds || 6) * 1000
      vadRef.current = settings.vadThreshold ?? 0.012

      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: 1, max: 1 },
          height: { ideal: 1, max: 1 },
          frameRate: { ideal: 1, max: 1 }
        },
        audio: true
      })

      stream.getVideoTracks().forEach((t) => {
        t.stop()
        stream.removeTrack(t)
      })

      const audioTrack = stream.getAudioTracks()[0]
      if (!audioTrack) {
        throw new Error(
          'Системный звук не захвачен. Выдайте доступ «Screen & System Audio Recording» для Electron и перезапустите приложение.'
        )
      }

      // Пользователь может оборвать стрим из системной плашки — не крутим пустую запись.
      audioTrack.addEventListener('ended', () => stop())
      systemStreamRef.current = stream

      const mic = settings.captureMic ? await openMic() : null
      // Стоп мог прийти, пока висел системный диалог доступа к микрофону.
      if (!runningRef.current) {
        mic?.getTracks().forEach((t) => t.stop())
        return
      }
      micStreamRef.current = mic

      streamRef.current = await mixAndMeter(mic ? [stream, mic] : [stream])

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm'

      recordChunk(mimeType, chunkMs)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Глушим уже открытые потоки, иначе индикатор записи macOS так и висит.
      stop()
      window.copilot.emitCaptureStatus(`error:${msg}`)
    }
  }

  /** Микрофон опционален: если не дали доступ, продолжаем на одном системном звуке. */
  async function openMic(): Promise<MediaStream | null> {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      window.copilot.emitCaptureStatus(
        `error:Микрофон недоступен (${msg}) — слушаю только звук созвона. Проверьте доступ к микрофону в настройках macOS.`
      )
      return null
    }
  }

  /**
   * Сводит все источники в один поток для MediaRecorder и заодно мониторит громкость:
   * без этого Whisper вызывается и на полной тишине.
   */
  async function mixAndMeter(streams: MediaStream[]): Promise<MediaStream> {
    const ctx = new AudioContext()
    audioCtxRef.current = ctx
    // Скрытое окно без пользовательского жеста — контекст может стартовать в suspended.
    if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined)

    const destination = ctx.createMediaStreamDestination()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 2048

    for (const s of streams) {
      const source = ctx.createMediaStreamSource(s)
      source.connect(destination)
      source.connect(analyser)
    }

    const buffer = new Float32Array(analyser.fftSize)
    const tick = () => {
      if (!runningRef.current) return
      analyser.getFloatTimeDomainData(buffer)
      let sum = 0
      for (let i = 0; i < buffer.length; i += 1) sum += buffer[i] * buffer[i]
      const rms = Math.sqrt(sum / buffer.length)
      if (rms > peakRef.current) peakRef.current = rms
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)

    return destination.stream
  }

  function recordChunk(mimeType: string, chunkMs: number) {
    if (!runningRef.current || !streamRef.current) return

    const recorder = new MediaRecorder(streamRef.current, { mimeType })
    const chunks: Blob[] = []
    peakRef.current = 0

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }

    recorder.onerror = () => {
      window.copilot.emitCaptureStatus('error:MediaRecorder упал — перезапустите запись')
      stop()
    }

    recorder.onstop = () => {
      if (!runningRef.current) return

      const peak = peakRef.current
      const blob = new Blob(chunks, { type: mimeType })

      // Следующий чанк пишем сразу: раньше запись стояла всё время запроса к API.
      recordChunk(mimeType, chunkMs)

      const loudEnough = vadRef.current === 0 || peak >= vadRef.current
      const bigEnough = blob.size > 2000

      // Видно в devtools capture-окна при COPILOT_DEBUG=1.
      console.debug(
        `[chunk] ${blob.size} B, пик RMS ${peak.toFixed(4)} / порог ${vadRef.current}` +
          ` → ${bigEnough && loudEnough ? 'в Whisper' : 'пропущен'}`
      )

      if (bigEnough && loudEnough) {
        queueRef.current = queueRef.current.then(() => processBlob(blob, mimeType))
      }
    }

    recorder.start()
    setTimeout(() => {
      if (recorder.state === 'recording') recorder.stop()
    }, chunkMs)
  }

  function stop() {
    if (!runningRef.current) return
    runningRef.current = false
    for (const ref of [streamRef, systemStreamRef, micStreamRef]) {
      ref.current?.getTracks().forEach((t) => t.stop())
      ref.current = null
    }
    void audioCtxRef.current?.close().catch(() => undefined)
    audioCtxRef.current = null
    peakRef.current = 0
    window.copilot.emitCaptureStatus('idle')
  }

  async function processBlob(blob: Blob, mimeType: string) {
    if (!runningRef.current) return
    window.copilot.emitCaptureStatus('processing')

    try {
      const buffer = await blob.arrayBuffer()
      const base64 = arrayBufferToBase64(buffer)
      const result = await window.copilot.coachFromAudio({ base64, mimeType })

      if (!runningRef.current) return

      if ('error' in result) {
        window.copilot.emitCaptureStatus(`error:${result.error}`)
        return
      }

      emitResult(result)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      window.copilot.emitCaptureStatus(`error:${msg}`)
      return
    }

    if (runningRef.current) window.copilot.emitCaptureStatus('listening')
  }

  function emitResult(result: CoachResult) {
    if (result.transcript) window.copilot.emitTranscript(result)
    if (result.isQuestion && result.hints.length) window.copilot.emitHint(result)
  }

  return null
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + step)))
  }
  return btoa(binary)
}

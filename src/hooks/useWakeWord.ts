import { useCallback, useEffect, useRef, useState } from 'react'
import { VOICE_LOCALE } from '../i18n/strings'

interface SpeechRecognitionAlternative {
  readonly transcript: string
  readonly confidence: number
}
interface SpeechRecognitionResult {
  readonly length: number
  item(index: number): SpeechRecognitionAlternative
  [index: number]: SpeechRecognitionAlternative
}
interface SpeechRecognitionResultList {
  readonly length: number
  item(index: number): SpeechRecognitionResult
  [index: number]: SpeechRecognitionResult
}
interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number
  readonly results: SpeechRecognitionResultList
}
interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string
}
declare class SpeechRecognition extends EventTarget {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  onresult: ((event: SpeechRecognitionEvent) => void) | null
  onend: ((event: Event) => void) | null
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null
  start(): void
  stop(): void
  abort(): void
}
declare global {
  interface Window {
    SpeechRecognition?: typeof SpeechRecognition
    webkitSpeechRecognition?: typeof SpeechRecognition
  }
}

const normalize = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

export function useWakeWord(keyword: string, onDetected: () => void) {
  const [active, setActive]     = useState(false)
  const [enabled, setEnabled]   = useState(false)
  const recRef                  = useRef<InstanceType<typeof SpeechRecognition> | null>(null)
  const onDetectedRef           = useRef(onDetected)
  const keywordNorm             = normalize(keyword)

  useEffect(() => { onDetectedRef.current = onDetected }, [onDetected])

  const stop = useCallback(() => {
    recRef.current?.abort()
    recRef.current = null
    setActive(false)
  }, [])

  const start = useCallback(() => {
    const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition
    if (!SR) return

    const rec = new SR()
    rec.lang           = VOICE_LOCALE
    rec.continuous     = true
    rec.interimResults = true
    rec.maxAlternatives = 1

    rec.onresult = (event: SpeechRecognitionEvent) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = normalize(event.results[i][0].transcript)
        if (t.includes(keywordNorm)) {
          onDetectedRef.current()
          return
        }
      }
    }

    rec.onend = () => {
      // Auto-restart so it stays alive
      if (recRef.current === rec) {
        setTimeout(start, 300)
      }
    }

    rec.onerror = (e: SpeechRecognitionErrorEvent) => {
      if (e.error === 'aborted') return
      if (recRef.current === rec) setTimeout(start, 1000)
    }

    recRef.current = rec
    try { rec.start(); setActive(true) } catch { setActive(false) }
  }, [keywordNorm, stop])

  // Start/stop based on `enabled`
  useEffect(() => {
    if (enabled) start()
    else stop()
    return stop
  }, [enabled, start, stop])

  return { wakeWordActive: active, enableWakeWord: setEnabled }
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { VOICE_LOCALE } from '../i18n/strings'

interface SpeechRecognitionAlternative { readonly transcript: string; readonly confidence: number }
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
interface SpeechRecognitionErrorEvent extends Event { readonly error: string }
declare class SpeechRecognition extends EventTarget {
  lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number
  onresult: ((event: SpeechRecognitionEvent) => void) | null
  onend: ((event: Event) => void) | null
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null
  start(): void; stop(): void; abort(): void
}
declare global {
  interface Window {
    SpeechRecognition?: typeof SpeechRecognition
    webkitSpeechRecognition?: typeof SpeechRecognition
  }
}

const OPENAI_TTS_URL = 'https://api.openai.com/v1/audio/speech'
const OPENAI_API_KEY = import.meta.env.VITE_OPENAI_API_KEY as string | undefined

export function useVoice(onFinalTranscript: (text: string) => void) {
  const [isListening, setIsListening] = useState(false)
  const [isSpeaking, setIsSpeaking]   = useState(false)

  const recognitionRef = useRef<InstanceType<typeof SpeechRecognition> | null>(null)
  const audioRef       = useRef<HTMLAudioElement | null>(null)
  const onFinalRef     = useRef(onFinalTranscript)

  useEffect(() => { onFinalRef.current = onFinalTranscript }, [onFinalTranscript])

  const startListening = useCallback(() => {
    const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition
    if (!SR) return

    const rec = new SR()
    rec.lang           = VOICE_LOCALE
    rec.interimResults = false
    rec.maxAlternatives = 1
    rec.continuous     = false

    rec.onresult = (event: SpeechRecognitionEvent) => {
      const text = event.results[event.resultIndex][0].transcript.trim()
      if (text) onFinalRef.current(text)
    }

    rec.onend   = () => setIsListening(false)
    rec.onerror = (e: SpeechRecognitionErrorEvent) => {
      if (e.error !== 'no-speech' && e.error !== 'aborted') console.warn('STT:', e.error)
      setIsListening(false)
    }

    recognitionRef.current = rec
    try { rec.start(); setIsListening(true) } catch { setIsListening(false) }
  }, [])

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop()
    setIsListening(false)
  }, [])

  const speak = useCallback(async (text: string, onEnd?: () => void) => {
    if (!OPENAI_API_KEY) {
      console.warn('VITE_OPENAI_API_KEY no configurada')
      onEnd?.()
      return
    }

    try {
      audioRef.current?.pause()
      const res = await fetch(OPENAI_TTS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'tts-1-hd',
          input: text,
          voice: 'nova',
          response_format: 'opus',
        }),
      })

      if (!res.ok) throw new Error(`TTS ${res.status}`)

      const blob  = await res.blob()
      const url   = URL.createObjectURL(blob)
      const audio = new Audio(url)
      audioRef.current = audio

      setIsSpeaking(true)
      audio.onended = () => { setIsSpeaking(false); URL.revokeObjectURL(url); onEnd?.() }
      audio.onerror = () => { setIsSpeaking(false); URL.revokeObjectURL(url); onEnd?.() }
      audio.play()
    } catch (err) {
      console.warn('TTS error:', err)
      setIsSpeaking(false)
      onEnd?.()
    }
  }, [])

  const cancelSpeech = useCallback(() => {
    audioRef.current?.pause()
    setIsSpeaking(false)
  }, [])

  return { isListening, isSpeaking, startListening, stopListening, speak, cancelSpeech }
}

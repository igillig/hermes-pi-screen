import { useCallback, useEffect, useRef, useState } from 'react'
import { VOICE_LOCALE } from '../i18n/strings'

interface SpeechRecognitionResult {
  readonly length: number
  item(index: number): SpeechRecognitionAlternative
  [index: number]: SpeechRecognitionAlternative
}
interface SpeechRecognitionAlternative {
  readonly transcript: string
  readonly confidence: number
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

export function useVoice(onFinalTranscript: (text: string) => void) {
  const [isListening, setIsListening]     = useState(false)
  const [isSpeaking, setIsSpeaking]       = useState(false)
  const [isSupported, setIsSupported]     = useState(false)
  const [interimText, setInterimText]     = useState('')

  const recognitionRef  = useRef<InstanceType<typeof SpeechRecognition> | null>(null)
  const onFinalRef      = useRef(onFinalTranscript)
  const synthRef        = useRef(window.speechSynthesis)

  useEffect(() => { onFinalRef.current = onFinalTranscript }, [onFinalTranscript])
  useEffect(() => { setIsSupported(!!(window.SpeechRecognition || window.webkitSpeechRecognition)) }, [])

  const startListening = useCallback(() => {
    const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition
    if (!SR) return

    // Don't interrupt ongoing TTS
    synthRef.current?.cancel()

    const rec = new SR()
    rec.lang            = VOICE_LOCALE
    rec.interimResults  = true
    rec.maxAlternatives = 1
    rec.continuous      = false

    rec.onresult = (event: SpeechRecognitionEvent) => {
      let interim = ''
      let final   = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript
        if ((event.results[i] as unknown as { isFinal: boolean }).isFinal) final += t
        else interim += t
      }
      setInterimText(interim)
      if (final.trim()) {
        setInterimText('')
        onFinalRef.current(final.trim())
      }
    }

    rec.onend  = () => { setIsListening(false); setInterimText('') }
    rec.onerror = (e: SpeechRecognitionErrorEvent) => {
      if (e.error !== 'no-speech' && e.error !== 'aborted') console.warn('STT error:', e.error)
      setIsListening(false)
      setInterimText('')
    }

    recognitionRef.current = rec
    try { rec.start(); setIsListening(true) } catch { setIsListening(false) }
  }, [])

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop()
    setIsListening(false)
    setInterimText('')
  }, [])

  const speak = useCallback((text: string, onEnd?: () => void) => {
    const synth = synthRef.current
    if (!synth) return
    synth.cancel()

    const utterance  = new SpeechSynthesisUtterance(text)
    utterance.lang   = VOICE_LOCALE
    utterance.rate   = 1.05
    utterance.pitch  = 0.85

    // Pick a voice that matches the configured locale if available.
    const langPrefix = VOICE_LOCALE.split('-')[0]
    const voices   = synth.getVoices()
    const preferred = voices.find(v => v.lang.startsWith(langPrefix) && v.name.toLowerCase().includes('male'))
                   ?? voices.find(v => v.lang.startsWith(langPrefix))
    if (preferred) utterance.voice = preferred

    utterance.onstart = () => setIsSpeaking(true)
    utterance.onend   = () => { setIsSpeaking(false); onEnd?.() }
    utterance.onerror = () => { setIsSpeaking(false); onEnd?.() }

    synth.speak(utterance)
  }, [])

  const cancelSpeech = useCallback(() => {
    synthRef.current?.cancel()
    setIsSpeaking(false)
  }, [])

  return { isListening, isSpeaking, isSupported, interimText, startListening, stopListening, speak, cancelSpeech }
}

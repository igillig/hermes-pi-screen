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

const OPENAI_API_KEY = import.meta.env.VITE_OPENAI_API_KEY as string | undefined
const OPENAI_STT_URL = 'https://api.openai.com/v1/audio/transcriptions'
const OPENAI_TTS_URL = 'https://api.openai.com/v1/audio/speech'

export function useVoice(onFinalTranscript: (text: string) => void) {
  const [isListening, setIsListening] = useState(false)
  const [isSpeaking, setIsSpeaking]   = useState(false)
  const [sttError, setSttError]       = useState('')

  const recorderRef  = useRef<MediaRecorder | null>(null)
  const chunksRef    = useRef<Blob[]>([])
  const audioRef     = useRef<HTMLAudioElement | null>(null)
  const onFinalRef   = useRef(onFinalTranscript)

  useEffect(() => { onFinalRef.current = onFinalTranscript }, [onFinalTranscript])

  const startListening = useCallback(async () => {
    setSttError('')
    try {
      const stream   = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream)
      chunksRef.current = []

      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }

      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        setIsListening(false)
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        try {
          const form = new FormData()
          form.append('file', blob, 'audio.webm')
          form.append('model', 'whisper-1')
          form.append('language', 'es')
          const res  = await fetch(OPENAI_STT_URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
            body: form,
          })
          const { text } = await res.json() as { text: string }
          if (text?.trim()) onFinalRef.current(text.trim())
        } catch (err) {
          setSttError('whisper-error')
          console.warn('STT error:', err)
        }
      }

      recorderRef.current = recorder
      recorder.start()
      setIsListening(true)
    } catch (err) {
      setSttError('mic-error')
      console.warn('Mic error:', err)
      setIsListening(false)
    }
  }, [])

  const stopListening = useCallback(() => {
    recorderRef.current?.stop()
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

  return { isListening, isSpeaking, sttError, startListening, stopListening, speak, cancelSpeech }
}

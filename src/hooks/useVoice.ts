import { useCallback, useEffect, useRef, useState } from 'react'

const AUDIO_BASE = '/audio'

export function useVoice(onFinalTranscript: (text: string) => void) {
  const [isListening, setIsListening] = useState(false)
  const [isSpeaking, setIsSpeaking]   = useState(false)

  const recorderRef  = useRef<MediaRecorder | null>(null)
  const chunksRef    = useRef<Blob[]>([])
  const audioRef     = useRef<HTMLAudioElement | null>(null)
  const onFinalRef   = useRef(onFinalTranscript)

  useEffect(() => { onFinalRef.current = onFinalTranscript }, [onFinalTranscript])

  const startListening = useCallback(async () => {
    try {
      const stream   = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream)
      chunksRef.current = []

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }

      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        setIsListening(false)

        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        try {
          const form = new FormData()
          form.append('audio', blob, 'recording.webm')
          const res  = await fetch(`${AUDIO_BASE}/transcribe`, { method: 'POST', body: form })
          const { text } = await res.json() as { text: string }
          if (text?.trim()) onFinalRef.current(text.trim())
        } catch (err) {
          console.warn('Transcription error:', err)
        }
      }

      recorderRef.current = recorder
      recorder.start()
      setIsListening(true)
    } catch (err) {
      console.warn('Mic error:', err)
      setIsListening(false)
    }
  }, [])

  const stopListening = useCallback(() => {
    recorderRef.current?.stop()
  }, [])

  const speak = useCallback(async (text: string, onEnd?: () => void) => {
    try {
      audioRef.current?.pause()
      const res  = await fetch(`${AUDIO_BASE}/speak`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text }),
      })
      if (!res.ok) throw new Error(`TTS error ${res.status}`)

      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const audio = new Audio(url)
      audioRef.current = audio

      setIsSpeaking(true)
      audio.onended = () => { setIsSpeaking(false); URL.revokeObjectURL(url); onEnd?.() }
      audio.onerror = () => { setIsSpeaking(false); URL.revokeObjectURL(url); onEnd?.() }
      audio.play()
    } catch (err) {
      console.warn('Speech error:', err)
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

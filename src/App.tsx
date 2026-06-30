import { useEffect, useRef, useState } from 'react'
import NeuralOrb, { type OrbState } from './components/NeuralOrb'
import { useHermesAPI } from './hooks/useHermesAPI'
import { useVoice } from './hooks/useVoice'
import { STRINGS } from './i18n/strings'

const STATE_LABEL: Record<OrbState, string> = {
  idle:      STRINGS.orbState.idle,
  listening: STRINGS.orbState.listening,
  thinking:  STRINGS.orbState.thinking,
  speaking:  STRINGS.orbState.speaking,
}

export default function App() {
  const { messages, isThinking, sendMessage, cancelStream } = useHermesAPI()
  const {
    isListening, isSpeaking,
    startListening, stopListening,
    speak, cancelSpeech,
  } = useVoice(sendMessage)

  const [time, setTime] = useState(() => new Date())
  useEffect(() => { const t = setInterval(() => setTime(new Date()), 1000); return () => clearInterval(t) }, [])

  const voiceLoop  = useRef(false)
  const lastSpoken = useRef<string | null>(null)

  // After Hermes responds → speak → re-listen if in voice loop
  useEffect(() => {
    const last = messages.at(-1)
    if (!last || last.role !== 'hermes' || last.pending) return
    if (last.id === lastSpoken.current) return
    lastSpoken.current = last.id

    speak(last.content, () => {
      if (voiceLoop.current) setTimeout(startListening, 400)
    })
  }, [messages, speak, startListening])

  const handleTap = () => {
    if (isListening) {
      voiceLoop.current = false
      stopListening()
    } else if (isSpeaking) {
      cancelSpeech()
      voiceLoop.current = true
      setTimeout(startListening, 200)
    } else if (isThinking) {
      cancelStream()
    } else {
      voiceLoop.current = true
      startListening()
    }
  }

  const orbState: OrbState = isListening ? 'listening'
                           : isThinking  ? 'thinking'
                           : isSpeaking  ? 'speaking'
                           : 'idle'

  const hh = time.getHours().toString().padStart(2, '0')
  const mm = time.getMinutes().toString().padStart(2, '0')

  return (
    <div className="app" onClick={handleTap}>
      <NeuralOrb state={orbState} />

      <div className="hud">
        <div className="hud-top">
          <span className="hud-title">{STRINGS.appTitle}</span>
          <span className="hud-clock">{hh}:{mm}</span>
        </div>

        <div className="hud-center" />

        <div className="hud-bottom">
          {orbState === 'idle'
            ? <span className="hud-hint">{STRINGS.hud.tapToSpeak}</span>
            : <span className={`hud-state ${orbState}`}>{STATE_LABEL[orbState]}</span>
          }
        </div>
      </div>
    </div>
  )
}

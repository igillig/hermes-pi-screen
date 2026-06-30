import { useEffect, useState } from 'react'
import { STRINGS } from '../i18n/strings'

type UIStatus = 'idle' | 'streaming' | 'error'

interface Props {
  status: UIStatus
  isThinking: boolean
  isSpeaking: boolean
  isListening: boolean
}

const STATUS_LABELS: Record<UIStatus, string> = {
  idle:      STRINGS.status.online,
  streaming: STRINGS.status.online,
  error:     STRINGS.status.error,
}

export default function StatusBar({ status, isThinking, isSpeaking, isListening }: Props) {
  const [time, setTime] = useState(() => new Date())

  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  const hh = time.getHours().toString().padStart(2, '0')
  const mm = time.getMinutes().toString().padStart(2, '0')
  const ss = time.getSeconds().toString().padStart(2, '0')

  const dotClass = status === 'error' ? 'error' : 'connected'

  return (
    <div className="status-bar">
      <span className={`status-dot ${dotClass}`} title={STATUS_LABELS[status]} />
      <span className="status-title">{STRINGS.appTitle}</span>

      {isListening && <span className="status-badge listening">{STRINGS.status.listening}</span>}
      {isThinking  && <span className="status-badge thinking">{STRINGS.status.processing}</span>}
      {isSpeaking  && !isThinking && !isListening && <span className="status-badge speaking">{STRINGS.status.responding}</span>}

      <span className="status-spacer" />

      <span className="status-info">{STATUS_LABELS[status]}</span>
      <span className="status-clock">{hh}:{mm}:{ss}</span>
    </div>
  )
}

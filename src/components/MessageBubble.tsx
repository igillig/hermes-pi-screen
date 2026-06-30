import type { ChatMessage } from '../types/hermes'
import { STRINGS } from '../i18n/strings'

interface Props {
  message: ChatMessage
}

export default function MessageBubble({ message }: Props) {
  const isUser = message.role === 'user'
  const time = new Date(message.timestamp)
  const timeStr = `${time.getHours().toString().padStart(2, '0')}:${time.getMinutes().toString().padStart(2, '0')}`

  return (
    <div className={`message ${message.role}${message.pending ? ' pending' : ''}`}>
      <div className="message-header">
        {isUser ? `${STRINGS.message.user} · ${timeStr}` : `${STRINGS.message.hermes} · ${timeStr}`}
      </div>
      <div className="message-content">
        {message.content}
        {message.pending && <span className="cursor-blink">▌</span>}
      </div>
    </div>
  )
}

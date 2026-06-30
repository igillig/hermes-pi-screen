import { useEffect, useRef } from 'react'
import type { ChatMessage } from '../types/hermes'
import MessageBubble from './MessageBubble'
import { STRINGS } from '../i18n/strings'

interface Props {
  messages: ChatMessage[]
  isThinking: boolean
}

export default function MessageList({ messages, isThinking }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const hasPending = messages.some(m => m.pending)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isThinking])

  return (
    <div className="message-list">
      {messages.length === 0 && (
        <div className="empty-state">
          <div className="empty-title">{STRINGS.messageList.emptyTitle}</div>
          <div className="empty-sub">{STRINGS.messageList.emptySubtitle}</div>
        </div>
      )}

      {messages.map(msg => (
        <MessageBubble key={msg.id} message={msg} />
      ))}

      {isThinking && !hasPending && (
        <div className="typing-indicator" aria-label={STRINGS.messageList.processingLabel}>
          <div className="typing-dot" />
          <div className="typing-dot" />
          <div className="typing-dot" />
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  )
}

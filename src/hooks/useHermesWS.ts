import { useEffect, useRef, useState, useCallback } from 'react'
import type { ChatMessage } from '../types/hermes'

const getWsUrl = () => {
  const base  = (import.meta.env.VITE_HERMES_WS_URL as string | undefined)
    ?? `ws://${window.location.hostname}:9119/api/ws`
  const token = import.meta.env.VITE_HERMES_INTERNAL_TOKEN as string | undefined
  return token ? `${base}?internal=${token}` : base
}

const RECONNECT_DELAY_MS = 3000

type WsMessage = {
  id?: number
  method?: string
  result?: unknown
  params?: Record<string, unknown>
  error?: { code: number; message: string }
}

export function useHermesWS() {
  const [messages, setMessages]   = useState<ChatMessage[]>([])
  const [isThinking, setIsThinking] = useState(false)

  const ws            = useRef<WebSocket | null>(null)
  const msgId         = useRef(1)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>()
  const pendingId     = useRef<string | null>(null)
  const accumulated   = useRef('')

  const connect = useCallback(() => {
    if (ws.current?.readyState === WebSocket.OPEN) return

    const socket = new WebSocket(getWsUrl())
    ws.current = socket

    socket.onclose = () => {
      ws.current = null
      reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY_MS)
    }

    socket.onmessage = (event: MessageEvent) => {
      for (const line of (event.data as string).split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          handleMessage(JSON.parse(trimmed) as WsMessage)
        } catch {
          console.warn('WS parse error:', trimmed)
        }
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleMessage = (msg: WsMessage) => {
    const method = msg.method

    // Streaming delta — accumulate text
    if (method === 'conversation.message.delta') {
      const content = msg.params?.content
      let chunk = ''
      if (Array.isArray(content)) {
        chunk = content.map((c: unknown) => (c as { text?: string }).text ?? '').join('')
      } else if (typeof content === 'string') {
        chunk = content
      }
      if (!chunk) return

      accumulated.current += chunk

      setMessages(prev => {
        const snap = accumulated.current
        if (!pendingId.current) {
          const id = `hermes-${Date.now()}`
          pendingId.current = id
          return [...prev, { id, role: 'hermes', content: snap, timestamp: Date.now(), pending: true }]
        }
        return prev.map(m => m.id === pendingId.current ? { ...m, content: snap } : m)
      })
      return
    }

    // Response complete
    if (method === 'conversation.message.complete') {
      setMessages(prev =>
        prev.map(m => m.id === pendingId.current ? { ...m, pending: false } : m)
      )
      pendingId.current = null
      accumulated.current = ''
      setIsThinking(false)
      return
    }

    // Fallback: old-style result with content+done (keeps backwards compat)
    if (msg.result && typeof msg.result === 'object') {
      const r = msg.result as Record<string, unknown>
      const content = (r.content ?? r.text ?? '') as string
      const done = r.done !== false
      if (!content && !done) return

      accumulated.current += content
      const snap = accumulated.current

      setMessages(prev => {
        if (!pendingId.current) {
          const id = `hermes-${msg.id ?? Date.now()}`
          pendingId.current = id
          return [...prev, { id, role: 'hermes', content: snap, timestamp: Date.now(), pending: !done }]
        }
        return prev.map(m => m.id === pendingId.current ? { ...m, content: snap, pending: !done } : m)
      })

      if (done) {
        pendingId.current = null
        accumulated.current = ''
        setIsThinking(false)
      }
    }
  }

  useEffect(() => {
    connect()
    return () => {
      clearTimeout(reconnectTimer.current)
      ws.current?.close()
    }
  }, [connect])

  const sendMessage = useCallback((content: string) => {
    const trimmed = content.trim()
    if (!trimmed || !ws.current || ws.current.readyState !== WebSocket.OPEN) return

    const id = msgId.current++
    setMessages(prev => [...prev, { id: `user-${id}`, role: 'user', content: trimmed, timestamp: Date.now() }])
    setIsThinking(true)
    accumulated.current = ''
    pendingId.current = null

    ws.current.send(JSON.stringify({ id, method: 'prompt.submit', params: { content: trimmed } }) + '\n')
  }, [])

  return { messages, isThinking, sendMessage }
}

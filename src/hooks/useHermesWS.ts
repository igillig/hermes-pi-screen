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

  const ws             = useRef<WebSocket | null>(null)
  const msgId          = useRef(1)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>()
  const pendingId      = useRef<string | null>(null)
  const accumulated    = useRef('')
  const sessionReady   = useRef(false)
  const sessionId      = useRef<string | null>(null)

  const connect = useCallback(() => {
    if (ws.current?.readyState === WebSocket.OPEN) return

    const socket = new WebSocket(getWsUrl())
    ws.current = socket

    socket.onclose = () => {
      ws.current = null
      sessionReady.current = false
      sessionId.current = null
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
    const type   = msg.params?.type as string | undefined

    // Gateway ready → create session
    if (method === 'event' && type === 'gateway.ready') {
      ws.current?.send(JSON.stringify({ id: 0, method: 'session.create', params: { title: 'parche-ui' } }) + '\n')
      return
    }

    // Session created → store session_id and allow sending messages
    if (msg.id === 0 && msg.result) {
      const r = msg.result as Record<string, unknown>
      sessionId.current = (r.session_id as string) ?? null
      sessionReady.current = true
      return
    }

    if (method !== 'event') return

    // Internal reasoning — ignore
    if (type === 'thinking.delta' || type === 'reasoning.delta') return

    // Response text chunk
    if (type === 'message.delta') {
      const chunk = (msg.params?.payload as { text?: string })?.text ?? ''
      if (!chunk) return

      accumulated.current += chunk
      const snap = accumulated.current

      if (!pendingId.current) pendingId.current = `hermes-${Date.now()}`
      const id = pendingId.current

      setMessages(prev => {
        if (!prev.some(m => m.id === id))
          return [...prev, { id, role: 'hermes', content: snap, timestamp: Date.now(), pending: true }]
        return prev.map(m => m.id === id ? { ...m, content: snap } : m)
      })
      return
    }

    // Response complete — use payload.text as canonical content
    if (type === 'message.complete') {
      const finalText = (msg.params?.payload as { text?: string })?.text ?? accumulated.current
      const id = pendingId.current ?? `hermes-${Date.now()}`

      setMessages(prev => {
        if (!prev.some(m => m.id === id))
          return [...prev, { id, role: 'hermes', content: finalText, timestamp: Date.now(), pending: false }]
        return prev.map(m => m.id === id ? { ...m, content: finalText, pending: false } : m)
      })
      pendingId.current = null
      accumulated.current = ''
      setIsThinking(false)
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
    if (!trimmed || !ws.current || ws.current.readyState !== WebSocket.OPEN || !sessionReady.current) return

    const id = msgId.current++
    setMessages(prev => [...prev, { id: `user-${id}`, role: 'user', content: trimmed, timestamp: Date.now() }])
    setIsThinking(true)
    accumulated.current = ''
    pendingId.current = null

    ws.current.send(JSON.stringify({ id, method: 'prompt.submit', params: { content: trimmed, session_id: sessionId.current } }) + '\n')
  }, [])

  return { messages, isThinking, sendMessage }
}

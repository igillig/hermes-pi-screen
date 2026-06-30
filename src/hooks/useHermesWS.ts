import { useEffect, useRef, useState, useCallback } from 'react'
import type { JsonRpcResponse, ChatMessage, ConnectionStatus } from '../types/hermes'

const getWsUrl = () => {
  const override = import.meta.env.VITE_HERMES_WS_URL as string | undefined
  if (override) return override
  const host = window.location.hostname
  return `ws://${host}:9119/api/ws`
}

const RECONNECT_DELAY_MS = 3000

export function useHermesWS() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [isThinking, setIsThinking] = useState(false)

  const ws = useRef<WebSocket | null>(null)
  const msgId = useRef(1)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>()
  const hasPendingHermes = useRef(false)

  const handleResponse = useCallback((response: JsonRpcResponse) => {
    // Server-initiated notification (e.g. stream chunk via method)
    const content =
      response.result?.content ??
      response.result?.text ??
      (response.params?.content as string | undefined) ??
      ''
    const done = response.result?.done !== false

    if (content !== '' || done) {
      hasPendingHermes.current = !done

      setMessages(prev => {
        const pendingIdx = prev.findIndex(m => m.pending && m.role === 'hermes')
        if (pendingIdx === -1) {
          return [
            ...prev,
            {
              id: `hermes-${response.id ?? Date.now()}`,
              role: 'hermes',
              content,
              timestamp: Date.now(),
              pending: !done,
            },
          ]
        }
        const updated = [...prev]
        updated[pendingIdx] = {
          ...updated[pendingIdx],
          content: updated[pendingIdx].content + content,
          pending: !done,
        }
        return updated
      })

      if (done) setIsThinking(false)
    }

    if (response.error) {
      console.error('Hermes error:', response.error)
      setIsThinking(false)
      hasPendingHermes.current = false
    }
  }, [])

  const connect = useCallback(() => {
    if (ws.current?.readyState === WebSocket.OPEN) return

    setStatus('connecting')
    const url = getWsUrl()
    const socket = new WebSocket(url)
    ws.current = socket

    socket.onopen = () => {
      setStatus('connected')
      clearTimeout(reconnectTimer.current)
    }

    socket.onclose = () => {
      setStatus('disconnected')
      ws.current = null
      reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY_MS)
    }

    socket.onerror = () => {
      setStatus('error')
    }

    socket.onmessage = (event: MessageEvent) => {
      const raw = event.data as string
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          handleResponse(JSON.parse(trimmed) as JsonRpcResponse)
        } catch {
          console.warn('Unparseable WS message:', trimmed)
        }
      }
    }
  }, [handleResponse])

  useEffect(() => {
    connect()
    return () => {
      clearTimeout(reconnectTimer.current)
      ws.current?.close()
    }
  }, [connect])

  const sendMessage = useCallback(
    (content: string) => {
      const trimmed = content.trim()
      if (!trimmed) return
      if (!ws.current || ws.current.readyState !== WebSocket.OPEN) return

      const id = msgId.current++

      setMessages(prev => [
        ...prev,
        { id: `user-${id}`, role: 'user', content: trimmed, timestamp: Date.now() },
      ])

      setIsThinking(true)
      hasPendingHermes.current = false

      const request = { id, method: 'prompt.submit', params: { content: trimmed } }
      ws.current.send(JSON.stringify(request) + '\n')
    },
    [],
  )

  return { messages, status, isThinking, sendMessage }
}

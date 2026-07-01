import { useCallback, useRef, useState } from 'react'
import type { ChatMessage } from '../types/hermes'

const getConfig = () => ({
  baseUrl: (import.meta.env.VITE_HERMES_API_URL as string | undefined)
    ?? `https://${window.location.hostname}:8000`,
  apiKey: (import.meta.env.VITE_HERMES_API_KEY as string | undefined) ?? '',
})

export type ConnectionStatus = 'idle' | 'streaming' | 'error'

export function useHermesAPI() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [status, setStatus] = useState<ConnectionStatus>('idle')
  const [isThinking, setIsThinking] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const sendMessage = useCallback(async (content: string) => {
    const trimmed = content.trim()
    if (!trimmed || isThinking) return

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: trimmed,
      timestamp: Date.now(),
    }

    // Build history for context (last 20 messages)
    setMessages(prev => {
      const history = prev.slice(-20)
      return [...history, userMsg]
    })

    setIsThinking(true)
    setStatus('streaming')

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    const hermesMsg: ChatMessage = {
      id: `hermes-${Date.now()}`,
      role: 'hermes',
      content: '',
      timestamp: Date.now(),
      pending: true,
    }

    setMessages(prev => [...prev, hermesMsg])

    try {
      const { baseUrl, apiKey } = getConfig()

      // Build messages array for the API from current state + new user msg
      const apiMessages = (await new Promise<ChatMessage[]>(resolve =>
        setMessages(prev => { resolve(prev); return prev })
      ))
        .filter(m => !m.pending)
        .map(m => ({ role: m.role === 'hermes' ? 'assistant' : 'user', content: m.content }))

      const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: 'hermes',
          messages: apiMessages,
          stream: true,
        }),
        signal: controller.signal,
      })

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${await resp.text()}`)
      }

      const reader = resp.body!.getReader()
      const decoder = new TextDecoder()
      let accumulated = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value, { stream: true })

        for (const line of chunk.split('\n')) {
          const trimmedLine = line.trim()
          if (!trimmedLine || !trimmedLine.startsWith('data:')) continue

          const data = trimmedLine.slice(5).trim()
          if (data === '[DONE]') break

          try {
            const parsed = JSON.parse(data)
            const delta = parsed.choices?.[0]?.delta?.content ?? ''
            if (delta) {
              accumulated += delta
              const snap = accumulated
              setMessages(prev =>
                prev.map(m =>
                  m.id === hermesMsg.id ? { ...m, content: snap, pending: true } : m,
                ),
              )
            }
          } catch {
            // incomplete chunk, continue
          }
        }
      }

      // Mark complete
      setMessages(prev =>
        prev.map(m => (m.id === hermesMsg.id ? { ...m, pending: false } : m)),
      )
      setStatus('idle')
    } catch (err) {
      if ((err as Error).name === 'AbortError') return

      console.error('Hermes API error:', err)
      setStatus('error')
      setMessages(prev =>
        prev.map(m =>
          m.id === hermesMsg.id
            ? { ...m, content: `Error: ${(err as Error).message}`, pending: false, isError: true }
            : m,
        ),
      )
    } finally {
      setIsThinking(false)
    }
  }, [isThinking])

  const cancelStream = useCallback(() => {
    abortRef.current?.abort()
    setIsThinking(false)
    setStatus('idle')
    setMessages(prev =>
      prev.map(m => (m.pending ? { ...m, pending: false } : m)),
    )
  }, [])

  return { messages, status, isThinking, sendMessage, cancelStream }
}

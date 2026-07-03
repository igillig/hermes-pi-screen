import { useEffect, useRef, useState, useCallback } from 'react'
import type { OrbState } from '../components/NeuralOrb'

// Same-origin by default — nginx reverse-proxies /ws-status to the
// orchestrator container over the internal docker network (see nginx.conf),
// so the browser never needs a separate host/port for it. Only set
// VITE_ORCHESTRATOR_WS_URL if you're bypassing that proxy entirely.
const getWsUrl = () => {
  const explicit = import.meta.env.VITE_ORCHESTRATOR_WS_URL as string | undefined
  if (explicit) return explicit
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws-status`
}

const RECONNECT_DELAY_MS = 3000

type StatusMessage = { status?: OrbState }

/**
 * Pure status listener for the Python orchestrator running on the Pi.
 * The orchestrator owns mic capture, STT, Hermes chat, and TTS playback —
 * this hook just mirrors its {"status": "listening"|"thinking"|"talking"}
 * broadcasts so the orb can react.
 */
export function useOrchestratorStatus() {
  const [status, setStatus] = useState<OrbState>('idle')
  const [connected, setConnected] = useState(false)
  const ws             = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>()

  const connect = useCallback(() => {
    if (ws.current?.readyState === WebSocket.OPEN) return

    const socket = new WebSocket(getWsUrl())
    ws.current = socket

    socket.onopen = () => setConnected(true)

    socket.onclose = () => {
      ws.current = null
      setConnected(false)
      reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY_MS)
    }

    socket.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string) as StatusMessage
        if (msg.status) setStatus(msg.status)
      } catch {
        console.warn('orchestrator status parse error:', event.data)
      }
    }
  }, [])

  useEffect(() => {
    connect()
    return () => {
      clearTimeout(reconnectTimer.current)
      ws.current?.close()
    }
  }, [connect])

  return { status, connected }
}

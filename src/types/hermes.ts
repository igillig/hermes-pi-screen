export interface JsonRpcRequest {
  id: number
  method: string
  params: Record<string, unknown>
}

export interface JsonRpcResponse {
  id?: number
  result?: {
    content?: string
    done?: boolean
    text?: string
    [key: string]: unknown
  }
  error?: {
    code: number
    message: string
  }
  method?: string
  params?: Record<string, unknown>
}

export interface ChatMessage {
  id: string
  role: 'user' | 'hermes'
  content: string
  timestamp: number
  pending?: boolean
  isError?: boolean
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

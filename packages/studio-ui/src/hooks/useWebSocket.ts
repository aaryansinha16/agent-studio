/**
 * useWebSocket — connects the UI to the event bridge.
 *
 * Lifecycle:
 *   1. On mount, open ws://host:port (defaults from @agent-studio/shared)
 *   2. On open, ask the bridge for a full snapshot via `replay:request`
 *   3. Every wire message is parsed by Zod before it touches the store
 *   4. On close, schedule an exponential-backoff reconnect attempt
 *   5. On unmount, tear everything down cleanly
 *
 * The hook is intentionally read-only from the UI's perspective: components
 * never need to send messages back, they just observe the store.
 */

import { useEffect, useRef } from 'react'

import {
  DEFAULT_BRIDGE_HOST,
  DEFAULT_BRIDGE_PORT,
  HEARTBEAT_INTERVAL_MS,
  RECONNECT_INITIAL_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  WireMessageSchema,
  defaultBridgeUrl,
} from '@agent-studio/shared'

import { useStudioStore } from '../store/studioStore'

interface UseWebSocketOptions {
  url?: string
  /** When false, the hook is a no-op — used by useStudioTransport in Electron mode. */
  enabled?: boolean
}

/** Connect to the event bridge. Re-runs only if `url` changes. */
export const useWebSocket = (options: UseWebSocketOptions = {}): void => {
  const url = options.url ?? defaultBridgeUrl(DEFAULT_BRIDGE_HOST, DEFAULT_BRIDGE_PORT)
  const enabled = options.enabled ?? true
  const reconnectAttemptRef = useRef(0)
  const reconnectTimerRef = useRef<number | null>(null)
  const heartbeatTimerRef = useRef<number | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const cancelledRef = useRef(false)

  useEffect(() => {
    if (!enabled) return
    cancelledRef.current = false
    const store = useStudioStore.getState

    const clearReconnect = () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
    }

    const clearHeartbeat = () => {
      if (heartbeatTimerRef.current !== null) {
        window.clearInterval(heartbeatTimerRef.current)
        heartbeatTimerRef.current = null
      }
    }

    const scheduleReconnect = () => {
      if (cancelledRef.current) return
      if (reconnectTimerRef.current !== null) return
      const delay = Math.min(
        RECONNECT_INITIAL_DELAY_MS * 2 ** reconnectAttemptRef.current,
        RECONNECT_MAX_DELAY_MS,
      )
      reconnectAttemptRef.current += 1
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null
        connect()
      }, delay)
    }

    const handleMessage = (raw: string) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        return
      }
      const result = WireMessageSchema.safeParse(parsed)
      if (!result.success) return
      const message = result.data
      switch (message.kind) {
        case 'event':
          store().applyEvent(message.event)
          return
        case 'replay:response':
          store().hydrateFromSnapshot(message.snapshot)
          return
        case 'producer:active':
          store().setActiveProducer(message.origin)
          return
        case 'pong':
        case 'ping':
        case 'replay:request':
          return
      }
    }

    const connect = () => {
      if (cancelledRef.current) return
      store().setConnectionStatus('connecting')
      let socket: WebSocket
      try {
        socket = new WebSocket(url)
      } catch (err) {
        store().setConnectionStatus('error', err instanceof Error ? err.message : String(err))
        scheduleReconnect()
        return
      }
      socketRef.current = socket

      socket.addEventListener('open', () => {
        reconnectAttemptRef.current = 0
        store().setConnectionStatus('connected')
        try {
          socket.send(JSON.stringify({ kind: 'replay:request' }))
        } catch {
          // Ignore — close handler will retry.
        }
        clearHeartbeat()
        heartbeatTimerRef.current = window.setInterval(() => {
          if (socket.readyState !== WebSocket.OPEN) return
          try {
            socket.send(JSON.stringify({ kind: 'ping', timestamp: Date.now() }))
          } catch {
            // Ignore.
          }
        }, HEARTBEAT_INTERVAL_MS)
      })

      socket.addEventListener('message', (ev) => {
        if (typeof ev.data === 'string') handleMessage(ev.data)
      })

      socket.addEventListener('error', () => {
        store().setConnectionStatus('error', 'WebSocket error')
      })

      socket.addEventListener('close', () => {
        clearHeartbeat()
        socketRef.current = null
        if (cancelledRef.current) return
        store().setConnectionStatus('disconnected')
        scheduleReconnect()
      })
    }

    connect()

    return () => {
      cancelledRef.current = true
      clearReconnect()
      clearHeartbeat()
      const socket = socketRef.current
      socketRef.current = null
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.close(1000, 'component unmounted')
      }
    }
  }, [url, enabled])
}

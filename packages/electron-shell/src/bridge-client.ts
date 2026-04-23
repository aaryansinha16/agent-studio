/**
 * Main-process WebSocket client to the Agent Studio event bridge.
 *
 * This is the *only* WebSocket connection in the Electron app — both
 * renderer windows receive their state via IPC from this single client.
 * Centralizing the connection here means:
 *   - one source of truth for connection status
 *   - new windows can join mid-session and immediately replay current state
 *   - reconnection logic lives in one place, not duplicated in two renderers
 */

import { EventEmitter } from 'node:events'

import WebSocket from 'ws'

import {
  type BridgeConnectionStatus,
  type EventEnvelope,
  type ProducerOrigin,
  type ProjectSession,
  type StudioEvent,
  type WireMessage,
  type WorldSnapshot,
  DEFAULT_BRIDGE_HOST,
  DEFAULT_BRIDGE_PORT,
  HEARTBEAT_INTERVAL_MS,
  RECONNECT_INITIAL_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  SOURCE_PLUGIN,
  WireMessageSchema,
  createLogger,
  defaultBridgeUrl,
} from '@agent-studio/shared'

const log = createLogger('electron-shell:bridge-client')

interface BridgeClientOptions {
  url?: string
}

/** Strongly-typed event names emitted by BridgeClient. */
type BridgeClientEvents = {
  event: [StudioEvent]
  status: [BridgeConnectionStatus]
  snapshot: [WorldSnapshot]
  projects: [ProjectSession[]]
  producer: [ProducerOrigin | null]
}

/**
 * Resilient client to the event bridge.
 *
 * Emits:
 *   - 'event'    → every StudioEvent forwarded by the bridge
 *   - 'status'   → connection status changes
 *   - 'snapshot' → full world snapshot (after each successful connect)
 */
export class BridgeClient extends EventEmitter<BridgeClientEvents> {
  private readonly url: string
  private socket: WebSocket | null = null
  private status: BridgeConnectionStatus = 'idle'
  private latestSnapshot: WorldSnapshot | null = null
  private latestProjects: ProjectSession[] = []
  private reconnectAttempt = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private closed = false
  /** True once we've sent a hello as an orchestrator producer. */
  private announcedProducer = false
  /** Callbacks waiting for the next projects:list-response. */
  private pendingProjectRequests: Array<(projects: ProjectSession[]) => void> = []

  constructor(options: BridgeClientOptions = {}) {
    super()
    this.url = options.url ?? defaultBridgeUrl(DEFAULT_BRIDGE_HOST, DEFAULT_BRIDGE_PORT)
  }

  start(): void {
    this.closed = false
    this.connect()
  }

  stop(): void {
    this.closed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.socket) {
      try {
        this.socket.close()
      } catch {
        // Ignore.
      }
      this.socket = null
    }
    this.setStatus('disconnected')
  }

  /** Latest cached snapshot, or null if we've never received one. */
  getLatestSnapshot(): WorldSnapshot | null {
    return this.latestSnapshot
  }

  /** Current connection status. */
  getStatus(): BridgeConnectionStatus {
    return this.status
  }

  /**
   * Send a StudioEvent through the bridge as a producer. Used by the
   * launch orchestrator (and any future main-process producers) to push
   * synthesized events into the system. Drops silently if the socket
   * isn't open — callers should check `getStatus()` if they need to
   * report failure to the user.
   */
  sendEvent(event: StudioEvent, source: string = SOURCE_PLUGIN): void {
    // Lazy hello — on first event, announce ourselves to the bridge
    // as an orchestrator-origin producer. See connect()'s open handler
    // for the reconnect path.
    if (!this.announcedProducer) {
      this.announcedProducer = true
      this.send({ kind: 'hello', origin: 'orchestrator', label: 'electron-shell' })
    }
    const envelope: EventEnvelope = { kind: 'event', source, event }
    this.send(envelope)
  }

  /** Latest cached projects list — returns [] until the first response arrives. */
  getLatestProjects(): ProjectSession[] {
    return this.latestProjects
  }

  /**
   * Ask the bridge for the persisted project list. Resolves with the
   * next `projects:list-response` the bridge sends. Rejects after a
   * 5-second timeout so the renderer never hangs forever waiting.
   */
  listProjects(): Promise<ProjectSession[]> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        resolve([...this.latestProjects])
        return
      }
      const timer = setTimeout(() => {
        const idx = this.pendingProjectRequests.indexOf(resolve)
        if (idx >= 0) this.pendingProjectRequests.splice(idx, 1)
        reject(new Error('projects:list-request timed out after 5s'))
      }, 5_000)
      // Wrap resolve so we clear the timer on success.
      const wrapped = (projects: ProjectSession[]) => {
        clearTimeout(timer)
        resolve(projects)
      }
      this.pendingProjectRequests.push(wrapped)
      this.send({ kind: 'projects:list-request' })
    })
  }

  /** Upsert a project into the bridge's persisted store. Fire-and-forget. */
  saveProject(project: ProjectSession): void {
    this.send({ kind: 'projects:save', project })
  }

  // ───────────────────────────────────────────────────────────────────────────

  private setStatus(next: BridgeConnectionStatus): void {
    if (this.status === next) return
    this.status = next
    this.emit('status', next)
    log.info('bridge connection status', { status: next, url: this.url })
  }

  private connect(): void {
    if (this.closed) return
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return

    this.setStatus('connecting')
    let socket: WebSocket
    try {
      socket = new WebSocket(this.url)
    } catch (err) {
      log.warn('socket construction failed', { error: String(err) })
      this.setStatus('error')
      this.scheduleReconnect()
      return
    }
    this.socket = socket

    socket.once('open', () => {
      this.reconnectAttempt = 0
      this.setStatus('connected')
      this.startHeartbeat()
      // Ask for the current snapshot so newly opened windows have data.
      // We intentionally DO NOT announce ourselves as a producer up
      // front — that only happens on the first sendEvent() call so an
      // idle Electron instance doesn't suppress a concurrent
      // mock-events.ts producer.
      this.send({ kind: 'replay:request' })
      // If we've previously produced events in this session, re-announce
      // after a reconnect so the bridge knows our origin again.
      if (this.announcedProducer) {
        this.send({ kind: 'hello', origin: 'orchestrator', label: 'electron-shell' })
      }
    })

    socket.on('message', (data) => {
      this.handleMessage(data.toString())
    })

    socket.once('close', () => {
      this.stopHeartbeat()
      this.socket = null
      if (this.closed) return
      this.setStatus('disconnected')
      this.scheduleReconnect()
    })

    socket.on('error', (err) => {
      log.warn('socket error', { error: String(err) })
    })
  }

  private scheduleReconnect(): void {
    if (this.closed) return
    if (this.reconnectTimer) return
    const delay = Math.min(
      RECONNECT_INITIAL_DELAY_MS * 2 ** this.reconnectAttempt,
      RECONNECT_MAX_DELAY_MS,
    )
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
    this.reconnectTimer.unref?.()
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      this.send({ kind: 'ping', timestamp: Date.now() })
    }, HEARTBEAT_INTERVAL_MS)
    this.heartbeatTimer.unref?.()
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private send(message: WireMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return
    try {
      this.socket.send(JSON.stringify(message))
    } catch (err) {
      log.warn('send failed', { error: String(err) })
    }
  }

  private handleMessage(raw: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      log.warn('bridge sent non-JSON', { error: String(err) })
      return
    }
    const result = WireMessageSchema.safeParse(parsed)
    if (!result.success) {
      log.warn('bridge sent message that failed validation', {
        issues: result.error.issues.slice(0, 3),
      })
      return
    }
    const message = result.data
    switch (message.kind) {
      case 'event':
        this.emit('event', message.event)
        return
      case 'replay:response':
        this.latestSnapshot = message.snapshot
        this.emit('snapshot', message.snapshot)
        return
      case 'projects:list-response': {
        this.latestProjects = message.projects
        this.emit('projects', message.projects)
        // Resolve every pending listProjects() caller.
        const waiters = this.pendingProjectRequests.splice(0, this.pendingProjectRequests.length)
        for (const waiter of waiters) waiter([...message.projects])
        return
      }
      case 'producer:active':
        this.emit('producer', message.origin)
        return
      case 'hello':
      case 'pong':
      case 'ping':
      case 'replay:request':
      case 'projects:list-request':
      case 'projects:save':
        return
    }
  }
}

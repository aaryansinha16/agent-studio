/**
 * WebSocket client used by the Ruflo plugin to ship StudioEvents to the
 * event bridge.
 *
 * Responsibilities:
 *   - Open and maintain a connection to ws://host:port (default 127.0.0.1:6747)
 *   - Reconnect with exponential backoff if the bridge isn't running yet
 *   - Buffer outbound events while disconnected (bounded queue)
 *   - Validate every outbound event against StudioEventSchema before sending
 *
 * The class is intentionally framework-free so it can be exercised by tests
 * without spinning up Ruflo.
 */

import WebSocket from 'ws';

import {
  type EventEnvelope,
  type StudioEvent,
  DEFAULT_BRIDGE_HOST,
  DEFAULT_BRIDGE_PORT,
  RECONNECT_INITIAL_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  SOURCE_PLUGIN,
  StudioError,
  StudioEventSchema,
  createLogger,
  defaultBridgeUrl,
} from '@agent-studio/shared';

const log = createLogger('ruflo-plugin:emitter');

interface EmitterOptions {
  /** Override the bridge URL. */
  url?: string;
  /** Identifier put into the EventEnvelope.source field. */
  source?: string;
  /** Maximum events to buffer while disconnected. Older events are dropped. */
  maxBufferSize?: number;
}

/** Connects to the bridge and forwards typed StudioEvents to it. */
export class StudioEventEmitter {
  private readonly url: string;
  private readonly source: string;
  private readonly maxBufferSize: number;
  private socket: WebSocket | null = null;
  private connecting = false;
  private closed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly buffer: EventEnvelope[] = [];

  constructor(options: EmitterOptions = {}) {
    this.url = options.url ?? defaultBridgeUrl(DEFAULT_BRIDGE_HOST, DEFAULT_BRIDGE_PORT);
    this.source = options.source ?? SOURCE_PLUGIN;
    this.maxBufferSize = options.maxBufferSize ?? 500;
  }

  /** Begin connecting to the bridge. Safe to call multiple times. */
  start(): void {
    this.closed = false;
    this.connect();
  }

  /** Validate and ship a StudioEvent. Buffers if the connection is down. */
  emit(event: StudioEvent): void {
    const result = StudioEventSchema.safeParse(event);
    if (!result.success) {
      throw new StudioError('STUDIO_EVENT_VALIDATION_FAILED', {
        message: `Event of type "${event.type}" failed validation`,
        context: { type: event.type, issues: result.error.issues.slice(0, 5) },
      });
    }

    const envelope: EventEnvelope = {
      kind: 'event',
      source: this.source,
      event: result.data,
    };

    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.sendEnvelope(envelope);
    } else {
      this.bufferEnvelope(envelope);
      this.connect();
    }
  }

  /** Stop the emitter and tear down any pending reconnect. */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // Ignore.
      }
      this.socket = null;
    }
    log.info('emitter closed', { bufferedDropped: this.buffer.length });
    this.buffer.length = 0;
  }

  /** Number of envelopes currently waiting to be sent. */
  get bufferedCount(): number {
    return this.buffer.length;
  }

  // ───────────────────────────────────────────────────────────────────────────

  private connect(): void {
    if (this.closed) return;
    if (this.connecting) return;
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return;

    this.connecting = true;
    log.debug('connecting to bridge', { url: this.url, attempt: this.reconnectAttempt });

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch (cause) {
      this.connecting = false;
      this.scheduleReconnect();
      log.warn('socket construction failed', { error: String(cause) });
      return;
    }
    this.socket = socket;

    socket.once('open', () => {
      this.connecting = false;
      this.reconnectAttempt = 0;
      log.info('connected to bridge', { url: this.url });
      this.flushBuffer();
    });

    socket.once('close', (code, reason) => {
      this.connecting = false;
      this.socket = null;
      log.warn('disconnected from bridge', { code, reason: reason.toString() });
      this.scheduleReconnect();
    });

    socket.on('error', (err) => {
      log.warn('socket error', { error: String(err) });
    });
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.reconnectTimer) return;
    const delay = Math.min(
      RECONNECT_INITIAL_DELAY_MS * 2 ** this.reconnectAttempt,
      RECONNECT_MAX_DELAY_MS,
    );
    this.reconnectAttempt += 1;
    log.debug('scheduling reconnect', { delay, attempt: this.reconnectAttempt });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private bufferEnvelope(envelope: EventEnvelope): void {
    if (this.buffer.length >= this.maxBufferSize) {
      const dropped = this.buffer.shift();
      log.warn('outbound buffer full, dropping oldest event', {
        droppedType: dropped?.event.type ?? null,
      });
    }
    this.buffer.push(envelope);
  }

  private flushBuffer(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    while (this.buffer.length > 0) {
      const envelope = this.buffer.shift();
      if (envelope) this.sendEnvelope(envelope);
    }
  }

  private sendEnvelope(envelope: EventEnvelope): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.bufferEnvelope(envelope);
      return;
    }
    try {
      this.socket.send(JSON.stringify(envelope));
    } catch (cause) {
      log.warn('send failed, re-buffering', { error: String(cause) });
      this.bufferEnvelope(envelope);
    }
  }
}

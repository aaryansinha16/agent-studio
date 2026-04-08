/**
 * Agent Studio event bridge.
 *
 * A single WebSocket server that:
 *   1. Accepts connections from producers (the Ruflo plugin or the mock
 *      generator) which push StudioEvents wrapped in EventEnvelope.
 *   2. Accepts connections from consumers (the Studio UI) which receive
 *      every event broadcast and can ask for a full state replay.
 *
 * There's no role negotiation on the wire — every client is treated as both
 * a possible producer and a possible consumer. The first message a client
 * sends declares its intent: an `event` envelope marks it as a producer for
 * routing/logging purposes; a `replay:request` marks it as a consumer.
 */

import { WebSocketServer, type WebSocket } from 'ws';
import { ZodError } from 'zod';

import {
  type EventEnvelope,
  type ReplayResponse,
  type WireMessage,
  DEFAULT_BRIDGE_HOST,
  DEFAULT_BRIDGE_PORT,
  HEARTBEAT_INTERVAL_MS,
  StudioError,
  WireMessageSchema,
  createLogger,
} from '@agent-studio/shared';

import { SessionRecorder } from './session.js';
import { StateStore } from './state-store.js';

const log = createLogger('event-bridge:server');

/** Per-connection metadata kept alongside the raw WebSocket. */
interface ClientMeta {
  id: string;
  /** Producer = sends events; consumer = receives broadcasts. A client may be both. */
  role: 'producer' | 'consumer' | 'unknown';
  connectedAt: number;
  isAlive: boolean;
}

interface BridgeOptions {
  host?: string;
  port?: number;
  /** When true, SQLite runs entirely in memory (used by tests). */
  inMemory?: boolean;
}

interface BridgeHandle {
  /** Stop the server, flush state, and disconnect every client. */
  close(): Promise<void>;
  /** Direct access to the state store, primarily for tests. */
  readonly stateStore: StateStore;
}

let nextClientId = 1;

/** Boot the event bridge. Returns a handle for graceful shutdown. */
export const startBridge = (options: BridgeOptions = {}): BridgeHandle => {
  const host = options.host ?? DEFAULT_BRIDGE_HOST;
  const port = options.port ?? DEFAULT_BRIDGE_PORT;

  const stateStore = new StateStore({ inMemory: options.inMemory });
  const recorder = new SessionRecorder();
  const clients = new Map<WebSocket, ClientMeta>();

  const wss = new WebSocketServer({ host, port });

  wss.on('listening', () => {
    log.info('event bridge listening', { host, port });
  });

  wss.on('error', (err) => {
    log.error('server error', { error: String(err) });
  });

  wss.on('connection', (socket, req) => {
    const meta: ClientMeta = {
      id: `c${nextClientId++}`,
      role: 'unknown',
      connectedAt: Date.now(),
      isAlive: true,
    };
    clients.set(socket, meta);
    log.info('client connected', {
      clientId: meta.id,
      remote: req.socket.remoteAddress,
      total: clients.size,
    });

    socket.on('pong', () => {
      meta.isAlive = true;
    });

    socket.on('message', (data) => {
      try {
        handleIncoming(socket, meta, data.toString());
      } catch (err) {
        log.error('failed to handle message', {
          clientId: meta.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    socket.on('close', () => {
      clients.delete(socket);
      log.info('client disconnected', { clientId: meta.id, total: clients.size });
    });

    socket.on('error', (err) => {
      log.warn('client socket error', { clientId: meta.id, error: String(err) });
    });
  });

  // Heartbeat — drop dead connections that never reply to pings.
  const heartbeat = setInterval(() => {
    for (const [socket, meta] of clients) {
      if (!meta.isAlive) {
        log.warn('terminating unresponsive client', { clientId: meta.id });
        socket.terminate();
        clients.delete(socket);
        continue;
      }
      meta.isAlive = false;
      try {
        socket.ping();
      } catch {
        // Ignore — close handler will clean up.
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  /** Validate, route, and apply an incoming wire message. */
  const handleIncoming = (socket: WebSocket, meta: ClientMeta, raw: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new StudioError('WIRE_MESSAGE_INVALID_JSON', {
        cause,
        context: { clientId: meta.id, raw: raw.slice(0, 256) },
      });
    }

    let message: WireMessage;
    try {
      message = WireMessageSchema.parse(parsed);
    } catch (cause) {
      if (cause instanceof ZodError) {
        log.warn('wire message rejected by schema', {
          clientId: meta.id,
          issues: cause.issues.slice(0, 5),
        });
      }
      throw new StudioError('WIRE_MESSAGE_VALIDATION_FAILED', { cause });
    }

    switch (message.kind) {
      case 'event': {
        if (meta.role === 'unknown') meta.role = 'producer';
        const applied = stateStore.applyEvent(message.event);
        if (applied) {
          recorder.record(message.event);
          broadcastEvent(message);
        }
        return;
      }
      case 'replay:request': {
        if (meta.role === 'unknown') meta.role = 'consumer';
        const response: ReplayResponse = {
          kind: 'replay:response',
          snapshot: stateStore.getFullState(),
        };
        sendJson(socket, response);
        return;
      }
      case 'ping': {
        sendJson(socket, { kind: 'pong', timestamp: Date.now() });
        return;
      }
      case 'projects:list-request': {
        if (meta.role === 'unknown') meta.role = 'consumer';
        sendJson(socket, {
          kind: 'projects:list-response',
          projects: stateStore.listProjects(),
        });
        return;
      }
      case 'projects:save': {
        if (meta.role === 'unknown') meta.role = 'consumer';
        stateStore.upsertProject(message.project);
        // Broadcast the updated list to every consumer so other windows
        // (and any future multi-client setups) see the new project
        // without having to re-ask.
        const response = {
          kind: 'projects:list-response' as const,
          projects: stateStore.listProjects(),
        };
        for (const [s, m] of clients) {
          if (m.role === 'producer') continue;
          if (s.readyState !== s.OPEN) continue;
          try {
            s.send(JSON.stringify(response));
          } catch (err) {
            log.warn('projects broadcast failed', { clientId: m.id, error: String(err) });
          }
        }
        return;
      }
      case 'pong':
      case 'replay:response':
      case 'projects:list-response': {
        // No-op — these are bridge → client messages.
        return;
      }
      default: {
        const _exhaustive: never = message;
        return _exhaustive;
      }
    }
  };

  /** Broadcast an event envelope to every connected consumer. */
  const broadcastEvent = (envelope: EventEnvelope): void => {
    const payload = JSON.stringify(envelope);
    for (const [socket, meta] of clients) {
      if (meta.role === 'producer') continue; // don't echo back to producers
      if (socket.readyState !== socket.OPEN) continue;
      try {
        socket.send(payload);
      } catch (err) {
        log.warn('broadcast send failed', { clientId: meta.id, error: String(err) });
      }
    }
  };

  const close = async (): Promise<void> => {
    clearInterval(heartbeat);
    for (const socket of clients.keys()) {
      try {
        socket.close(1001, 'bridge shutting down');
      } catch {
        // Ignore.
      }
    }
    clients.clear();
    recorder.stop();
    stateStore.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    log.info('event bridge stopped');
  };

  // Graceful shutdown on the standard signals.
  const onSignal = (signal: NodeJS.Signals) => {
    log.info('received shutdown signal', { signal });
    void close().then(() => process.exit(0));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  return { close, stateStore };
};

/** JSON-stringify and send a wire message on a socket, swallowing send errors. */
const sendJson = (socket: WebSocket, message: WireMessage): void => {
  if (socket.readyState !== socket.OPEN) return;
  try {
    socket.send(JSON.stringify(message));
  } catch (err) {
    log.warn('sendJson failed', { error: String(err) });
  }
};

// When invoked directly via `tsx src/server.ts` (or `node dist/server.js`),
// boot the bridge with default options. When imported as a library (tests,
// the dev script), the consumer calls startBridge() themselves.
const isEntrypoint = (() => {
  if (typeof process === 'undefined' || !process.argv[1]) return false;
  const invoked = process.argv[1];
  return (
    invoked.endsWith('server.ts') ||
    invoked.endsWith('server.js') ||
    invoked.endsWith('server.mjs')
  );
})();

if (isEntrypoint) {
  startBridge();
}

/**
 * System-wide constants for Agent Studio.
 *
 * Event names and configuration values that need to stay in sync across
 * the plugin, the bridge, and the UI.
 */

import type { StudioEventType } from './types.js';

/** All event names emitted by the system. Use these instead of string literals. */
export const EVENT_NAMES = {
  AGENT_SPAWNED: 'agent:spawned',
  AGENT_STATE_CHANGED: 'agent:state-changed',
  AGENT_TERMINATED: 'agent:terminated',
  TASK_STARTED: 'task:started',
  TASK_COMPLETED: 'task:completed',
  TASK_FAILED: 'task:failed',
  SWARM_INITIALIZED: 'swarm:initialized',
  SWARM_SHUTDOWN: 'swarm:shutdown',
  MESSAGE_SENT: 'message:sent',
} as const satisfies Record<string, StudioEventType>;

/** Default WebSocket port for the event bridge. */
export const DEFAULT_BRIDGE_PORT = 6747;

/** Default host for the event bridge. */
export const DEFAULT_BRIDGE_HOST = '127.0.0.1';

/** Returns the default ws:// URL the bridge listens on. */
export const defaultBridgeUrl = (
  host: string = DEFAULT_BRIDGE_HOST,
  port: number = DEFAULT_BRIDGE_PORT,
): string => `ws://${host}:${port}`;

/**
 * SQLite write batching interval in ms — events accumulate in memory and
 * flush together. See CLAUDE.md "Performance Budgets".
 */
export const SQLITE_FLUSH_INTERVAL_MS = 100;

/** Heartbeat interval in ms for keeping idle WebSocket connections alive. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/** Initial reconnect delay in ms for the WebSocket client. */
export const RECONNECT_INITIAL_DELAY_MS = 500;

/** Cap for exponential backoff in ms. */
export const RECONNECT_MAX_DELAY_MS = 15_000;

/** Maximum number of agent messages to keep in memory before dropping oldest. */
export const MAX_MESSAGE_HISTORY = 1_000;

/** Default UI source identifier when sending replay requests. */
export const SOURCE_UI = 'studio-ui';

/** Default plugin source identifier. */
export const SOURCE_PLUGIN = 'ruflo-plugin';

/** Default mock generator source identifier. */
export const SOURCE_MOCK = 'mock-generator';

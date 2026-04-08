/**
 * Agent Studio Ruflo plugin.
 *
 * Subscribes to the lifecycle hooks Ruflo emits during a swarm session and
 * forwards each one as a typed StudioEvent through the WebSocket bridge.
 *
 * Ruflo exposes its plugin system via a PluginBuilder API. Because that API
 * surface is still in flux upstream (see DECISIONS.md ADR-001), this module
 * keeps coupling to a single seam:
 *
 *   `attachToHookEmitter(emitter)`  — wires hook listeners onto any object
 *                                     that implements `HookEmitter`.
 *
 * The exported `createStudioPlugin()` returns a plugin descriptor that
 * Ruflo's loader can pick up; under the hood it just calls `attach`. If the
 * upstream API renames or restructures, only the descriptor wrapper has to
 * change. (Phase 1 — see PRODUCT_VISION.md for the full lifecycle goal.)
 */

import {
  type AgentInfo,
  type AgentMessage,
  type AgentState,
  type StudioEvent,
  type SwarmInfo,
  type TaskInfo,
  StudioError,
  createLogger,
} from '@agent-studio/shared';

import { StudioEventEmitter } from './event-emitter.js';
import {
  type HookEmitter,
  type HookPayload,
  RUFLO_HOOK_NAMES,
  coerceAgentType,
  coerceTopology,
} from './types.js';

const log = createLogger('ruflo-plugin');

interface PluginOptions {
  /** Override the bridge URL (defaults to ws://127.0.0.1:6747). */
  bridgeUrl?: string;
}

/** A Ruflo plugin descriptor — shape kept minimal so it survives upstream churn. */
export interface StudioPluginDescriptor {
  name: string;
  version: string;
  /** Called by Ruflo when the plugin is loaded. */
  setup(context: { hooks: HookEmitter }): Promise<void> | void;
  /** Called by Ruflo on shutdown. */
  teardown(): Promise<void> | void;
}

/** Build the plugin descriptor Ruflo's loader registers. */
export const createStudioPlugin = (options: PluginOptions = {}): StudioPluginDescriptor => {
  const emitter = new StudioEventEmitter({ url: options.bridgeUrl });
  let detach: (() => void) | null = null;

  return {
    name: 'agent-studio',
    version: '0.1.0',
    setup({ hooks }) {
      emitter.start();
      detach = attachToHookEmitter(hooks, emitter);
      log.info('plugin attached to ruflo hooks');
    },
    teardown() {
      detach?.();
      detach = null;
      emitter.close();
      log.info('plugin detached');
    },
  };
};

/**
 * Subscribe a fresh set of listeners to a HookEmitter and return a detach
 * function. Exposed for tests and for hosts that want to wire the plugin
 * up manually instead of going through the descriptor.
 */
export const attachToHookEmitter = (
  hooks: HookEmitter,
  emitter: StudioEventEmitter,
): (() => void) => {
  const listeners: Array<{ event: string; fn: (payload: unknown) => void }> = [];

  const subscribe = (event: string, fn: (payload: unknown) => void) => {
    hooks.on(event, fn);
    listeners.push({ event, fn });
  };

  const safeEmit = (event: StudioEvent) => {
    try {
      emitter.emit(event);
    } catch (err) {
      if (err instanceof StudioError) {
        log.warn('dropped invalid event', { code: err.code, type: event.type });
      } else {
        log.error('emit failed', { error: String(err), type: event.type });
      }
    }
  };

  // ── swarm lifecycle ────────────────────────────────────────────────────────
  subscribe(RUFLO_HOOK_NAMES.SWARM_INITIALIZED, (raw) => {
    const swarm = parseSwarmInfo(raw);
    if (!swarm) return;
    safeEmit({ type: 'swarm:initialized', timestamp: Date.now(), swarm });
  });

  subscribe(RUFLO_HOOK_NAMES.SWARM_SHUTDOWN, (raw) => {
    const payload = asRecord(raw);
    const swarmId = stringField(payload, 'swarmId') ?? stringField(payload, 'id');
    if (!swarmId) return;
    safeEmit({ type: 'swarm:shutdown', timestamp: Date.now(), swarmId });
  });

  // ── agent lifecycle ────────────────────────────────────────────────────────
  // We forward only post-spawn / post-terminate so the UI never sees an agent
  // mid-creation. The pre-* hooks are still subscribed in case we need them
  // for analytics later.
  subscribe(RUFLO_HOOK_NAMES.AGENT_PRE_SPAWN, () => {
    /* observed for completeness — no UI event emitted */
  });

  subscribe(RUFLO_HOOK_NAMES.AGENT_POST_SPAWN, (raw) => {
    const agent = parseAgentInfo(raw);
    if (!agent) return;
    safeEmit({ type: 'agent:spawned', timestamp: Date.now(), agent });
  });

  subscribe(RUFLO_HOOK_NAMES.AGENT_PRE_TERMINATE, () => {
    /* observed for completeness — no UI event emitted */
  });

  subscribe(RUFLO_HOOK_NAMES.AGENT_POST_TERMINATE, (raw) => {
    const payload = asRecord(raw);
    const agentId = stringField(payload, 'agentId') ?? stringField(payload, 'id');
    if (!agentId) return;
    safeEmit({
      type: 'agent:terminated',
      timestamp: Date.now(),
      agentId,
      reason: stringField(payload, 'reason'),
    });
  });

  subscribe(RUFLO_HOOK_NAMES.AGENT_STATE_CHANGED, (raw) => {
    const payload = asRecord(raw);
    const agentId = stringField(payload, 'agentId');
    const previousState = parseAgentState(stringField(payload, 'previousState'));
    const newState = parseAgentState(stringField(payload, 'newState'));
    if (!agentId || !previousState || !newState) return;
    safeEmit({
      type: 'agent:state-changed',
      timestamp: Date.now(),
      agentId,
      previousState,
      newState,
    });
  });

  subscribe(RUFLO_HOOK_NAMES.AGENT_MESSAGE, (raw) => {
    const message = parseAgentMessage(raw);
    if (!message) return;
    safeEmit({ type: 'message:sent', timestamp: Date.now(), message });
  });

  // ── task lifecycle ─────────────────────────────────────────────────────────
  subscribe(RUFLO_HOOK_NAMES.TASK_PRE_EXECUTE, (raw) => {
    const task = parseTaskInfo(raw, 'active');
    if (!task) return;
    safeEmit({ type: 'task:started', timestamp: Date.now(), task });
  });

  subscribe(RUFLO_HOOK_NAMES.TASK_POST_COMPLETE, (raw) => {
    const payload = asRecord(raw);
    const taskId = stringField(payload, 'taskId') ?? stringField(payload, 'id');
    if (!taskId) return;
    safeEmit({
      type: 'task:completed',
      timestamp: Date.now(),
      taskId,
      agentId: stringField(payload, 'agentId'),
    });
  });

  subscribe(RUFLO_HOOK_NAMES.TASK_ERROR, (raw) => {
    const payload = asRecord(raw);
    const taskId = stringField(payload, 'taskId') ?? stringField(payload, 'id');
    if (!taskId) return;
    safeEmit({
      type: 'task:failed',
      timestamp: Date.now(),
      taskId,
      agentId: stringField(payload, 'agentId'),
      error: stringField(payload, 'error') ?? 'unknown error',
    });
  });

  return () => {
    for (const { event, fn } of listeners) {
      const off = hooks.off ?? hooks.removeListener;
      off?.call(hooks, event, fn);
    }
    listeners.length = 0;
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Defensive parsers — Ruflo payloads are unknown shapes; we narrow carefully
// rather than trusting the cast.
// ─────────────────────────────────────────────────────────────────────────────

const asRecord = (raw: unknown): HookPayload =>
  raw && typeof raw === 'object' ? (raw as HookPayload) : {};

const stringField = (payload: HookPayload, key: string): string | null => {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

const numberField = (payload: HookPayload, key: string): number | null => {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

const parseAgentState = (raw: string | null): AgentState | null => {
  if (!raw) return null;
  if (
    raw === 'idle' ||
    raw === 'planning' ||
    raw === 'coding' ||
    raw === 'testing' ||
    raw === 'blocked' ||
    raw === 'error' ||
    raw === 'communicating'
  ) {
    return raw;
  }
  return null;
};

const parseAgentInfo = (raw: unknown): AgentInfo | null => {
  const p = asRecord(raw);
  const id = stringField(p, 'id') ?? stringField(p, 'agentId');
  if (!id) return null;
  const positionRaw = asRecord(p['position']);
  return {
    id,
    name: stringField(p, 'name') ?? id,
    type: coerceAgentType(p['type']),
    state: parseAgentState(stringField(p, 'state')) ?? 'idle',
    currentTask: stringField(p, 'currentTask'),
    spawnedAt: numberField(p, 'spawnedAt') ?? Date.now(),
    position: {
      x: numberField(positionRaw, 'x') ?? 0,
      y: numberField(positionRaw, 'y') ?? 0,
    },
  };
};

const parseTaskInfo = (raw: unknown, defaultStatus: TaskInfo['status']): TaskInfo | null => {
  const p = asRecord(raw);
  const id = stringField(p, 'id') ?? stringField(p, 'taskId');
  if (!id) return null;
  const statusRaw = stringField(p, 'status');
  const status: TaskInfo['status'] =
    statusRaw === 'pending' ||
    statusRaw === 'active' ||
    statusRaw === 'complete' ||
    statusRaw === 'failed'
      ? statusRaw
      : defaultStatus;
  return {
    id,
    description: stringField(p, 'description') ?? '',
    assignedAgent: stringField(p, 'assignedAgent') ?? stringField(p, 'agentId'),
    status,
    startedAt: numberField(p, 'startedAt'),
    completedAt: numberField(p, 'completedAt'),
  };
};

const parseSwarmInfo = (raw: unknown): SwarmInfo | null => {
  const p = asRecord(raw);
  const id = stringField(p, 'id') ?? stringField(p, 'swarmId');
  if (!id) return null;
  return {
    id,
    topology: coerceTopology(p['topology']),
    agentCount: numberField(p, 'agentCount') ?? 0,
    status: 'active',
    startedAt: numberField(p, 'startedAt') ?? Date.now(),
  };
};

const parseAgentMessage = (raw: unknown): AgentMessage | null => {
  const p = asRecord(raw);
  const fromAgent = stringField(p, 'fromAgent') ?? stringField(p, 'from');
  const toAgent = stringField(p, 'toAgent') ?? stringField(p, 'to');
  const content = stringField(p, 'content') ?? stringField(p, 'message');
  if (!fromAgent || !toAgent || !content) return null;
  return {
    id: stringField(p, 'id') ?? `${fromAgent}->${toAgent}@${Date.now()}`,
    fromAgent,
    toAgent,
    content,
    timestamp: numberField(p, 'timestamp') ?? Date.now(),
  };
};

// Re-export the seam for embedders that build their own descriptor.
export { StudioEventEmitter } from './event-emitter.js';
export type { HookEmitter, HookPayload, RufloHookName } from './types.js';

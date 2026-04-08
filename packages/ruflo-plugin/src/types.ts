/**
 * Plugin-local types — the contract between Ruflo's hook system and our
 * StudioEvent envelopes.
 *
 * Ruflo's hook payloads are loosely typed `Record<string, unknown>` shapes
 * documented in its plugin reference. We treat them as `unknown` here and
 * narrow defensively in `index.ts` rather than coupling to upstream types.
 */

import { type AgentType, type SwarmTopology } from '@agent-studio/shared';

/** Subset of an EventEmitter we actually use — keeps Ruflo coupling minimal. */
export interface HookEmitter {
  on(event: string, listener: (payload: unknown) => void): unknown;
  off?(event: string, listener: (payload: unknown) => void): unknown;
  removeListener?(event: string, listener: (payload: unknown) => void): unknown;
}

/**
 * Hook event names emitted by Ruflo. Mirrors the lifecycle hooks listed in
 * Ruflo's plugin documentation.
 */
export const RUFLO_HOOK_NAMES = {
  AGENT_PRE_SPAWN: 'agent:pre-spawn',
  AGENT_POST_SPAWN: 'agent:post-spawn',
  AGENT_PRE_TERMINATE: 'agent:pre-terminate',
  AGENT_POST_TERMINATE: 'agent:post-terminate',
  TASK_PRE_EXECUTE: 'task:pre-execute',
  TASK_POST_COMPLETE: 'task:post-complete',
  TASK_ERROR: 'task:error',
  SWARM_INITIALIZED: 'swarm:initialized',
  SWARM_SHUTDOWN: 'swarm:shutdown',
  AGENT_STATE_CHANGED: 'agent:state-changed',
  AGENT_MESSAGE: 'agent:message',
} as const;

export type RufloHookName = (typeof RUFLO_HOOK_NAMES)[keyof typeof RUFLO_HOOK_NAMES];

/** Loose record we read hook fields out of. */
export type HookPayload = Record<string, unknown>;

/** Mapping helpers — narrow Ruflo strings into our enum values. */
export const coerceAgentType = (raw: unknown): AgentType => {
  if (raw === 'coder' || raw === 'architect' || raw === 'tester' || raw === 'researcher' || raw === 'coordinator') {
    return raw;
  }
  return 'coder';
};

export const coerceTopology = (raw: unknown): SwarmTopology => {
  if (raw === 'hierarchical' || raw === 'mesh' || raw === 'ring' || raw === 'star') {
    return raw;
  }
  return 'mesh';
};

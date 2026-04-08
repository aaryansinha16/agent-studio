/**
 * Core domain types for Agent Studio.
 *
 * These types are the contract between the Ruflo plugin (producer),
 * the event bridge (broker), and the studio UI (consumer). They are
 * all derived from / mirrored by Zod schemas in `./schemas.ts`.
 */

/** Lifecycle state of a single agent in the visual workspace. */
export const AgentState = {
  IDLE: 'idle',
  PLANNING: 'planning',
  CODING: 'coding',
  TESTING: 'testing',
  BLOCKED: 'blocked',
  ERROR: 'error',
  COMMUNICATING: 'communicating',
} as const;
export type AgentState = (typeof AgentState)[keyof typeof AgentState];

/** Role/archetype an agent plays in the swarm. */
export const AgentType = {
  CODER: 'coder',
  ARCHITECT: 'architect',
  TESTER: 'tester',
  RESEARCHER: 'researcher',
  COORDINATOR: 'coordinator',
} as const;
export type AgentType = (typeof AgentType)[keyof typeof AgentType];

/** Lifecycle state of a single task. */
export const TaskStatus = {
  PENDING: 'pending',
  ACTIVE: 'active',
  COMPLETE: 'complete',
  FAILED: 'failed',
} as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

/** Topology of a swarm — controls how agents are arranged in the workspace. */
export const SwarmTopology = {
  HIERARCHICAL: 'hierarchical',
  MESH: 'mesh',
  RING: 'ring',
  STAR: 'star',
} as const;
export type SwarmTopology = (typeof SwarmTopology)[keyof typeof SwarmTopology];

/** Lifecycle state of the active swarm. */
export const SwarmStatus = {
  INITIALIZING: 'initializing',
  ACTIVE: 'active',
  IDLE: 'idle',
  SHUTDOWN: 'shutdown',
} as const;
export type SwarmStatus = (typeof SwarmStatus)[keyof typeof SwarmStatus];

/** Position on the isometric grid (Phase 2 — used by Pixi.js renderer). */
export interface GridPosition {
  x: number;
  y: number;
}

/** Information about a single agent. */
export interface AgentInfo {
  id: string;
  name: string;
  type: AgentType;
  state: AgentState;
  /** ID of the task currently assigned to this agent, if any. */
  currentTask: string | null;
  /** Unix epoch ms when the agent was spawned. */
  spawnedAt: number;
  /** Position on the isometric grid for the visual workspace. */
  position: GridPosition;
}

/** Information about a single task. */
export interface TaskInfo {
  id: string;
  description: string;
  /** ID of the agent the task is assigned to, if any. */
  assignedAgent: string | null;
  status: TaskStatus;
  /** Unix epoch ms when the task entered ACTIVE status. */
  startedAt: number | null;
  /** Unix epoch ms when the task entered COMPLETE or FAILED status. */
  completedAt: number | null;
}

/** A message exchanged between two agents. */
export interface AgentMessage {
  id: string;
  fromAgent: string;
  toAgent: string;
  content: string;
  /** Unix epoch ms when the message was sent. */
  timestamp: number;
}

/** Information about the active swarm. */
export interface SwarmInfo {
  id: string;
  topology: SwarmTopology;
  agentCount: number;
  status: SwarmStatus;
  /** Unix epoch ms when the swarm was initialized. */
  startedAt: number;
}

/** A snapshot of the entire world state — sent on initial UI connect. */
export interface WorldSnapshot {
  agents: AgentInfo[];
  tasks: TaskInfo[];
  messages: AgentMessage[];
  swarm: SwarmInfo | null;
  /** Unix epoch ms when the snapshot was captured. */
  snapshotAt: number;
}

/**
 * A single-line record of a past chat launch — mirrored between the
 * studio-ui store and the persisted project row so history survives
 * app restarts.
 */
export interface ChatHistoryRecord {
  id: number;
  prompt: string;
  agentCount: number;
  strategy: string;
  command: string;
  swarmId: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: number;
  note?: string;
}

/**
 * Persistent per-project session — folder identity + chat history.
 * The bridge owns the source of truth in its SQLite file; the studio
 * store holds a local cache populated at startup.
 */
export interface ProjectSession {
  /** Deterministic id derived from the folder path. */
  id: string;
  folderPath: string;
  folderName: string;
  /** Detected primary stack (node/rust/python/...). */
  stack: string;
  gitBranch: string | null;
  /** Unix epoch ms of the most recent open. */
  lastOpened: number;
  /** Full chat history for the project, newest first. */
  chatHistory: ChatHistoryRecord[];
}

// ─────────────────────────────────────────────────────────────────────────────
// StudioEvent — discriminated union of every event flowing through the system.
// Producers (plugin, mock generator) emit these. The bridge applies them to
// state. The UI subscribes to them.
// ─────────────────────────────────────────────────────────────────────────────

interface BaseEvent {
  /** Unix epoch ms when the event was emitted by the producer. */
  timestamp: number;
}

export interface AgentSpawnedEvent extends BaseEvent {
  type: 'agent:spawned';
  agent: AgentInfo;
}

export interface AgentStateChangedEvent extends BaseEvent {
  type: 'agent:state-changed';
  agentId: string;
  previousState: AgentState;
  newState: AgentState;
  /**
   * Optional human-readable explanation for the transition.
   * Used primarily for BLOCKED/ERROR states (e.g. "Waiting on /auth endpoint").
   */
  reason?: string | null;
}

export interface AgentTerminatedEvent extends BaseEvent {
  type: 'agent:terminated';
  agentId: string;
  reason: string | null;
}

export interface TaskStartedEvent extends BaseEvent {
  type: 'task:started';
  task: TaskInfo;
}

export interface TaskCompletedEvent extends BaseEvent {
  type: 'task:completed';
  taskId: string;
  agentId: string | null;
}

export interface TaskFailedEvent extends BaseEvent {
  type: 'task:failed';
  taskId: string;
  agentId: string | null;
  error: string;
}

export interface SwarmInitializedEvent extends BaseEvent {
  type: 'swarm:initialized';
  swarm: SwarmInfo;
}

export interface SwarmShutdownEvent extends BaseEvent {
  type: 'swarm:shutdown';
  swarmId: string;
}

export interface MessageSentEvent extends BaseEvent {
  type: 'message:sent';
  message: AgentMessage;
}

/** Discriminated union of every event type the system can emit. */
export type StudioEvent =
  | AgentSpawnedEvent
  | AgentStateChangedEvent
  | AgentTerminatedEvent
  | TaskStartedEvent
  | TaskCompletedEvent
  | TaskFailedEvent
  | SwarmInitializedEvent
  | SwarmShutdownEvent
  | MessageSentEvent;

export type StudioEventType = StudioEvent['type'];

// ─────────────────────────────────────────────────────────────────────────────
// Wire protocol — what actually goes over the WebSocket.
// ─────────────────────────────────────────────────────────────────────────────

/** A producer (plugin/mock) sends an event to the bridge. */
export interface EventEnvelope {
  kind: 'event';
  /** Identifies the producer for debugging (e.g. 'ruflo-plugin', 'mock'). */
  source: string;
  event: StudioEvent;
}

/** A consumer (UI) requests a full state replay on connect. */
export interface ReplayRequest {
  kind: 'replay:request';
}

/** The bridge replies to ReplayRequest with the current world snapshot. */
export interface ReplayResponse {
  kind: 'replay:response';
  snapshot: WorldSnapshot;
}

/** Heartbeat to keep the WebSocket connection alive. */
export interface PingMessage {
  kind: 'ping';
  timestamp: number;
}

export interface PongMessage {
  kind: 'pong';
  timestamp: number;
}

/** A consumer asks the bridge for the full list of persisted projects. */
export interface ProjectsListRequest {
  kind: 'projects:list-request';
}

/** Bridge's reply to a projects:list-request. */
export interface ProjectsListResponse {
  kind: 'projects:list-response';
  projects: ProjectSession[];
}

/**
 * A consumer tells the bridge to upsert a project row. Fire-and-forget;
 * the bridge acks via the next `projects:list-response` it sends.
 */
export interface ProjectSaveRequest {
  kind: 'projects:save';
  project: ProjectSession;
}

/** Every message that can flow over the WebSocket, in either direction. */
export type WireMessage =
  | EventEnvelope
  | ReplayRequest
  | ReplayResponse
  | PingMessage
  | PongMessage
  | ProjectsListRequest
  | ProjectsListResponse
  | ProjectSaveRequest;

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

/** Structured error class with machine-readable code and context payload. */
export class StudioError extends Error {
  public readonly code: string;
  public readonly context: Readonly<Record<string, unknown>>;

  constructor(
    code: string,
    options: { message?: string; cause?: unknown; context?: Record<string, unknown> } = {},
  ) {
    super(options.message ?? code, { cause: options.cause });
    this.name = 'StudioError';
    this.code = code;
    this.context = Object.freeze({ ...(options.context ?? {}) });
  }
}

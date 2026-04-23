/**
 * Zod schemas — runtime validation for every type that crosses a process
 * boundary (WebSocket, SQLite, JSON import/export).
 *
 * The TypeScript types in `./types.ts` are the canonical contract; the schemas
 * here mirror them. Use `z.infer<typeof X>` to derive types from schemas in
 * places that need parsing.
 */

import { z } from 'zod';

import { AgentState, AgentType, TaskStatus, SwarmTopology, SwarmStatus } from './types.js';

const enumValues = <T extends Record<string, string>>(obj: T) =>
  Object.values(obj) as [T[keyof T], ...T[keyof T][]];

export const AgentStateSchema = z.enum(enumValues(AgentState));
export const AgentTypeSchema = z.enum(enumValues(AgentType));
export const TaskStatusSchema = z.enum(enumValues(TaskStatus));
export const SwarmTopologySchema = z.enum(enumValues(SwarmTopology));
export const SwarmStatusSchema = z.enum(enumValues(SwarmStatus));

export const GridPositionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

export const AgentInfoSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: AgentTypeSchema,
  state: AgentStateSchema,
  currentTask: z.string().nullable(),
  spawnedAt: z.number().int().nonnegative(),
  position: GridPositionSchema,
});

export const TaskInfoSchema = z.object({
  id: z.string().min(1),
  description: z.string(),
  assignedAgent: z.string().nullable(),
  status: TaskStatusSchema,
  startedAt: z.number().int().nonnegative().nullable(),
  completedAt: z.number().int().nonnegative().nullable(),
});

export const AgentMessageSchema = z.object({
  id: z.string().min(1),
  fromAgent: z.string().min(1),
  toAgent: z.string().min(1),
  content: z.string(),
  timestamp: z.number().int().nonnegative(),
});

export const SwarmInfoSchema = z.object({
  id: z.string().min(1),
  topology: SwarmTopologySchema,
  agentCount: z.number().int().nonnegative(),
  status: SwarmStatusSchema,
  startedAt: z.number().int().nonnegative(),
});

export const ProducerOriginSchema = z.enum(['ruflo', 'orchestrator', 'mock']);

export const WorldSnapshotSchema = z.object({
  agents: z.array(AgentInfoSchema),
  tasks: z.array(TaskInfoSchema),
  messages: z.array(AgentMessageSchema),
  swarm: SwarmInfoSchema.nullable(),
  activeProducer: ProducerOriginSchema.nullable(),
  snapshotAt: z.number().int().nonnegative(),
});

export const ChatHistoryRecordSchema = z.object({
  id: z.number().int(),
  prompt: z.string(),
  agentCount: z.number().int().nonnegative(),
  strategy: z.string(),
  command: z.string(),
  swarmId: z.string(),
  status: z.enum(['running', 'completed', 'failed']),
  startedAt: z.number().int().nonnegative(),
  note: z.string().optional(),
});

export const ProjectSessionSchema = z.object({
  id: z.string().min(1),
  folderPath: z.string().min(1),
  folderName: z.string().min(1),
  stack: z.string(),
  gitBranch: z.string().nullable(),
  lastOpened: z.number().int().nonnegative(),
  chatHistory: z.array(ChatHistoryRecordSchema),
});

// ─────────────────────────────────────────────────────────────────────────────
// StudioEvent schemas
// ─────────────────────────────────────────────────────────────────────────────

const baseEvent = { timestamp: z.number().int().nonnegative() };

export const AgentSpawnedEventSchema = z.object({
  ...baseEvent,
  type: z.literal('agent:spawned'),
  agent: AgentInfoSchema,
});

export const AgentStateChangedEventSchema = z.object({
  ...baseEvent,
  type: z.literal('agent:state-changed'),
  agentId: z.string().min(1),
  previousState: AgentStateSchema,
  newState: AgentStateSchema,
  reason: z.string().nullish(),
});

export const AgentTerminatedEventSchema = z.object({
  ...baseEvent,
  type: z.literal('agent:terminated'),
  agentId: z.string().min(1),
  reason: z.string().nullable(),
});

export const TaskStartedEventSchema = z.object({
  ...baseEvent,
  type: z.literal('task:started'),
  task: TaskInfoSchema,
});

export const TaskCompletedEventSchema = z.object({
  ...baseEvent,
  type: z.literal('task:completed'),
  taskId: z.string().min(1),
  agentId: z.string().nullable(),
});

export const TaskFailedEventSchema = z.object({
  ...baseEvent,
  type: z.literal('task:failed'),
  taskId: z.string().min(1),
  agentId: z.string().nullable(),
  error: z.string(),
});

export const SwarmInitializedEventSchema = z.object({
  ...baseEvent,
  type: z.literal('swarm:initialized'),
  swarm: SwarmInfoSchema,
});

export const SwarmShutdownEventSchema = z.object({
  ...baseEvent,
  type: z.literal('swarm:shutdown'),
  swarmId: z.string().min(1),
});

export const MessageSentEventSchema = z.object({
  ...baseEvent,
  type: z.literal('message:sent'),
  message: AgentMessageSchema,
});

export const AgentLogEventSchema = z.object({
  ...baseEvent,
  type: z.literal('agent:log'),
  agentId: z.string().nullable(),
  line: z.string(),
  level: z.enum(['info', 'warn', 'error']),
  source: z.enum(['ruflo-stdout', 'ruflo-stderr', 'system']),
});

export const FileChangedEventSchema = z.object({
  ...baseEvent,
  type: z.literal('file:changed'),
  filePath: z.string().min(1),
  changeType: z.enum(['create', 'modify', 'delete']),
  swarmId: z.string().min(1),
});

export const TokenUsageSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative(),
  cacheWriteTokens: z.number().nonnegative(),
  totalTokens: z.number().nonnegative(),
  estimatedCostUsd: z.number().nonnegative(),
});

export const MetricsUpdateEventSchema = z.object({
  ...baseEvent,
  type: z.literal('metrics:update'),
  agentId: z.string().nullable(),
  swarmId: z.string().min(1),
  model: z.string().nullable(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
});

export const StudioEventSchema = z.discriminatedUnion('type', [
  AgentSpawnedEventSchema,
  AgentStateChangedEventSchema,
  AgentTerminatedEventSchema,
  TaskStartedEventSchema,
  TaskCompletedEventSchema,
  TaskFailedEventSchema,
  SwarmInitializedEventSchema,
  SwarmShutdownEventSchema,
  MessageSentEventSchema,
  AgentLogEventSchema,
  FileChangedEventSchema,
  MetricsUpdateEventSchema,
]);

// ─────────────────────────────────────────────────────────────────────────────
// Wire protocol schemas
// ─────────────────────────────────────────────────────────────────────────────

export const EventEnvelopeSchema = z.object({
  kind: z.literal('event'),
  source: z.string().min(1),
  event: StudioEventSchema,
});

export const HelloMessageSchema = z.object({
  kind: z.literal('hello'),
  origin: ProducerOriginSchema,
  label: z.string().optional(),
});

export const ProducerActiveMessageSchema = z.object({
  kind: z.literal('producer:active'),
  origin: ProducerOriginSchema.nullable(),
});

export const ReplayRequestSchema = z.object({
  kind: z.literal('replay:request'),
});

export const ReplayResponseSchema = z.object({
  kind: z.literal('replay:response'),
  snapshot: WorldSnapshotSchema,
});

export const PingMessageSchema = z.object({
  kind: z.literal('ping'),
  timestamp: z.number().int().nonnegative(),
});

export const PongMessageSchema = z.object({
  kind: z.literal('pong'),
  timestamp: z.number().int().nonnegative(),
});

export const ProjectsListRequestSchema = z.object({
  kind: z.literal('projects:list-request'),
});

export const ProjectsListResponseSchema = z.object({
  kind: z.literal('projects:list-response'),
  projects: z.array(ProjectSessionSchema),
});

export const ProjectSaveRequestSchema = z.object({
  kind: z.literal('projects:save'),
  project: ProjectSessionSchema,
});

export const WireMessageSchema = z.discriminatedUnion('kind', [
  EventEnvelopeSchema,
  HelloMessageSchema,
  ProducerActiveMessageSchema,
  ReplayRequestSchema,
  ReplayResponseSchema,
  PingMessageSchema,
  PongMessageSchema,
  ProjectsListRequestSchema,
  ProjectsListResponseSchema,
  ProjectSaveRequestSchema,
]);

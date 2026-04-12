/**
 * In-memory world state for Agent Studio with batched SQLite persistence.
 *
 * Design notes:
 * - All real-time reads (getFullState, getAgentHistory) are served from
 *   in-memory Maps so the UI never blocks on disk I/O.
 * - Writes are queued and flushed every SQLITE_FLUSH_INTERVAL_MS (100ms),
 *   per the performance budget in CLAUDE.md.
 * - The raw event log persisted to SQLite is the source of truth for replay
 *   and crash recovery; on startup we could rehydrate from it (Phase 4).
 */

import path from 'node:path';
import fs from 'node:fs';

import Database from 'better-sqlite3';
import type { Database as SqliteDatabase, Statement } from 'better-sqlite3';

import {
  type AgentInfo,
  type AgentMessage,
  type ProjectSession,
  type StudioEvent,
  type SwarmInfo,
  type TaskInfo,
  type WorldSnapshot,
  MAX_MESSAGE_HISTORY,
  SQLITE_FLUSH_INTERVAL_MS,
  StudioError,
  createLogger,
} from '@agent-studio/shared';

const log = createLogger('event-bridge:state-store');

interface StateStoreOptions {
  /** Absolute path to the SQLite file. Defaults to `./data/agent-studio.sqlite`. */
  databasePath?: string;
  /** If true, runs SQLite entirely in memory (used by tests). */
  inMemory?: boolean;
}

/**
 * The mutable world state owned by the bridge.
 *
 * Producers (plugin, mock generator) push StudioEvents in via `applyEvent`.
 * Consumers (UI clients) read via `getFullState` / `getAgentHistory`.
 */
export class StateStore {
  private readonly agents = new Map<string, AgentInfo>();
  private readonly tasks = new Map<string, TaskInfo>();
  private readonly messages: AgentMessage[] = [];
  private swarm: SwarmInfo | null = null;

  /** Per-agent ordered event history, used for session replay. */
  private readonly agentHistory = new Map<string, StudioEvent[]>();

  private readonly db: SqliteDatabase;
  private readonly insertEventStmt: Statement<[string, number, string]>;
  private readonly upsertProjectStmt: Statement<
    [string, string, string, string, string | null, number, string]
  >;
  private readonly selectProjectsStmt: Statement<[]>;
  private readonly pendingEvents: StudioEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(options: StateStoreOptions = {}) {
    const dbPath = options.inMemory
      ? ':memory:'
      : (options.databasePath ?? path.resolve(process.cwd(), 'data', 'agent-studio.sqlite'));

    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      fs.mkdirSync(dir, { recursive: true });
    }

    try {
      this.db = new Database(dbPath);
    } catch (cause) {
      throw new StudioError('STATE_STORE_OPEN_FAILED', {
        message: `Failed to open SQLite database at ${dbPath}`,
        cause,
        context: { dbPath },
      });
    }

    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events (timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events (type);

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        folder_path TEXT UNIQUE,
        folder_name TEXT,
        stack TEXT,
        git_branch TEXT,
        last_opened INTEGER,
        chat_history TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_projects_last_opened ON projects (last_opened DESC);
    `);

    this.insertEventStmt = this.db.prepare(
      'INSERT INTO events (type, timestamp, payload) VALUES (?, ?, ?)',
    );

    this.upsertProjectStmt = this.db.prepare(`
      INSERT INTO projects (id, folder_path, folder_name, stack, git_branch, last_opened, chat_history)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        folder_path = excluded.folder_path,
        folder_name = excluded.folder_name,
        stack = excluded.stack,
        git_branch = excluded.git_branch,
        last_opened = excluded.last_opened,
        chat_history = excluded.chat_history
    `);
    this.selectProjectsStmt = this.db.prepare(
      'SELECT id, folder_path, folder_name, stack, git_branch, last_opened, chat_history FROM projects ORDER BY last_opened DESC',
    );

    this.scheduleFlush();
    log.info('state store initialized', { dbPath });
  }

  /**
   * Apply an event to in-memory state and queue it for SQLite persistence.
   * Returns true if the event was applied; false if it was a no-op (e.g.
   * a state-changed event for an unknown agent).
   */
  applyEvent(event: StudioEvent): boolean {
    const applied = this.mutate(event);
    if (applied) {
      this.pendingEvents.push(event);
      this.recordHistory(event);
    }
    return applied;
  }

  /** Snapshot the entire world state — used to bootstrap newly connected UI clients. */
  getFullState(): WorldSnapshot {
    return {
      agents: Array.from(this.agents.values()),
      tasks: Array.from(this.tasks.values()),
      messages: [...this.messages],
      swarm: this.swarm,
      snapshotAt: Date.now(),
    };
  }

  /** All events ever observed for a given agent, in arrival order. */
  getAgentHistory(agentId: string): StudioEvent[] {
    return [...(this.agentHistory.get(agentId) ?? [])];
  }

  /** Returns counts useful for the SwarmOverview panel. */
  getCounts(): { agents: number; tasks: number; messages: number } {
    return {
      agents: this.agents.size,
      tasks: this.tasks.size,
      messages: this.messages.length,
    };
  }

  /** Insert or update a project row. */
  upsertProject(project: ProjectSession): void {
    try {
      this.upsertProjectStmt.run(
        project.id,
        project.folderPath,
        project.folderName,
        project.stack,
        project.gitBranch,
        project.lastOpened,
        JSON.stringify(project.chatHistory),
      );
    } catch (err) {
      log.warn('upsertProject failed', {
        id: project.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Return all persisted projects, most recently opened first. */
  listProjects(): ProjectSession[] {
    try {
      const rows = this.selectProjectsStmt.all() as Array<{
        id: string;
        folder_path: string;
        folder_name: string;
        stack: string;
        git_branch: string | null;
        last_opened: number;
        chat_history: string;
      }>;
      return rows.map((row) => ({
        id: row.id,
        folderPath: row.folder_path,
        folderName: row.folder_name,
        stack: row.stack,
        gitBranch: row.git_branch,
        lastOpened: row.last_opened,
        chatHistory: safeParseHistory(row.chat_history),
      }));
    } catch (err) {
      log.warn('listProjects failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /** Flush pending writes immediately and release resources. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      this.flushPending();
    } catch (err) {
      log.error('final flush failed', { error: String(err) });
    }
    this.db.close();
    log.info('state store closed');
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Internals
  // ───────────────────────────────────────────────────────────────────────────

  private scheduleFlush(): void {
    this.flushTimer = setInterval(() => {
      try {
        this.flushPending();
      } catch (err) {
        log.error('scheduled flush failed', { error: String(err) });
      }
    }, SQLITE_FLUSH_INTERVAL_MS);
    // Don't keep the Node process alive just for the flush timer.
    this.flushTimer.unref?.();
  }

  private flushPending(): void {
    if (this.pendingEvents.length === 0) return;
    const batch = this.pendingEvents.splice(0, this.pendingEvents.length);
    const insertMany = this.db.transaction((events: StudioEvent[]) => {
      for (const event of events) {
        this.insertEventStmt.run(event.type, event.timestamp, JSON.stringify(event));
      }
    });
    insertMany(batch);
  }

  private recordHistory(event: StudioEvent): void {
    const agentId = extractAgentId(event);
    if (!agentId) return;
    const list = this.agentHistory.get(agentId) ?? [];
    list.push(event);
    this.agentHistory.set(agentId, list);
  }

  /** Mutate in-memory state for one event. Pure of side effects beyond `this`. */
  private mutate(event: StudioEvent): boolean {
    switch (event.type) {
      case 'swarm:initialized': {
        this.swarm = event.swarm;
        return true;
      }
      case 'swarm:shutdown': {
        if (this.swarm && this.swarm.id === event.swarmId) {
          this.swarm = { ...this.swarm, status: 'shutdown' };
        }
        return true;
      }
      case 'agent:spawned': {
        this.agents.set(event.agent.id, event.agent);
        if (this.swarm) {
          this.swarm = { ...this.swarm, agentCount: this.agents.size };
        }
        return true;
      }
      case 'agent:state-changed': {
        const existing = this.agents.get(event.agentId);
        if (!existing) {
          log.warn('state-changed for unknown agent', { agentId: event.agentId });
          return false;
        }
        this.agents.set(event.agentId, { ...existing, state: event.newState });
        return true;
      }
      case 'agent:terminated': {
        const removed = this.agents.delete(event.agentId);
        if (removed && this.swarm) {
          this.swarm = { ...this.swarm, agentCount: this.agents.size };
        }
        return removed;
      }
      case 'task:started': {
        this.tasks.set(event.task.id, event.task);
        if (event.task.assignedAgent) {
          const agent = this.agents.get(event.task.assignedAgent);
          if (agent) {
            this.agents.set(agent.id, { ...agent, currentTask: event.task.id });
          }
        }
        return true;
      }
      case 'task:completed': {
        const task = this.tasks.get(event.taskId);
        if (!task) return false;
        this.tasks.set(event.taskId, {
          ...task,
          status: 'complete',
          completedAt: event.timestamp,
        });
        if (event.agentId) {
          const agent = this.agents.get(event.agentId);
          if (agent && agent.currentTask === event.taskId) {
            this.agents.set(agent.id, { ...agent, currentTask: null });
          }
        }
        return true;
      }
      case 'task:failed': {
        const task = this.tasks.get(event.taskId);
        if (!task) return false;
        this.tasks.set(event.taskId, {
          ...task,
          status: 'failed',
          completedAt: event.timestamp,
        });
        if (event.agentId) {
          const agent = this.agents.get(event.agentId);
          if (agent && agent.currentTask === event.taskId) {
            this.agents.set(agent.id, { ...agent, currentTask: null });
          }
        }
        return true;
      }
      case 'message:sent': {
        this.messages.push(event.message);
        if (this.messages.length > MAX_MESSAGE_HISTORY) {
          this.messages.splice(0, this.messages.length - MAX_MESSAGE_HISTORY);
        }
        return true;
      }
      case 'agent:log':
      case 'file:changed':
      case 'metrics:update': {
        // These events are forwarded to UI clients for display but do not
        // mutate the in-memory world state. The bridge just persists them
        // in the events table (via the pending-events queue) for replay.
        return true;
      }
      default: {
        // Exhaustiveness check — if a new StudioEvent variant is added without
        // updating this switch, TypeScript will fail to compile.
        const _exhaustive: never = event;
        return _exhaustive;
      }
    }
  }
}

/**
 * Safely parse a JSON-serialized chat history column. Returns an empty
 * array for any malformed input instead of throwing.
 */
const safeParseHistory = (raw: string | null): ProjectSession['chatHistory'] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
};

/** Extract the affected agent ID from any event, if applicable. */
const extractAgentId = (event: StudioEvent): string | null => {
  switch (event.type) {
    case 'agent:spawned':
      return event.agent.id;
    case 'agent:state-changed':
    case 'agent:terminated':
      return event.agentId;
    case 'task:started':
      return event.task.assignedAgent;
    case 'task:completed':
    case 'task:failed':
      return event.agentId;
    case 'message:sent':
      return event.message.fromAgent;
    default:
      return null;
  }
};

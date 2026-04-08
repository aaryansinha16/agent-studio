/**
 * Session manager — records every event with its arrival timestamp so the UI
 * can later replay (or export/import) entire swarm sessions.
 *
 * For Phase 1 the recorder lives entirely in memory; Phase 4 (PRODUCT_VISION
 * "Intelligence Layer") will lift these recordings out of SQLite via the
 * `events` table that StateStore already populates.
 */

import fs from 'node:fs';
import path from 'node:path';

import { type StudioEvent, StudioError, createLogger } from '@agent-studio/shared';

const log = createLogger('event-bridge:session');

/** A single recorded event with its server-side arrival timestamp. */
export interface RecordedEvent {
  /** Unix epoch ms when the event was received by the bridge. */
  receivedAt: number;
  event: StudioEvent;
}

/** Serializable form of a session — used for export/import as JSON. */
export interface SessionFile {
  version: 1;
  startedAt: number;
  endedAt: number | null;
  events: RecordedEvent[];
}

export class SessionRecorder {
  private readonly events: RecordedEvent[] = [];
  private readonly startedAt: number = Date.now();
  private endedAt: number | null = null;

  /** Append an event to the session log. */
  record(event: StudioEvent): void {
    if (this.endedAt !== null) {
      log.warn('record() called after stop(); ignoring event', { type: event.type });
      return;
    }
    this.events.push({ receivedAt: Date.now(), event });
  }

  /** Stop recording. Subsequent record() calls are no-ops. */
  stop(): void {
    if (this.endedAt === null) this.endedAt = Date.now();
  }

  /** Returns a defensive copy of the recorded session. */
  snapshot(): SessionFile {
    return {
      version: 1,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      events: this.events.map((e) => ({ ...e, event: e.event })),
    };
  }

  /** Number of events recorded so far. */
  get size(): number {
    return this.events.length;
  }

  /** Write the recorded session to disk as JSON. */
  exportToFile(filePath: string): void {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(this.snapshot(), null, 2), 'utf8');
      log.info('session exported', { filePath, events: this.events.length });
    } catch (cause) {
      throw new StudioError('SESSION_EXPORT_FAILED', {
        message: `Failed to export session to ${filePath}`,
        cause,
        context: { filePath },
      });
    }
  }

  /** Load a session previously written via exportToFile. */
  static importFromFile(filePath: string): SessionFile {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as SessionFile;
      if (parsed.version !== 1) {
        throw new StudioError('SESSION_VERSION_UNSUPPORTED', {
          message: `Session file version ${parsed.version} is not supported`,
          context: { filePath, version: parsed.version },
        });
      }
      return parsed;
    } catch (cause) {
      if (cause instanceof StudioError) throw cause;
      throw new StudioError('SESSION_IMPORT_FAILED', {
        message: `Failed to import session from ${filePath}`,
        cause,
        context: { filePath },
      });
    }
  }
}

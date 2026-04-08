/**
 * Minimal structured logger.
 *
 * Per CLAUDE.md / AGENTS.md, raw `console.log` is forbidden — every log line
 * must carry a level, a logger name, and an optional structured context.
 * The implementation here is intentionally tiny: it writes a single JSON line
 * per log call to stderr/stdout, which is trivially parseable by tooling and
 * doesn't compete with normal program output.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const resolveMinLevel = (): LogLevel => {
  const env =
    typeof process !== 'undefined' && process.env ? process.env.AGENT_STUDIO_LOG_LEVEL : undefined;
  if (env === 'debug' || env === 'info' || env === 'warn' || env === 'error') {
    return env;
  }
  return 'info';
};

const minLevel = resolveMinLevel();

const write = (level: LogLevel, name: string, message: string, context?: Record<string, unknown>) => {
  if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    name,
    message,
    ...(context ? { context } : {}),
  });
  // Use console.error for warn/error so it lands on stderr; info/debug to stdout.
  if (level === 'warn' || level === 'error') {
    // eslint-disable-next-line no-console
    console.error(line);
  } else {
    // eslint-disable-next-line no-console
    console.info(line);
  }
};

/** Create a logger scoped to a particular component (e.g. 'event-bridge'). */
export const createLogger = (name: string): Logger => ({
  debug: (message, context) => write('debug', name, message, context),
  info: (message, context) => write('info', name, message, context),
  warn: (message, context) => write('warn', name, message, context),
  error: (message, context) => write('error', name, message, context),
  child: (scope) => createLogger(`${name}:${scope}`),
});

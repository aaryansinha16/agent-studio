/**
 * Event-bridge process supervisor.
 *
 * Packaged builds and bare `npm run dev -w @agent-studio/electron-shell`
 * runs have no one to start the bridge. This module spawns it as a
 * child of Electron main, prefixes its stdout/stderr into the main log,
 * and kills it on quit. Dev flows that already run the bridge under
 * `concurrently` can opt out with `RUFLO_EXTERNAL_BRIDGE=1`.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import path from 'node:path'

import { createLogger } from '@agent-studio/shared'

const log = createLogger('electron-shell:bridge-process')

/** Time to wait for the bridge TCP port to accept a connection, in ms. */
const READY_TIMEOUT_MS = 10_000
const READY_PROBE_INTERVAL_MS = 200

export interface BridgeProcessOptions {
  host: string
  port: number
  /** Absolute path to the agent-studio repo root (one up from the app dir in dev). */
  repoRoot: string
}

export interface BridgeProcessHandle {
  /** Wait for the bridge to accept TCP connections; throws on timeout. */
  waitReady(): Promise<void>
  /** Kill the child process. Safe to call multiple times. */
  stop(): Promise<void>
}

const probePort = (host: string, port: number, timeoutMs: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = createConnection({ host, port, timeout: timeoutMs })
    const done = (ok: boolean): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(ok)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.once('timeout', () => done(false))
  })

const waitForPort = async (host: string, port: number): Promise<void> => {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await probePort(host, port, READY_PROBE_INTERVAL_MS)) return
    await new Promise((r) => setTimeout(r, READY_PROBE_INTERVAL_MS))
  }
  throw new Error(`bridge did not accept connections on ${host}:${port} within ${READY_TIMEOUT_MS}ms`)
}

const forwardStream = (stream: NodeJS.ReadableStream, level: 'info' | 'error'): void => {
  let buffer = ''
  stream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let idx: number
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trimEnd()
      buffer = buffer.slice(idx + 1)
      if (line.length === 0) continue
      if (level === 'error') log.error('[bridge] ' + line)
      else log.info('[bridge] ' + line)
    }
  })
}

/**
 * Start the event-bridge as a child process. In dev, uses tsx to run
 * the TypeScript entry directly; the path is resolved relative to
 * `repoRoot`. If a different invocation is needed (e.g. a packaged
 * build with a compiled bundle) the caller should opt out via
 * RUFLO_EXTERNAL_BRIDGE=1 and supervise the bridge themselves.
 */
export const startBridgeProcess = (opts: BridgeProcessOptions): BridgeProcessHandle => {
  const entry = path.join(opts.repoRoot, 'packages/event-bridge/src/server.ts')
  log.info('spawning event-bridge', { entry, host: opts.host, port: opts.port })

  const child: ChildProcess = spawn('npx', ['--yes', 'tsx', entry], {
    cwd: opts.repoRoot,
    env: {
      ...process.env,
      BRIDGE_HOST: opts.host,
      BRIDGE_PORT: String(opts.port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  if (child.stdout) forwardStream(child.stdout, 'info')
  if (child.stderr) forwardStream(child.stderr, 'error')

  child.on('exit', (code, signal) => {
    log.info('event-bridge exited', { code, signal })
  })
  child.on('error', (err) => {
    log.error('event-bridge spawn error', { error: err instanceof Error ? err.message : String(err) })
  })

  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    // Give it a moment, then SIGKILL if it hasn't gone.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill('SIGKILL')
          } catch {
            // already dead
          }
        }
        resolve()
      }, 2000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  return {
    waitReady: () => waitForPort(opts.host, opts.port),
    stop,
  }
}

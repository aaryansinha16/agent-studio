#!/usr/bin/env node
/**
 * agent-studio-hook — thin CLI wrapper around `claude-flow hooks <subcommand>`.
 *
 * Usage (installed via the user's .claude/settings.json hooks section):
 *
 *   "hooks": {
 *     "PostToolUse": [{
 *       "matcher": "Edit|Write",
 *       "hooks": [{ "type": "command",
 *                   "command": "npx @agent-studio/hooks-shim post-edit" }]
 *     }]
 *   }
 *
 * Two jobs per invocation:
 *   1. Spawn `claude-flow hooks <subcommand> <args>` and pipe its stdout
 *      and stderr through verbatim so Claude Code sees the same output
 *      the real Ruflo CLI would produce.
 *   2. In parallel, open a short-lived WebSocket to the Agent Studio
 *      event bridge, send `hello { origin: 'ruflo' }`, then one event
 *      envelope derived from the hook's arguments (e.g. post-edit
 *      → file:changed; pre-task → task:started).
 *
 * The shim exits with the same code the real CLI returned. If the
 * bridge is unreachable the shim still passes the CLI call through
 * cleanly — bridge connectivity is best-effort, never gating.
 *
 * Scope of this first cut: the six subcommands the Studio actually
 * renders in real-mode (pre/post edit, pre/post task, session
 * start/end). Any other subcommand is passed through without emitting
 * a bridge event.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import WebSocket from 'ws'

import type {
  EventEnvelope,
  HelloMessage,
  StudioEvent,
} from '@agent-studio/shared'

// The shim is a standalone CLI that has to run under plain `node`. We
// inline the two bridge defaults and the URL builder rather than
// importing them from @agent-studio/shared as values, because that
// package resolves to a TypeScript source file at runtime and plain
// Node ESM can't load .ts. Keeping these in lockstep with shared
// constants is trivial — they're just a host/port pair.
const DEFAULT_BRIDGE_HOST = '127.0.0.1'
const DEFAULT_BRIDGE_PORT = 6747
const defaultBridgeUrl = (host: string, port: number): string =>
  `ws://${host}:${port}`

/** Subset of hook subcommands that map to a StudioEvent. */
type KnownSubcommand =
  | 'pre-edit'
  | 'post-edit'
  | 'pre-task'
  | 'post-task'
  | 'session-start'
  | 'session-end'

/** Parse CLI args into a { subcommand, flags } pair. */
interface ParsedArgs {
  subcommand: string
  flags: Record<string, string>
  rest: string[]
}

const parseArgs = (argv: readonly string[]): ParsedArgs => {
  const [subcommand = '', ...rest] = argv
  const flags: Record<string, string> = {}
  const leftover: string[] = []
  for (let i = 0; i < rest.length; i += 1) {
    const tok = rest[i]!
    if (tok.startsWith('--')) {
      const name = tok.slice(2)
      const next = rest[i + 1]
      if (next && !next.startsWith('--')) {
        flags[name] = next
        i += 1
      } else {
        flags[name] = 'true'
      }
    } else {
      leftover.push(tok)
    }
  }
  return { subcommand, flags, rest: leftover }
}

const isKnownSubcommand = (sub: string): sub is KnownSubcommand =>
  sub === 'pre-edit' ||
  sub === 'post-edit' ||
  sub === 'pre-task' ||
  sub === 'post-task' ||
  sub === 'session-start' ||
  sub === 'session-end'

/**
 * Build the StudioEvent that corresponds to a hook invocation. Returns
 * null if the subcommand doesn't have a meaningful event (we pass the
 * CLI call through either way).
 *
 * We lean on the flags the Ruflo CLI itself accepts (e.g. --file,
 * --description, --result) so the shim stays a pure re-forward rather
 * than its own opinionated CLI.
 */
const buildEvent = (parsed: ParsedArgs, swarmId: string): StudioEvent | null => {
  const now = Date.now()
  switch (parsed.subcommand as KnownSubcommand) {
    case 'post-edit':
    case 'pre-edit': {
      const filePath = parsed.flags.file ?? parsed.flags.path
      if (!filePath) return null
      return {
        type: 'file:changed',
        timestamp: now,
        filePath,
        // Ruflo's pre-edit fires before the edit happens; we still log
        // it as 'modify' because the distinction only matters for the
        // change-type filter in the UI.
        changeType:
          parsed.subcommand === 'pre-edit'
            ? 'modify'
            : parsed.flags['operation'] === 'create'
              ? 'create'
              : parsed.flags['operation'] === 'delete'
                ? 'delete'
                : 'modify',
        swarmId,
      }
    }
    case 'pre-task': {
      const description = parsed.flags.description
      if (!description) return null
      const id = parsed.flags['task-id'] ?? `task-${randomUUID().slice(0, 8)}`
      return {
        type: 'task:started',
        timestamp: now,
        task: {
          id,
          description,
          assignedAgent: parsed.flags.agent ?? null,
          status: 'active',
          startedAt: now,
          completedAt: null,
        },
      }
    }
    case 'post-task': {
      const taskId = parsed.flags['task-id'] ?? parsed.flags.id
      if (!taskId) return null
      const failed = parsed.flags.result === 'failed' || parsed.flags.status === 'failed'
      if (failed) {
        return {
          type: 'task:failed',
          timestamp: now,
          taskId,
          agentId: parsed.flags.agent ?? null,
          error: parsed.flags.error ?? 'task failed',
        }
      }
      return {
        type: 'task:completed',
        timestamp: now,
        taskId,
        agentId: parsed.flags.agent ?? null,
      }
    }
    case 'session-start':
      // We don't have enough signal here to synthesize a
      // swarm:initialized event (no topology, no agent list). The
      // launch orchestrator emits that separately.
      return null
    case 'session-end':
      // Similar — swarm:shutdown is driven by the orchestrator.
      return null
  }
}

/**
 * Post one EventEnvelope to the bridge (with a hello upfront) and close.
 * All errors are logged to stderr but never rethrown — the shim's
 * primary job is to pass through the CLI call.
 */
const postToBridge = (event: StudioEvent): Promise<void> =>
  new Promise((resolve) => {
    const url = process.env.AGENT_STUDIO_BRIDGE_URL
      ?? defaultBridgeUrl(DEFAULT_BRIDGE_HOST, DEFAULT_BRIDGE_PORT)
    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    } catch {
      resolve()
      return
    }

    const timer = setTimeout(() => {
      try { socket.close() } catch { /* noop */ }
      resolve()
    }, 1500)

    socket.once('open', () => {
      try {
        const hello: HelloMessage = {
          kind: 'hello',
          origin: 'ruflo',
          label: '@agent-studio/hooks-shim',
        }
        socket.send(JSON.stringify(hello))
        const envelope: EventEnvelope = {
          kind: 'event',
          source: 'ruflo-hook-shim',
          event,
        }
        socket.send(JSON.stringify(envelope))
      } catch (err) {
        process.stderr.write(
          `[hooks-shim] send failed: ${err instanceof Error ? err.message : String(err)}\n`,
        )
      }
      // Give the send a beat to flush before closing.
      setTimeout(() => {
        try { socket.close() } catch { /* noop */ }
        clearTimeout(timer)
        resolve()
      }, 80)
    })

    socket.once('error', () => {
      // Bridge isn't up — that's fine, just skip.
      clearTimeout(timer)
      resolve()
    })
  })

/**
 * Forward the args verbatim to `claude-flow hooks <subcommand> ...`.
 * Returns the child's exit code.
 */
const passthroughToRuflo = (argv: readonly string[]): Promise<number> =>
  new Promise((resolve) => {
    const bin = process.env.AGENT_STUDIO_CLAUDE_FLOW_BIN ?? 'claude-flow'
    const child = spawn(bin, ['hooks', ...argv], {
      stdio: 'inherit',
    })
    child.on('exit', (code) => resolve(code ?? 0))
    child.on('error', (err) => {
      process.stderr.write(`[hooks-shim] failed to spawn ${bin}: ${err.message}\n`)
      resolve(1)
    })
  })

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2)
  if (argv.length === 0) {
    process.stderr.write('usage: agent-studio-hook <subcommand> [--flag value ...]\n')
    process.exit(64)
  }

  const parsed = parseArgs(argv)
  const swarmId = process.env.AGENT_STUDIO_SWARM_ID ?? 'swarm-unknown'

  // Build event (may be null for subcommands we don't map). Kick off
  // the bridge post immediately so it overlaps with the CLI child.
  const event = isKnownSubcommand(parsed.subcommand) ? buildEvent(parsed, swarmId) : null
  const bridgeTask = event ? postToBridge(event) : Promise.resolve()

  const [code] = await Promise.all([passthroughToRuflo(argv), bridgeTask])
  process.exit(code)
}

void main().catch((err: unknown) => {
  process.stderr.write(
    `[hooks-shim] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  )
  process.exit(1)
})

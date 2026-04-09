/**
 * Launch orchestrator — turns a `LaunchParams` payload from the studio
 * renderer into a stream of `StudioEvent`s pushed through the bridge.
 *
 * Two modes:
 *   - **mock** (current default): synthesize a believable swarm scenario
 *     locally, no Ruflo binary involved. Each launch becomes a fresh
 *     swarm with unique agent ids, so multiple launches can coexist with
 *     the standalone mock generator without ID collisions.
 *
 *   - **real** (future, gated by `RUFLO_REAL_MODE=1` env): spawn
 *     `npx ruflo swarm "<prompt>" --claude --agents <n> --strategy <s>
 *     --cwd <path>` as a child process and pipe its events through the
 *     ruflo plugin. Wired as a stub here that returns a clear "not
 *     supported yet" result. Phase 4 (PRODUCT_VISION.md) is when we
 *     actually flip this on.
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { watch, type FSWatcher } from 'node:fs'

import {
  type AgentInfo,
  type AgentState,
  type AgentType,
  type LaunchParams,
  type LaunchResult,
  type StudioEvent,
  type SwarmInfo,
  createLogger,
  distributeAgentRoles,
} from '@agent-studio/shared'

import type { BridgeClient } from './bridge-client.js'

const log = createLogger('electron-shell:launcher')

/** Max time, in ms, between scripted scenario steps when not in fast mode. */
const STEP_INTERVAL_MS = 800

interface LaunchOrchestratorOptions {
  bridgeClient: BridgeClient
  /** Override for testing — defaults to checking RUFLO_REAL_MODE env. */
  realMode?: boolean
}

/**
 * Singleton launcher. Constructed once at app startup; the IPC handler
 * calls `.launch()` for every studio request.
 */
/** Directories skipped by the file watcher to avoid noise. */
const WATCH_IGNORE = ['node_modules', '.git', 'dist', 'build', '.swarm', '__pycache__', '.venv', 'target', '.next']

export class LaunchOrchestrator {
  private readonly bridgeClient: BridgeClient
  private readonly realMode: boolean
  private launchCounter = 0
  private rufloAvailable: boolean | null = null
  /** Currently-running child process (real mode), null in mock mode. */
  private activeChild: ChildProcess | null = null
  private activeSwarmId: string | null = null
  /** File watcher for the workspace folder (real mode only). */
  private activeWatcher: FSWatcher | null = null

  constructor(options: LaunchOrchestratorOptions) {
    this.bridgeClient = options.bridgeClient
    this.realMode = options.realMode ?? process.env.RUFLO_REAL_MODE === '1'
  }

  /** Check if `ruflo` is reachable on this machine. Cached after first call. */
  checkRufloAvailability(): boolean {
    if (this.rufloAvailable !== null) return this.rufloAvailable
    try {
      execSync('npx ruflo --version', {
        timeout: 15_000,
        stdio: 'pipe',
        env: { ...process.env },
      })
      this.rufloAvailable = true
      log.info('Ruflo is available')
    } catch {
      this.rufloAvailable = false
      log.info('Ruflo not found — mock mode will be used')
    }
    return this.rufloAvailable
  }

  /** Whether a real swarm process is currently running. */
  get isRunning(): boolean {
    return this.activeChild !== null && !this.activeChild.killed
  }

  /** PID of the active child process, or null. */
  get activePid(): number | null {
    return this.activeChild?.pid ?? null
  }

  /**
   * Stop the currently-running swarm (if any). Sends SIGTERM to the
   * child process, emits swarm:shutdown, and tears down the file watcher.
   */
  stop(): void {
    if (this.activeChild && !this.activeChild.killed) {
      log.info('stopping swarm', { swarmId: this.activeSwarmId, pid: this.activeChild.pid })
      this.activeChild.kill('SIGTERM')
    }
    if (this.activeSwarmId) {
      this.emit({
        type: 'swarm:shutdown',
        timestamp: Date.now(),
        swarmId: this.activeSwarmId,
      })
    }
    this.teardownWatcher()
    this.activeChild = null
    this.activeSwarmId = null
  }

  /** Build the CLI command we *would* run if real mode were enabled. */
  buildCommand(params: LaunchParams): string {
    // Quote the prompt safely — escape backslashes and inner quotes.
    const safePrompt = params.prompt.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const parts = [
      'npx',
      'ruflo',
      'swarm',
      `"${safePrompt}"`,
      '--claude',
      '--agents',
      String(params.agentCount),
      '--strategy',
      params.strategy,
    ]
    if (params.workspacePath) {
      parts.push('--cwd', params.workspacePath)
    }
    return parts.join(' ')
  }

  /** Launch a swarm. Returns once the *initial* burst of events has been sent. */
  async launch(params: LaunchParams): Promise<LaunchResult> {
    this.launchCounter += 1
    const swarmId = `launch-${Date.now()}-${this.launchCounter}`
    const command = this.buildCommand(params)

    log.info('launch requested', {
      mode: this.realMode ? 'real' : 'mock',
      swarmId,
      agentCount: params.agentCount,
      strategy: params.strategy,
      workspace: params.workspacePath,
    })

    if (this.realMode && this.checkRufloAvailability()) {
      return this.launchReal(params, swarmId, command)
    }

    // ── mock mode ────────────────────────────────────────────────────────────
    // Don't await the full scenario — kick it off and return immediately so
    // the studio renderer's button doesn't sit spinning for 30 seconds. The
    // events stream in over time via the bridge.
    void this.runMockScenario(params, swarmId).catch((err) => {
      log.error('mock scenario failed', {
        swarmId,
        error: err instanceof Error ? err.message : String(err),
      })
    })

    return { ok: true, command, mode: 'mock', swarmId }
  }

  // ───────────────────────────────────────────────────────────────────────────

  /** The actual scripted timeline — small but covers every event variant. */
  // ── real mode ─────────────────────────────────────────────────────────────

  private launchReal(params: LaunchParams, swarmId: string, command: string): LaunchResult {
    // Stop any running swarm first.
    if (this.isRunning) this.stop()

    this.activeSwarmId = swarmId
    const cwd = params.workspacePath ?? process.cwd()

    // Emit swarm:initialized so the UI knows a swarm is starting.
    this.emit({
      type: 'swarm:initialized',
      timestamp: Date.now(),
      swarm: {
        id: swarmId,
        topology: 'hierarchical',
        agentCount: params.agentCount,
        status: 'active',
        startedAt: Date.now(),
      },
    })

    const args = [
      'ruflo',
      'swarm',
      params.prompt,
      '--claude',
      '--agents',
      String(params.agentCount),
      '--strategy',
      params.strategy,
      '--cwd',
      cwd,
    ]

    try {
      const child = spawn('npx', args, {
        cwd,
        shell: true,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      this.activeChild = child

      log.info('ruflo process spawned', { pid: child.pid, swarmId, command })

      // Stream stdout line by line.
      let stdoutBuf = ''
      child.stdout?.on('data', (data: Buffer) => {
        stdoutBuf += data.toString()
        const lines = stdoutBuf.split('\n')
        stdoutBuf = lines.pop() ?? ''
        for (const line of lines) {
          if (line.trim()) {
            this.parseRufloLine(line, swarmId, 'ruflo-stdout')
          }
        }
      })

      // Stream stderr.
      let stderrBuf = ''
      child.stderr?.on('data', (data: Buffer) => {
        stderrBuf += data.toString()
        const lines = stderrBuf.split('\n')
        stderrBuf = lines.pop() ?? ''
        for (const line of lines) {
          if (line.trim()) {
            this.parseRufloLine(line, swarmId, 'ruflo-stderr')
          }
        }
      })

      child.on('exit', (code, signal) => {
        log.info('ruflo process exited', { pid: child.pid, code, signal, swarmId })
        this.emit({
          type: 'swarm:shutdown',
          timestamp: Date.now(),
          swarmId,
        })
        this.teardownWatcher()
        this.activeChild = null
        this.activeSwarmId = null
      })

      child.on('error', (err) => {
        log.error('ruflo process error', { error: err.message, swarmId })
        this.emit({
          type: 'agent:log',
          timestamp: Date.now(),
          agentId: null,
          line: `[system] process error: ${err.message}`,
          level: 'error',
          source: 'system',
        })
      })

      // Start the workspace file watcher.
      this.startWatcher(cwd, swarmId)

      return { ok: true, command, mode: 'real', swarmId }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('failed to spawn ruflo', { error: msg })
      return { ok: false, command, mode: 'real', swarmId, error: msg }
    }
  }

  /**
   * Best-effort parser for Ruflo stdout/stderr. Tries to detect
   * structured agent events; everything else becomes an `agent:log` line.
   * The exact patterns depend on Ruflo's output format — we refine
   * as we learn.
   */
  private parseRufloLine(
    line: string,
    swarmId: string,
    source: 'ruflo-stdout' | 'ruflo-stderr',
  ): void {
    const ts = Date.now()
    const lower = line.toLowerCase()

    // Attempt to parse as JSON (some Ruflo versions emit structured JSON).
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>
      if (typeof parsed.type === 'string' && typeof parsed.timestamp === 'number') {
        // Looks like a StudioEvent — forward it directly.
        this.bridgeClient.sendEvent(parsed as unknown as StudioEvent, 'ruflo-real')
        return
      }
    } catch {
      // Not JSON — continue with text heuristics below.
    }

    // Heuristic patterns for common Ruflo output lines.
    if (lower.includes('spawned agent') || lower.includes('agent spawn')) {
      const level = 'info' as const
      this.emit({ type: 'agent:log', timestamp: ts, agentId: null, line, level, source })
      return
    }

    if (lower.includes('error') || lower.includes('failed') || lower.includes('exception')) {
      this.emit({ type: 'agent:log', timestamp: ts, agentId: null, line, level: 'error', source })
      return
    }

    if (lower.includes('warn')) {
      this.emit({ type: 'agent:log', timestamp: ts, agentId: null, line, level: 'warn', source })
      return
    }

    // Default: info-level log line.
    this.emit({ type: 'agent:log', timestamp: ts, agentId: null, line, level: 'info', source })
  }

  // ── file watcher ─────────────────────────────────────────────────────────

  private startWatcher(folderPath: string, swarmId: string): void {
    this.teardownWatcher()
    try {
      this.activeWatcher = watch(folderPath, { recursive: true }, (eventType, filename) => {
        if (!filename) return
        // Skip noisy directories.
        if (WATCH_IGNORE.some((dir) => filename.includes(dir))) return
        const changeType =
          eventType === 'rename'
            ? ('create' as const)
            : ('modify' as const)
        this.emit({
          type: 'file:changed',
          timestamp: Date.now(),
          filePath: filename,
          changeType,
          swarmId,
        })
      })
      log.info('file watcher started', { folderPath, swarmId })
    } catch (err) {
      log.warn('file watcher failed to start', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private teardownWatcher(): void {
    if (this.activeWatcher) {
      this.activeWatcher.close()
      this.activeWatcher = null
    }
  }

  // ── mock mode ────────────────────────────────────────────────────────────

  private async runMockScenario(params: LaunchParams, swarmId: string): Promise<void> {
    const agents = this.buildAgentRoster(params, swarmId)

    // 1. Swarm starts.
    this.emit({
      type: 'swarm:initialized',
      timestamp: Date.now(),
      swarm: this.buildSwarmInfo(swarmId, agents.length),
    })

    // 2. Spawn each agent at staggered intervals.
    for (const agent of agents) {
      await sleep(STEP_INTERVAL_MS / 2)
      this.emit({ type: 'agent:spawned', timestamp: Date.now(), agent })
    }

    // 3. Each agent gets a derived sub-task and walks through planning →
    //    coding → testing → done. The architect goes first, the rest
    //    follow with small offsets so the UI feels alive instead of
    //    instantaneous.
    const subTasks = this.deriveSubTasks(params, agents)
    for (let i = 0; i < agents.length; i += 1) {
      const agent = agents[i]
      const description = subTasks[i] ?? `Contribute to: ${params.prompt}`
      if (!agent) continue
      await sleep(STEP_INTERVAL_MS)
      this.emit({
        type: 'task:started',
        timestamp: Date.now(),
        task: {
          id: `${agent.id}-task`,
          description,
          assignedAgent: agent.id,
          status: 'active',
          startedAt: Date.now(),
          completedAt: null,
        },
      })
      this.emit(stateChange(agent.id, 'idle', 'planning'))
    }

    // 4. Architect broadcasts the plan to the first coder.
    const architect = agents.find((a) => a.type === 'architect')
    const firstCoder = agents.find((a) => a.type === 'coder')
    if (architect && firstCoder) {
      await sleep(STEP_INTERVAL_MS * 2)
      this.emit(stateChange(architect.id, 'planning', 'communicating'))
      this.emit({
        type: 'message:sent',
        timestamp: Date.now(),
        message: {
          id: `${swarmId}-msg-${Date.now()}`,
          fromAgent: architect.id,
          toAgent: firstCoder.id,
          content: `Plan ready for "${truncate(params.prompt, 60)}". Starting with the core endpoints.`,
          timestamp: Date.now(),
        },
      })
    }

    // 5. Everyone moves into coding/testing.
    await sleep(STEP_INTERVAL_MS)
    for (const agent of agents) {
      const next: AgentState =
        agent.type === 'tester' ? 'testing' : agent.type === 'architect' ? 'idle' : 'coding'
      const previous: AgentState = agent.type === 'architect' ? 'communicating' : 'planning'
      this.emit(stateChange(agent.id, previous, next))
    }

    // 6. Optional dramatic beat — one coder hits an error then recovers.
    if (firstCoder) {
      await sleep(STEP_INTERVAL_MS * 3)
      this.emit(
        stateChange(
          firstCoder.id,
          'coding',
          'blocked',
          'Waiting on schema review from architect',
        ),
      )
      await sleep(STEP_INTERVAL_MS * 2)
      this.emit(stateChange(firstCoder.id, 'blocked', 'coding'))
    }

    // 7. Mark all tasks complete and let agents return to idle. The studio
    //    UI will show the final swarm state until the user launches another.
    await sleep(STEP_INTERVAL_MS * 4)
    for (const agent of agents) {
      this.emit({
        type: 'task:completed',
        timestamp: Date.now(),
        taskId: `${agent.id}-task`,
        agentId: agent.id,
      })
      const previous: AgentState = agent.type === 'tester' ? 'testing' : 'coding'
      this.emit(stateChange(agent.id, previous, 'idle'))
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private emit(event: StudioEvent): void {
    this.bridgeClient.sendEvent(event, 'electron-launcher')
  }

  private buildAgentRoster(params: LaunchParams, swarmId: string): AgentInfo[] {
    const roles = distributeAgentRoles(params.agentCount)
    return roles.map((type, index) => buildAgent(type, index, swarmId))
  }

  private buildSwarmInfo(swarmId: string, agentCount: number): SwarmInfo {
    return {
      id: swarmId,
      topology: 'hierarchical',
      agentCount,
      status: 'active',
      startedAt: Date.now(),
    }
  }

  /**
   * Derive a per-agent sub-task description from the user's prompt.
   * Generic enough to work for any prompt; not trying to be clever.
   */
  private deriveSubTasks(params: LaunchParams, agents: AgentInfo[]): string[] {
    const focus = truncate(params.prompt, 80)
    return agents.map((agent) => {
      switch (agent.type) {
        case 'architect':
          return `Design the high-level approach for: ${focus}`
        case 'coder':
          return `Implement a slice of: ${focus}`
        case 'tester':
          return `Write tests covering: ${focus}`
        case 'researcher':
          return `Research best practices for: ${focus}`
        case 'coordinator':
          return `Coordinate progress and unblock the team on: ${focus}`
      }
    })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build an `AgentInfo` for a freshly-spawned mock agent. */
const buildAgent = (type: AgentType, index: number, swarmId: string): AgentInfo => ({
  id: `${swarmId}-${type}-${index}`,
  name: prettyName(type, index),
  type,
  state: 'idle',
  currentTask: null,
  spawnedAt: Date.now(),
  // Position is consumed by the desktop overlay's spawn point pool —
  // values here are placeholders since the overlay re-derives positions.
  position: { x: index, y: 0 },
})

/** Friendly display name per role + index. */
const prettyName = (type: AgentType, index: number): string => {
  const ROLE_NAMES: Record<AgentType, string[]> = {
    architect: ['System Architect', 'Solutions Architect'],
    coder: ['API Developer', 'Frontend Dev', 'Backend Dev', 'Infra Dev', 'Mobile Dev'],
    tester: ['QA Engineer', 'Integration Tester'],
    researcher: ['Tech Lead', 'Research Engineer'],
    coordinator: ['Project Manager', 'Engineering Manager'],
  }
  const pool = ROLE_NAMES[type]
  return pool[index % pool.length] ?? `${type}-${index}`
}

/** Build a pre/new-state transition event with optional reason. */
const stateChange = (
  agentId: string,
  previousState: AgentState,
  newState: AgentState,
  reason?: string,
): StudioEvent => ({
  type: 'agent:state-changed',
  timestamp: Date.now(),
  agentId,
  previousState,
  newState,
  reason: reason ?? null,
})

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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
  estimateCostUsd,
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
  private claudeAvailable: boolean | null = null
  /** All running child processes for the active swarm. */
  private activeChildren: ChildProcess[] = []
  private activeSwarmId: string | null = null
  /** File watcher for the workspace folder (real mode only). */
  private activeWatcher: FSWatcher | null = null

  constructor(options: LaunchOrchestratorOptions) {
    this.bridgeClient = options.bridgeClient
    this.realMode = options.realMode ?? process.env.RUFLO_REAL_MODE === '1'
  }

  /**
   * Check if `claude` CLI (Claude Code) is reachable. This is what
   * actually does the work — Ruflo is optional coordination.
   */
  checkRufloAvailability(): boolean {
    if (this.claudeAvailable !== null) return this.claudeAvailable
    try {
      execSync('claude --version', {
        timeout: 10_000,
        stdio: 'pipe',
        env: { ...process.env },
      })
      this.claudeAvailable = true
      log.info('Claude Code CLI is available — real mode enabled')
    } catch {
      this.claudeAvailable = false
      log.info('Claude Code CLI not found — mock mode will be used')
    }
    return this.claudeAvailable
  }

  /** Whether any real agent processes are currently running. */
  get isRunning(): boolean {
    return this.activeChildren.some((c) => !c.killed)
  }

  /**
   * Stop all running agent processes. Sends SIGTERM to each child,
   * emits swarm:shutdown, and tears down the file watcher.
   */
  stop(): void {
    for (const child of this.activeChildren) {
      if (!child.killed) {
        log.info('stopping agent process', { pid: child.pid })
        child.kill('SIGTERM')
      }
    }
    this.activeChildren = []
    if (this.activeSwarmId) {
      this.emit({
        type: 'swarm:shutdown',
        timestamp: Date.now(),
        swarmId: this.activeSwarmId,
      })
    }
    this.teardownWatcher()
    this.activeSwarmId = null
  }

  /**
   * Build the CLI command for display in the UI.
   *
   * In real mode, each agent is a separate `claude -p` process. The
   * displayed command shows what one agent invocation looks like.
   */
  buildCommand(params: LaunchParams): string {
    const safePrompt = params.prompt.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const parts = [
      'claude',
      '-p',
      '--dangerously-skip-permissions',
      `"${safePrompt}"`,
    ]
    if (params.workspacePath) {
      parts.unshift(`cd ${params.workspacePath} &&`)
    }
    return `${parts.join(' ')} # × ${params.agentCount} agents`
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

  // ── real mode ─────────────────────────────────────────────────────────────
  //
  // Ruflo is a coordination layer — it registers agent slots and tracks
  // tasks but does NOT execute Claude. The actual work is done by spawning
  // `claude -p --output-format stream-json "<sub-prompt>"` per agent.
  //
  // Each agent gets a role-specific sub-prompt derived from the user's
  // objective. All stdout is streamed back as agent:log events so the UI
  // can render real terminal output in the inspector.

  private launchReal(params: LaunchParams, swarmId: string, command: string): LaunchResult {
    if (this.isRunning) this.stop()

    this.activeSwarmId = swarmId
    this.activeChildren = []
    const cwd = params.workspacePath ?? process.cwd()
    const roles = distributeAgentRoles(params.agentCount)

    // Emit swarm:initialized so the UI knows a swarm is starting.
    this.emit({
      type: 'swarm:initialized',
      timestamp: Date.now(),
      swarm: {
        id: swarmId,
        topology: 'hierarchical',
        agentCount: roles.length,
        status: 'active',
        startedAt: Date.now(),
      },
    })

    let completedCount = 0
    const totalAgents = roles.length

    // Spawn a `claude -p` process per agent role.
    for (let i = 0; i < roles.length; i += 1) {
      const role = roles[i]
      if (!role) continue
      const agentId = `${swarmId}-${role}-${i}`
      const agentName = prettyName(role, i)
      const subPrompt = buildSubPrompt(params.prompt, params.strategy, role, agentName)

      // Emit agent:spawned.
      const agent: AgentInfo = {
        id: agentId,
        name: agentName,
        type: role,
        state: 'idle',
        currentTask: null,
        spawnedAt: Date.now(),
        position: { x: i, y: 0 },
      }
      this.emit({ type: 'agent:spawned', timestamp: Date.now(), agent })
      this.emit(stateChange(agentId, 'idle', 'planning'))

      // Stagger spawns slightly so the UI shows them appearing one by one.
      const delay = i * 600
      setTimeout(() => {
        this.spawnClaudeAgent(agentId, agentName, role, subPrompt, cwd, swarmId, () => {
          completedCount += 1
          if (completedCount >= totalAgents && this.activeSwarmId === swarmId) {
            // All agents finished — emit shutdown.
            this.emit({ type: 'swarm:shutdown', timestamp: Date.now(), swarmId })
            this.teardownWatcher()
            this.activeSwarmId = null
          }
        })
      }, delay)
    }

    // Start the workspace file watcher.
    this.startWatcher(cwd, swarmId)

    return { ok: true, command, mode: 'real', swarmId }
  }

  /**
   * Spawn a single `claude -p` process for one agent. Streams its output
   * back as agent:log events and emits task lifecycle events.
   */
  private spawnClaudeAgent(
    agentId: string,
    agentName: string,
    role: AgentType,
    prompt: string,
    cwd: string,
    _swarmId: string,
    onComplete: () => void,
  ): void {
    const taskId = `${agentId}-task`

    // Emit task:started + coding state.
    this.emit({
      type: 'task:started',
      timestamp: Date.now(),
      task: {
        id: taskId,
        description: prompt.slice(0, 120),
        assignedAgent: agentId,
        status: 'active',
        startedAt: Date.now(),
        completedAt: null,
      },
    })
    this.emit(stateChange(agentId, 'planning', role === 'tester' ? 'testing' : 'coding'))

    // Log the start.
    this.emit({
      type: 'agent:log',
      timestamp: Date.now(),
      agentId,
      line: `[${agentName}] starting: claude -p ...`,
      level: 'info',
      source: 'system',
    })

    try {
      const child = spawn('claude', ['-p', '--dangerously-skip-permissions', prompt], {
        cwd,
        shell: false,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      this.activeChildren.push(child)
      log.info('claude agent spawned', { agentId, pid: child.pid, role })

      // Stream stdout line by line — plain text output from claude -p.
      let stdoutBuf = ''
      child.stdout?.on('data', (data: Buffer) => {
        stdoutBuf += data.toString()
        const lines = stdoutBuf.split('\n')
        stdoutBuf = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trimEnd()
          if (!trimmed) continue
          this.emit({
            type: 'agent:log',
            timestamp: Date.now(),
            agentId,
            line: trimmed,
            level: 'info',
            source: 'ruflo-stdout',
          })
          // Try to extract token/cost metrics from the line.
          this.tryEmitMetrics(trimmed, agentId, _swarmId)
        }
      })

      // Stream stderr — Claude Code logs token usage here.
      let stderrBuf = ''
      child.stderr?.on('data', (data: Buffer) => {
        stderrBuf += data.toString()
        const lines = stderrBuf.split('\n')
        stderrBuf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          // Check for metrics before emitting as agent:log.
          this.tryEmitMetrics(line.trim(), agentId, _swarmId)
          this.emit({
            type: 'agent:log',
            timestamp: Date.now(),
            agentId,
            line: line.trim(),
            level: 'warn',
            source: 'ruflo-stderr',
          })
        }
      })

      child.on('exit', (code) => {
        const success = code === 0
        log.info('claude agent exited', { agentId, code, role })

        this.emit({
          type: 'agent:log',
          timestamp: Date.now(),
          agentId,
          line: `[${agentName}] ${success ? 'completed' : `exited with code ${code}`}`,
          level: success ? 'info' : 'error',
          source: 'system',
        })

        if (success) {
          this.emit({ type: 'task:completed', timestamp: Date.now(), taskId, agentId })
        } else {
          this.emit({
            type: 'task:failed',
            timestamp: Date.now(),
            taskId,
            agentId,
            error: `process exited with code ${code}`,
          })
        }
        this.emit(stateChange(agentId, role === 'tester' ? 'testing' : 'coding', 'idle'))
        onComplete()
      })

      child.on('error', (err) => {
        log.error('claude agent error', { agentId, error: err.message })
        this.emit({
          type: 'agent:log',
          timestamp: Date.now(),
          agentId,
          line: `[system] process error: ${err.message}`,
          level: 'error',
          source: 'system',
        })
        this.emit({
          type: 'task:failed',
          timestamp: Date.now(),
          taskId,
          agentId,
          error: err.message,
        })
        this.emit(stateChange(agentId, role === 'tester' ? 'testing' : 'coding', 'error'))
        onComplete()
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('failed to spawn claude agent', { agentId, error: msg })
      this.emit({
        type: 'task:failed',
        timestamp: Date.now(),
        taskId,
        agentId,
        error: msg,
      })
      this.emit(stateChange(agentId, 'planning', 'error'))
      onComplete()
    }
  }

  // ── metrics parsing ───────────────────────────────────────────────────────

  /**
   * Scan a line of stdout/stderr for token usage or cost patterns and
   * emit a `metrics:update` event if found.
   *
   * Claude Code output sometimes includes lines like:
   *   "Total tokens: 8234 (input: 5012, output: 3222)"
   *   "Cost: $0.08"
   *   "Model: claude-sonnet-4-6-20250514"
   *   "42% of context used"
   *   "input_tokens: 1234"
   *
   * We use simple regex patterns — if they don't match, we skip silently.
   */
  private tryEmitMetrics(line: string, agentId: string, swarmId: string): void {
    const lower = line.toLowerCase()
    let inputTokens = 0
    let outputTokens = 0
    let model: string | null = null
    let matched = false

    // Pattern: "input: 5012" or "input_tokens: 5012"
    const inputMatch = lower.match(/input[_\s]*tokens?\s*[:=]\s*([\d,]+)/)
    if (inputMatch?.[1]) {
      inputTokens = parseInt(inputMatch[1].replace(/,/g, ''), 10) || 0
      matched = true
    }

    // Pattern: "output: 3222" or "output_tokens: 3222"
    const outputMatch = lower.match(/output[_\s]*tokens?\s*[:=]\s*([\d,]+)/)
    if (outputMatch?.[1]) {
      outputTokens = parseInt(outputMatch[1].replace(/,/g, ''), 10) || 0
      matched = true
    }

    // Pattern: "total tokens: 8234" (if no separate in/out, split 60/40 as heuristic)
    if (!matched) {
      const totalMatch = lower.match(/total\s*tokens?\s*[:=]\s*([\d,]+)/)
      if (totalMatch?.[1]) {
        const total = parseInt(totalMatch[1].replace(/,/g, ''), 10) || 0
        inputTokens = Math.round(total * 0.6)
        outputTokens = total - inputTokens
        matched = true
      }
    }

    // Pattern: model name detection
    const modelMatch = line.match(/(?:model|using)\s*[:=]?\s*(claude[a-z0-9-]*|opus[a-z0-9.-]*|sonnet[a-z0-9.-]*|haiku[a-z0-9.-]*)/i)
    if (modelMatch?.[1]) {
      const raw = modelMatch[1].toLowerCase()
      if (raw.includes('opus')) model = 'opus-4.6'
      else if (raw.includes('sonnet')) model = 'sonnet-4.6'
      else if (raw.includes('haiku')) model = 'haiku-4.5'
    }

    // Pattern: "$0.08" or "cost: $1.24"
    const costMatch = lower.match(/\$\s*([\d.]+)/)
    let costUsd = 0
    if (costMatch?.[1]) {
      costUsd = parseFloat(costMatch[1]) || 0
      matched = true
    }

    if (!matched && !model) return

    // If we got tokens but no explicit cost, estimate it.
    if (costUsd === 0 && (inputTokens > 0 || outputTokens > 0)) {
      costUsd = estimateCostUsd(inputTokens, outputTokens, model)
    }

    this.emit({
      type: 'metrics:update',
      timestamp: Date.now(),
      agentId,
      swarmId,
      model,
      inputTokens,
      outputTokens,
      costUsd,
    })
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

/**
 * Build a role-specific sub-prompt for a single claude -p invocation.
 * The prompt tells the agent what role it plays and what to focus on.
 */
const buildSubPrompt = (
  objective: string,
  strategy: string,
  role: AgentType,
  name: string,
): string => {
  const roleInstructions: Record<AgentType, string> = {
    architect: `You are ${name}, the system architect. Design the high-level approach, file structure, and architecture. Then implement the key structural files.`,
    coder: `You are ${name}, a developer. Implement the feature described below. Write clean, working code with proper error handling.`,
    tester: `You are ${name}, a QA engineer. Write comprehensive tests for the feature described below. Include unit tests and integration tests.`,
    researcher: `You are ${name}, a tech lead. Research best practices, review the approach, and implement any supporting utilities needed.`,
    coordinator: `You are ${name}, the project coordinator. Review the overall progress, ensure all parts fit together, and fix any integration issues.`,
  }
  return `${roleInstructions[role]}\n\nObjective: ${objective}\nStrategy: ${strategy}\n\nWork in the current directory. Create or modify files as needed. Be thorough but focused on your role.`
}

// extractStreamText removed — we now use plain-text output from
// `claude -p` instead of stream-json, so no JSON parsing needed.

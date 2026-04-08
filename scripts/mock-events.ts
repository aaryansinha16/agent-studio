/**
 * Mock event generator — Agent Studio's primary UI development tool.
 *
 * Connects to the event bridge as a producer and replays a realistic
 * Ruflo-shaped swarm session on a continuous loop. The scenario walks the
 * UI through every agent state, every event type, blocked/error recovery,
 * inter-agent messaging, and task lifecycle — so the dashboard can be
 * built and exercised without ever booting a real Ruflo daemon.
 *
 * Usage:
 *   npx tsx scripts/mock-events.ts                # 1x speed
 *   npx tsx scripts/mock-events.ts --speed=2      # twice as fast
 *   npx tsx scripts/mock-events.ts --speed=0.5    # half speed (debug pacing)
 *   BRIDGE_URL=ws://127.0.0.1:6747 npx tsx scripts/mock-events.ts
 */

import process from 'node:process'

import WebSocket from 'ws'

import {
  type AgentInfo,
  type AgentState,
  type AgentType,
  type EventEnvelope,
  type StudioEvent,
  type SwarmInfo,
  DEFAULT_BRIDGE_HOST,
  DEFAULT_BRIDGE_PORT,
  RECONNECT_INITIAL_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  SOURCE_MOCK,
  createLogger,
  defaultBridgeUrl,
} from '../packages/shared/src/index.js'

const log = createLogger('mock-events')

// ─────────────────────────────────────────────────────────────────────────────
// CLI flags
// ─────────────────────────────────────────────────────────────────────────────

interface CliFlags {
  speed: number
  url: string
}

const parseFlags = (argv: readonly string[]): CliFlags => {
  let speed = 1
  let url = process.env.BRIDGE_URL ?? defaultBridgeUrl(DEFAULT_BRIDGE_HOST, DEFAULT_BRIDGE_PORT)
  for (const arg of argv) {
    if (arg.startsWith('--speed=')) {
      const raw = Number.parseFloat(arg.slice('--speed='.length))
      if (Number.isFinite(raw) && raw > 0) speed = raw
      else log.warn('ignoring invalid --speed value', { raw: arg })
    } else if (arg.startsWith('--url=')) {
      url = arg.slice('--url='.length)
    } else if (arg === '--help' || arg === '-h') {
      // eslint-disable-next-line no-console
      console.log(
        [
          'mock-events — replay a synthetic Ruflo swarm session against the event bridge',
          '',
          'Usage: tsx scripts/mock-events.ts [--speed=<n>] [--url=<ws://...>]',
          '',
          'Flags:',
          '  --speed=<n>     time scale; >1 is faster, <1 is slower (default 1)',
          '  --url=<ws://>   bridge URL (default ws://127.0.0.1:6747)',
        ].join('\n'),
      )
      process.exit(0)
    }
  }
  return { speed, url }
}

const flags = parseFlags(process.argv.slice(2))

// ─────────────────────────────────────────────────────────────────────────────
// Cast — names, roles, and isometric grid positions
// ─────────────────────────────────────────────────────────────────────────────

interface AgentSeed {
  id: string
  name: string
  type: AgentType
  position: { x: number; y: number }
}

const AGENTS: readonly AgentSeed[] = [
  { id: 'agent-architect', name: 'System Architect', type: 'architect', position: { x: 2, y: 0 } },
  { id: 'agent-api', name: 'API Developer', type: 'coder', position: { x: 0, y: 1 } },
  { id: 'agent-frontend', name: 'Frontend Dev', type: 'coder', position: { x: 4, y: 1 } },
  { id: 'agent-qa', name: 'QA Engineer', type: 'tester', position: { x: 1, y: 2 } },
  { id: 'agent-research', name: 'Tech Lead', type: 'researcher', position: { x: 3, y: 2 } },
  { id: 'agent-pm', name: 'Project Manager', type: 'coordinator', position: { x: 2, y: 3 } },
] as const

const SWARM_ID = 'swarm-001'

// ─────────────────────────────────────────────────────────────────────────────
// MockRunner — owns the WebSocket connection and current scenario state
// ─────────────────────────────────────────────────────────────────────────────

class MockRunner {
  private socket: WebSocket | null = null
  private readonly agents = new Map<string, AgentInfo>()
  /** Per-agent currently-active task id (mirrors what we tell the bridge). */
  private readonly currentTaskByAgent = new Map<string, string>()
  private cycle = 0

  constructor(private readonly url: string, private readonly speed: number) {}

  /** Connect to the bridge with bounded exponential backoff. */
  async connect(): Promise<void> {
    let attempt = 0
    // Try forever — the dev script starts us up alongside the bridge and
    // there's a small race; we just keep retrying until the bridge appears.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        this.socket = await openSocket(this.url)
        log.info('connected to bridge', { url: this.url, speed: this.speed })
        this.socket.on('close', (code, reason) => {
          log.warn('disconnected from bridge', { code, reason: reason.toString() })
          process.exit(0)
        })
        this.socket.on('error', (err) => {
          log.warn('socket error', { error: String(err) })
        })
        return
      } catch (err) {
        const delay = Math.min(
          RECONNECT_INITIAL_DELAY_MS * 2 ** attempt,
          RECONNECT_MAX_DELAY_MS,
        )
        log.warn('bridge unreachable, retrying', {
          url: this.url,
          delayMs: delay,
          error: err instanceof Error ? err.message : String(err),
        })
        await rawSleep(delay)
        attempt += 1
      }
    }
  }

  // ── primitive sleep that respects the speed flag ────────────────────────────

  /** Sleep `seconds` of scenario time, scaled by 1 / speed. */
  sleep(seconds: number): Promise<void> {
    const ms = Math.max(0, (seconds * 1000) / this.speed)
    return rawSleep(ms)
  }

  // ── outbound emit helpers ───────────────────────────────────────────────────

  private send(event: StudioEvent): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      log.warn('drop event — socket not open', { type: event.type })
      return
    }
    const envelope: EventEnvelope = { kind: 'event', source: SOURCE_MOCK, event }
    this.socket.send(JSON.stringify(envelope))
  }

  initSwarm(): void {
    const swarm: SwarmInfo = {
      id: SWARM_ID,
      topology: 'hierarchical',
      agentCount: 0,
      status: 'active',
      startedAt: Date.now(),
    }
    this.send({ type: 'swarm:initialized', timestamp: Date.now(), swarm })
  }

  shutdownSwarm(): void {
    this.send({ type: 'swarm:shutdown', timestamp: Date.now(), swarmId: SWARM_ID })
  }

  spawnAgent(seed: AgentSeed): void {
    const agent: AgentInfo = {
      id: seed.id,
      name: seed.name,
      type: seed.type,
      state: 'idle',
      currentTask: null,
      spawnedAt: Date.now(),
      position: seed.position,
    }
    this.agents.set(agent.id, agent)
    this.send({ type: 'agent:spawned', timestamp: Date.now(), agent })
  }

  changeState(agentId: string, newState: AgentState, reason?: string): void {
    const agent = this.agents.get(agentId)
    if (!agent) {
      log.warn('changeState for unknown agent', { agentId })
      return
    }
    const previousState = agent.state
    if (previousState === newState) return
    this.agents.set(agentId, { ...agent, state: newState })
    this.send({
      type: 'agent:state-changed',
      timestamp: Date.now(),
      agentId,
      previousState,
      newState,
      reason: reason ?? null,
    })
  }

  /** Open a new task and assign it to the agent. */
  startTask(agentId: string, description: string): string {
    const taskId = `task-c${this.cycle}-${agentId}`
    this.currentTaskByAgent.set(agentId, taskId)
    const agent = this.agents.get(agentId)
    if (agent) {
      this.agents.set(agentId, { ...agent, currentTask: taskId })
    }
    this.send({
      type: 'task:started',
      timestamp: Date.now(),
      task: {
        id: taskId,
        description,
        assignedAgent: agentId,
        status: 'active',
        startedAt: Date.now(),
        completedAt: null,
      },
    })
    return taskId
  }

  /** Complete the agent's currently-active task, if any. */
  completeTask(agentId: string): void {
    const taskId = this.currentTaskByAgent.get(agentId)
    if (!taskId) return
    this.currentTaskByAgent.delete(agentId)
    const agent = this.agents.get(agentId)
    if (agent && agent.currentTask === taskId) {
      this.agents.set(agentId, { ...agent, currentTask: null })
    }
    this.send({ type: 'task:completed', timestamp: Date.now(), taskId, agentId })
  }

  sendMessage(fromAgent: string, toAgent: string, content: string): void {
    this.send({
      type: 'message:sent',
      timestamp: Date.now(),
      message: {
        id: `msg-${fromAgent}->${toAgent}-${Date.now()}`,
        fromAgent,
        toAgent,
        content,
        timestamp: Date.now(),
      },
    })
  }

  beginCycle(): void {
    this.cycle += 1
    log.info('starting scenario cycle', { cycle: this.cycle })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario — the timeline the user specified
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bootstrap phase — runs once at startup. Initializes the swarm and spawns
 * every agent. Subsequent cycles reuse the same agents and only re-run the
 * "work" phase below.
 */
const runBootstrap = async (mock: MockRunner): Promise<void> => {
  // t=0s — swarm appears
  mock.initSwarm()
  // t=0.5s..3s — agents spawn at half-second intervals
  for (const seed of AGENTS) {
    await mock.sleep(0.5)
    mock.spawnAgent(seed)
  }
}

/**
 * Work phase — the rich dramatic timeline. Loops forever; each cycle
 * starts with all agents IDLE and walks them through planning, coding,
 * testing, blocking, recovering, and completing their tasks.
 *
 * The timestamps in comments below are *relative to the start of this
 * function*, matching the spec the user provided. The actual wall-clock
 * spacing is computed by chaining `mock.sleep(delta)` calls so that
 * each --speed value scales the entire scenario uniformly.
 */
const runWorkPhase = async (mock: MockRunner): Promise<void> => {
  mock.beginCycle()

  // t=0s → t=4s: a beat of calm, then the architect picks up the spec.
  await mock.sleep(4)
  mock.changeState('agent-architect', 'planning')
  mock.startTask('agent-architect', 'Design system architecture for REST API')

  // t=4 → t=8s: architect finishes planning and hands the design over.
  await mock.sleep(4)
  mock.changeState('agent-architect', 'communicating')
  mock.sendMessage(
    'agent-architect',
    'agent-api',
    "Architecture ready. Here's the API contract: /users, /auth, /products endpoints. Using Express + Prisma.",
  )

  // t=8 → t=9s: handoff complete.
  await mock.sleep(1)
  mock.changeState('agent-architect', 'idle')
  mock.completeTask('agent-architect')
  mock.changeState('agent-api', 'planning')

  // t=9 → t=10s: API Developer starts coding.
  await mock.sleep(1)
  mock.changeState('agent-api', 'coding')
  mock.startTask('agent-api', 'Implement /auth endpoints with JWT')

  // t=10 → t=10.5s: Frontend Dev picks up its piece.
  await mock.sleep(0.5)
  mock.changeState('agent-frontend', 'coding')
  mock.startTask('agent-frontend', 'Build React login/signup forms')

  // t=10.5 → t=11s: Tech Lead spins up research.
  await mock.sleep(0.5)
  mock.changeState('agent-research', 'planning')
  mock.startTask('agent-research', 'Research best auth patterns for Express')

  // t=11 → t=15s: Tech Lead finishes researching and chimes in with advice.
  await mock.sleep(4)
  mock.changeState('agent-research', 'communicating')
  mock.sendMessage(
    'agent-research',
    'agent-api',
    'Use bcrypt for password hashing, not MD5.',
  )

  // t=15 → t=16s: Tech Lead returns to idle.
  await mock.sleep(1)
  mock.changeState('agent-research', 'idle')
  mock.completeTask('agent-research')

  // t=16 → t=20s: QA Engineer starts integration testing.
  await mock.sleep(4)
  mock.changeState('agent-qa', 'testing')
  mock.startTask('agent-qa', 'Write integration tests for /auth')

  // t=20 → t=25s: QA hits a wall — API isn't ready.
  await mock.sleep(5)
  mock.changeState(
    'agent-qa',
    'blocked',
    'Waiting for API Developer to finish /auth endpoints',
  )

  // t=25 → t=30s: API Developer ships, unblocks QA on the next tick.
  await mock.sleep(5)
  mock.completeTask('agent-api')
  mock.changeState('agent-api', 'idle')

  // t=30 → t=31s: QA picks back up.
  await mock.sleep(1)
  mock.changeState('agent-qa', 'testing')

  // t=31 → t=35s: Frontend Dev hits a compile error.
  await mock.sleep(4)
  mock.changeState(
    'agent-frontend',
    'error',
    'TypeScript compilation error in LoginForm.tsx',
  )

  // t=35 → t=38s: PM steps in to coach the fix.
  await mock.sleep(3)
  mock.changeState('agent-pm', 'communicating')
  mock.sendMessage(
    'agent-pm',
    'agent-frontend',
    "Fix the TS error, it's a missing type import.",
  )

  // t=38 → t=40s: PM returns to idle, Frontend Dev resumes work.
  await mock.sleep(2)
  mock.changeState('agent-pm', 'idle')
  mock.changeState('agent-frontend', 'coding')

  // t=40 → t=45s: everyone wraps up.
  await mock.sleep(5)
  mock.completeTask('agent-frontend')
  mock.changeState('agent-frontend', 'idle')
  mock.completeTask('agent-qa')
  mock.changeState('agent-qa', 'idle')

  // t=45 → t=48s: brief pause before the next cycle picks up.
  await mock.sleep(3)
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const rawSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

const openSocket = (url: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    let settled = false
    const socket = new WebSocket(url)
    const onOpen = () => {
      if (settled) return
      settled = true
      socket.off('error', onError)
      resolve(socket)
    }
    const onError = (err: Error) => {
      if (settled) return
      settled = true
      socket.off('open', onOpen)
      reject(err)
    }
    socket.once('open', onOpen)
    socket.once('error', onError)
  })

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  const mock = new MockRunner(flags.url, flags.speed)
  await mock.connect()

  // Graceful shutdown — emit swarm:shutdown so the UI sees a clean closure
  // instead of a frozen world the next time the dev restarts the script.
  let shuttingDown = false
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return
    shuttingDown = true
    log.info('shutting down', { signal })
    try {
      mock.shutdownSwarm()
    } catch {
      // Ignore — best-effort.
    }
    setTimeout(() => process.exit(0), 100).unref?.()
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  await runBootstrap(mock)

  // Loop the work phase forever (or until the user kills us).
  while (!shuttingDown) {
    await runWorkPhase(mock)
  }
}

main().catch((err) => {
  log.error('mock generator failed', {
    error: err instanceof Error ? err.message : String(err),
  })
  process.exit(1)
})

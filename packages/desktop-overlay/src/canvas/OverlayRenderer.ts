/**
 * OverlayRenderer — owns the Pixi.js Application that renders all desktop
 * agents on the transparent overlay window.
 *
 * Responsibilities:
 *   - Create a fullscreen, transparent Pixi canvas mounted on a host div
 *   - Maintain a Map of DesktopAgent sprites keyed by agent id
 *   - Apply StudioEvents (and the initial WorldSnapshot) to that Map
 *   - Run the per-frame tick loop that lerps positions and ages bubbles
 *   - Track the cursor and toggle mouse passthrough through the
 *     StudioBridge IPC API whenever it enters/leaves an agent's hit area
 *   - Forward agent click events to the bridge as `focusAgent(id)` calls
 *
 * The renderer is intentionally framework-free — React just mounts the
 * canvas host element and hands it to `OverlayRenderer.attach()`.
 */

import { Application, Container } from 'pixi.js'

import type {
  AgentInfo,
  StudioBridgeApi,
  StudioEvent,
  WorldSnapshot,
} from '@agent-studio/shared'

import {
  AGENT_HIT_PADDING,
  AGENT_RADIUS,
  DesktopAgent,
} from './DesktopAgent.js'
import { SpeechBubble } from './SpeechBubble.js'

const EDGE_MARGIN = 80
const SPAWN_STAGGER_MS = 150

interface OverlayRendererOptions {
  bridge: StudioBridgeApi
}

/**
 * The renderer is a long-lived object: created once when the React shell
 * mounts, destroyed once when it unmounts. All event subscriptions are
 * scoped to its lifetime so React StrictMode double-mounts don't leak.
 */
export class OverlayRenderer {
  private readonly bridge: StudioBridgeApi
  private app: Application | null = null
  private hostElement: HTMLDivElement | null = null
  private readonly agents = new Map<string, DesktopAgent>()
  private readonly bubbles = new Map<string, SpeechBubble>()
  private readonly agentLayer = new Container()
  private readonly bubbleLayer = new Container()
  private mousePassthrough = true
  private currentMouseX = 0
  private currentMouseY = 0
  private spawnIndex = 0
  /** Subscriptions to tear down on detach. */
  private cleanup: Array<() => void> = []

  constructor(options: OverlayRendererOptions) {
    this.bridge = options.bridge
  }

  /** Mount the Pixi canvas inside `host` and start receiving bridge events. */
  async attach(host: HTMLDivElement): Promise<void> {
    if (this.app) return // already attached
    this.hostElement = host

    const app = new Application({
      width: window.innerWidth,
      height: window.innerHeight,
      backgroundAlpha: 0,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
      // We feed events to Pixi via the canvas — but only for clicks,
      // since mousemove uses DOM listeners (Pixi doesn't get pointer
      // events when the window has setIgnoreMouseEvents(true)).
      eventMode: 'passive',
    })
    this.app = app

    host.appendChild(app.view as HTMLCanvasElement)
    ;(app.view as HTMLCanvasElement).style.width = '100%'
    ;(app.view as HTMLCanvasElement).style.height = '100%'
    ;(app.view as HTMLCanvasElement).style.background = 'transparent'

    app.stage.addChild(this.agentLayer)
    app.stage.addChild(this.bubbleLayer)

    // Per-frame tick.
    app.ticker.add((delta) => {
      const deltaMs = delta * (1000 / 60)
      this.tick(deltaMs)
    })

    // Resize with the window.
    const onResize = () => {
      if (!this.app) return
      this.app.renderer.resize(window.innerWidth, window.innerHeight)
    }
    window.addEventListener('resize', onResize)
    this.cleanup.push(() => window.removeEventListener('resize', onResize))

    // Mouse tracking — drives passthrough toggling.
    const onMouseMove = (event: MouseEvent) => {
      this.currentMouseX = event.clientX
      this.currentMouseY = event.clientY
      this.updatePassthrough()
    }
    window.addEventListener('mousemove', onMouseMove)
    this.cleanup.push(() => window.removeEventListener('mousemove', onMouseMove))

    // Bootstrap from current world snapshot.
    try {
      const snapshot = await this.bridge.requestState()
      this.applySnapshot(snapshot)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[overlay] failed to fetch initial snapshot', err)
    }

    // Subscribe to live events.
    const offEvent = this.bridge.onEvent((event) => {
      this.applyEvent(event)
    })
    this.cleanup.push(offEvent)

    // Default to passthrough so the user keeps control of the desktop.
    this.bridge.setMousePassthrough(true)
  }

  /** Tear everything down — must be called before host is removed. */
  detach(): void {
    for (const fn of this.cleanup) {
      try {
        fn()
      } catch {
        // Ignore.
      }
    }
    this.cleanup = []

    for (const agent of this.agents.values()) agent.destroy()
    this.agents.clear()
    for (const bubble of this.bubbles.values()) bubble.destroy()
    this.bubbles.clear()

    if (this.app) {
      this.app.destroy(true, { children: true, texture: true, baseTexture: true })
      this.app = null
    }
    if (this.hostElement) {
      while (this.hostElement.firstChild) {
        this.hostElement.removeChild(this.hostElement.firstChild)
      }
      this.hostElement = null
    }
  }

  // ── event application ──────────────────────────────────────────────────────

  private applySnapshot(snapshot: WorldSnapshot): void {
    for (const agent of snapshot.agents) {
      this.spawnAgent(agent)
    }
  }

  private applyEvent(event: StudioEvent): void {
    switch (event.type) {
      case 'agent:spawned':
        this.spawnAgent(event.agent)
        return
      case 'agent:state-changed': {
        const agent = this.agents.get(event.agentId)
        if (agent) agent.setState(event.newState)
        return
      }
      case 'agent:terminated': {
        const agent = this.agents.get(event.agentId)
        if (!agent) return
        this.agentLayer.removeChild(agent.container)
        agent.destroy()
        this.agents.delete(event.agentId)
        // Drop any active bubble for this agent too.
        const bubble = this.bubbles.get(event.agentId)
        if (bubble) {
          this.bubbleLayer.removeChild(bubble.container)
          bubble.destroy()
          this.bubbles.delete(event.agentId)
        }
        return
      }
      case 'message:sent':
        this.handleMessage(event.message.fromAgent, event.message.toAgent, event.message.content)
        return
      // Task and swarm events don't change overlay rendering yet — they
      // belong to the studio dashboard. The overlay stays focused on
      // *who* is on screen, not *what* tasks are queued.
      case 'task:started':
      case 'task:completed':
      case 'task:failed':
      case 'swarm:initialized':
      case 'swarm:shutdown':
        return
    }
  }

  private spawnAgent(info: AgentInfo): void {
    if (this.agents.has(info.id)) {
      // Already spawned — just sync state in case it drifted during reconnect.
      this.agents.get(info.id)!.setState(info.state)
      return
    }
    const spawnPoint = this.spawnPoint()
    const restingPoint = this.randomRestingPoint()
    const agent = new DesktopAgent(info, spawnPoint.x, spawnPoint.y)
    agent.setTarget(restingPoint.x, restingPoint.y, true)
    this.agents.set(info.id, agent)
    this.agentLayer.addChild(agent.container)

    // Listen for clicks on this specific agent.
    agent.container.on('pointerdown', () => {
      this.bridge.focusAgent(info.id)
    })
  }

  private handleMessage(fromId: string, toId: string, content: string): void {
    const sender = this.agents.get(fromId)
    const receiver = this.agents.get(toId)
    if (!sender) return

    // Sender walks toward receiver (if known) and pulses.
    if (receiver) {
      const target = receiver.position()
      // Settle just to the side of the receiver so the sprites don't overlap.
      const offsetX = target.x > sender.position().x ? -AGENT_RADIUS * 2 : AGENT_RADIUS * 2
      sender.setTarget(target.x + offsetX, target.y)
      // Schedule a return to home after the bubble lifetime.
      setTimeout(() => {
        // Bail if the agent has been terminated in the meantime.
        if (!this.agents.has(fromId)) return
        sender.setTarget(sender.homeX, sender.homeY)
      }, 2000)
    }

    // Replace any existing bubble from the same sender so they don't stack.
    const existing = this.bubbles.get(fromId)
    if (existing) {
      this.bubbleLayer.removeChild(existing.container)
      existing.destroy()
      this.bubbles.delete(fromId)
    }

    const bubble = new SpeechBubble(content)
    bubble.container.x = sender.container.x
    bubble.container.y = sender.container.y
    this.bubbleLayer.addChild(bubble.container)
    this.bubbles.set(fromId, bubble)
  }

  // ── per-frame tick ─────────────────────────────────────────────────────────

  private tick(deltaMs: number): void {
    for (const agent of this.agents.values()) {
      agent.tick(deltaMs)
    }
    // Bubbles follow their senders and age out.
    for (const [id, bubble] of this.bubbles) {
      const sender = this.agents.get(id)
      if (sender) {
        bubble.container.x = sender.container.x
        bubble.container.y = sender.container.y
      }
      const expired = bubble.tick(deltaMs)
      if (expired) {
        this.bubbleLayer.removeChild(bubble.container)
        bubble.destroy()
        this.bubbles.delete(id)
      }
    }
  }

  // ── mouse passthrough ──────────────────────────────────────────────────────

  /**
   * Decide whether the cursor is currently hovering an agent. If it is,
   * we ask the main process to start *capturing* mouse events on the
   * overlay window so the next click reaches Pixi. Otherwise the window
   * keeps passing events through to the underlying app.
   */
  private updatePassthrough(): void {
    const overAgent = this.cursorIsOverAgent()
    const desired = !overAgent
    if (desired === this.mousePassthrough) return
    this.mousePassthrough = desired
    this.bridge.setMousePassthrough(desired)
  }

  private cursorIsOverAgent(): boolean {
    const r = AGENT_RADIUS + AGENT_HIT_PADDING
    const r2 = r * r
    for (const agent of this.agents.values()) {
      const dx = this.currentMouseX - agent.container.x
      const dy = this.currentMouseY - agent.container.y
      if (dx * dx + dy * dy <= r2) return true
    }
    return false
  }

  // ── positioning helpers ────────────────────────────────────────────────────

  /** New agents enter from the bottom-center, near where the dock lives. */
  private spawnPoint(): { x: number; y: number } {
    const x = window.innerWidth / 2 + (this.spawnIndex - 2) * 60
    const y = window.innerHeight - 80
    this.spawnIndex += 1
    setTimeout(() => {
      // Stagger spawn timing so multiple spawn events feel like a wave
      // rather than a clump.
      this.spawnIndex = Math.max(0, this.spawnIndex - 1)
    }, SPAWN_STAGGER_MS * 6)
    return { x, y }
  }

  /**
   * Pick a resting point spread across the screen, biased toward the
   * upper area so agents don't crowd the dock. Deterministic per call so
   * agents fan out instead of all picking similar spots.
   */
  private randomRestingPoint(): { x: number; y: number } {
    const w = window.innerWidth
    const h = window.innerHeight
    const x = EDGE_MARGIN + Math.random() * Math.max(0, w - EDGE_MARGIN * 2)
    // Upper 60% of the screen, leaving room above the dock.
    const y = EDGE_MARGIN + Math.random() * Math.max(0, h * 0.6 - EDGE_MARGIN)
    return { x, y }
  }
}

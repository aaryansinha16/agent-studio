/**
 * IsometricOffice — fixed-view Pixi.js office scene.
 *
 * Performance-first rewrite. The office fills its container at a fixed
 * scale — no pan, no zoom, no drag. The only per-frame work is:
 *   - Move characters toward their target (lerp x/y)
 *   - Tick each character's pose (breathing, walking legs)
 *   - Tick speech bubbles (alpha/scale)
 *   - Toggle monitor glow on/off (no pulse, just binary)
 *
 * Everything else is baked into a single RenderTexture at init time
 * (or drawn as a single background Sprite when sprite assets are
 * available).
 *
 * Target: 60 fps steady with 12 agents on a MacBook.
 */

import { Application, Container, Graphics, RenderTexture, Sprite } from 'pixi.js'

import {
  AgentCharacter,
  OFFICE_COLORS,
  SpeechBubble,
  cosmeticsForIndex,
  easeInOutQuad,
  loadOfficeAssets,
  type OfficeAssets,
} from '@agent-studio/canvas-core'
import type {
  AgentInfo,
  AgentMessage,
  AgentState,
  AgentType,
  StudioEvent,
} from '@agent-studio/shared'

// ─────────────────────────────────────────────────────────────────────────────
// Layout
// ─────────────────────────────────────────────────────────────────────────────

const WORLD_W = 1800
const WORLD_H = 1000

const DESK_ROW_Y = [810, 650] as const
const DESK_COLS = 6
const DESK_ORIGIN_X = 200
const DESK_SPACING = 240
const MAX_BUBBLES = 4
const WALK_ALPHA = 0.14 // lerp factor per ~16 ms frame

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface DeskSlot {
  index: number
  row: number
  x: number
  y: number
  /** Live monitor rectangle — toggled between glow and dark. */
  monitor: Graphics
  lastMode: 'coding' | 'other'
}

interface ManagedAgent {
  character: AgentCharacter
  deskIndex: number | null
  targetX: number
  targetY: number
  homeX: number
  homeY: number
  walking: boolean
  /** If true, character returns home after arriving at target. */
  returnAfterArrival: boolean
  returnAt: number | null
}

interface ActiveBubble {
  bubble: SpeechBubble
  agentId: string
}

export interface IsometricOfficeOptions {
  onSelectAgent?: (id: string) => void
  onDeselect?: () => void
  spritesBaseUrl?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Scene
// ─────────────────────────────────────────────────────────────────────────────

export class IsometricOffice {
  private app: Application | null = null
  private host: HTMLDivElement | null = null
  private spriteAssets: OfficeAssets | null = null

  private readonly world = new Container()
  private readonly monitorLayer = new Container()
  private readonly characterLayer = new Container()
  private readonly bubbleLayer = new Container()

  private readonly desks: DeskSlot[] = []
  private readonly agents = new Map<string, ManagedAgent>()
  private readonly bubbles: ActiveBubble[] = []
  private selectedId: string | null = null
  private readonly opts: IsometricOfficeOptions
  private cosmeticIdx = 0
  private cleanup: Array<() => void> = []

  constructor(opts: IsometricOfficeOptions = {}) {
    this.opts = opts
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  async attach(host: HTMLDivElement): Promise<void> {
    if (this.app) return
    this.host = host
    const rect = host.getBoundingClientRect()

    const app = new Application({
      width: Math.max(320, rect.width),
      height: Math.max(240, rect.height),
      backgroundColor: OFFICE_COLORS.floor,
      antialias: true,
      // Force 1x resolution even on Retina — halves the pixel budget
      // and is the single biggest perf win for a fixed-view scene.
      resolution: 1,
      autoDensity: true,
    })
    this.app = app
    const canvas = app.view as HTMLCanvasElement
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    canvas.style.display = 'block'
    host.appendChild(canvas)

    // Load sprite assets (background PNG + furniture + character textures).
    const base = this.opts.spritesBaseUrl ?? '/assets/sprites'
    try {
      this.spriteAssets = await loadOfficeAssets(base)
    } catch {
      this.spriteAssets = null
    }

    app.stage.addChild(this.world)

    // Background — either a single sprite or a procedural bake.
    const bg = this.buildBackground(app)
    this.world.addChild(bg)

    // Monitors are live (toggle glow on/off — no per-frame pulse).
    this.buildMonitors()
    this.world.addChild(this.monitorLayer)

    // Characters + bubbles on top.
    this.world.addChild(this.characterLayer)
    this.world.addChild(this.bubbleLayer)

    // Scale the world to fit the container.
    this.fitWorld(rect.width, rect.height)

    // Click on empty = deselect.
    app.stage.eventMode = 'static'
    app.stage.hitArea = app.screen
    app.stage.on('pointerdown', (e) => {
      if (e.target === app.stage) this.opts.onDeselect?.()
    })

    // Resize handler.
    const ro = new ResizeObserver(() => {
      if (!this.app || !this.host) return
      const r = this.host.getBoundingClientRect()
      this.app.renderer.resize(Math.max(320, r.width), Math.max(240, r.height))
      this.fitWorld(r.width, r.height)
    })
    ro.observe(host)
    this.cleanup.push(() => ro.disconnect())

    // Tick loop — as lean as possible.
    app.ticker.add((delta) => this.tick(delta * (1000 / 60)))
  }

  detach(): void {
    for (const fn of this.cleanup) fn()
    this.cleanup = []
    for (const m of this.agents.values()) m.character.destroy({ children: true })
    this.agents.clear()
    for (const b of this.bubbles) b.bubble.destroy({ children: true })
    this.bubbles.length = 0
    if (this.app) {
      this.app.destroy(true, { children: true, texture: true, baseTexture: true })
      this.app = null
    }
    if (this.host) {
      while (this.host.firstChild) this.host.removeChild(this.host.firstChild)
      this.host = null
    }
  }

  // ── public API ─────────────────────────────────────────────────────────────

  setAgents(list: readonly AgentInfo[]): void {
    const seen = new Set<string>()
    for (const info of list) {
      seen.add(info.id)
      const existing = this.agents.get(info.id)
      if (existing) {
        existing.character.setState(info.state)
        existing.character.setName(info.name)
      } else {
        this.spawn(info)
      }
    }
    for (const id of this.agents.keys()) {
      if (!seen.has(id)) this.remove(id)
    }
  }

  applyEvent(event: StudioEvent): void {
    switch (event.type) {
      case 'agent:spawned':
        if (!this.agents.has(event.agent.id)) this.spawn(event.agent)
        return
      case 'agent:state-changed': {
        const m = this.agents.get(event.agentId)
        if (m) m.character.setState(event.newState)
        return
      }
      case 'agent:terminated':
        this.remove(event.agentId)
        return
      case 'message:sent':
        this.onMessage(event.message)
        return
      default:
        return
    }
  }

  setSelectedAgent(id: string | null): void {
    if (id === this.selectedId) return
    if (this.selectedId) this.agents.get(this.selectedId)?.character.setSelected(false)
    this.selectedId = id
    if (id) this.agents.get(id)?.character.setSelected(true)
  }

  // ── background ────────────────────────────────────────────────────────────

  private buildBackground(app: Application): Sprite {
    const container = new Container()

    if (this.spriteAssets) {
      // Sprite mode: background image + furniture sprites.
      const bgSprite = new Sprite(this.spriteAssets.background)
      bgSprite.width = WORLD_W
      bgSprite.height = WORLD_H
      container.addChild(bgSprite)
      this.placeFurniture(container, this.spriteAssets)
    } else {
      // Procedural fallback — minimal Graphics.
      const floor = new Graphics()
      floor.beginFill(OFFICE_COLORS.floor, 1)
      floor.drawRect(0, 0, WORLD_W, WORLD_H)
      floor.endFill()
      container.addChild(floor)
      const wall = new Graphics()
      wall.beginFill(OFFICE_COLORS.backWall, 1)
      wall.drawRect(0, 0, WORLD_W, 520)
      wall.endFill()
      container.addChild(wall)
    }

    // Bake into a single texture at 1x — one draw call for the entire bg.
    const tex = RenderTexture.create({ width: WORLD_W, height: WORLD_H, resolution: 1 })
    app.renderer.render(container, { renderTexture: tex })
    container.destroy({ children: true })
    return new Sprite(tex)
  }

  private placeFurniture(parent: Container, assets: OfficeAssets): void {
    const place = (name: string, x: number, y: number, anchorY = 1) => {
      const tex = assets.furniture.get(name)
      if (!tex) return
      const s = new Sprite(tex)
      s.anchor.set(0.5, anchorY)
      s.x = x
      s.y = y
      parent.addChild(s)
    }
    place('window', 300, 240, 0.5)
    place('poster-ship-it', 680, 230, 0.5)
    place('clock', 920, 240, 0.5)
    place('whiteboard', 500, 380, 1)
    place('bookshelf', 100, WORLD_H - 40)
    place('filing-cabinet', 220, WORLD_H - 40)
    place('plant', 1640, WORLD_H - 40)
    place('water-cooler', 1480, 560)
    place('trash-can', 1700, WORLD_H - 40)
    place('ceiling-light', WORLD_W / 2, 30)

    const deskTex = assets.furniture.get('desk')
    const chairTex = assets.furniture.get('chair')
    for (const rowY of DESK_ROW_Y) {
      for (let col = 0; col < DESK_COLS; col++) {
        const x = DESK_ORIGIN_X + col * DESK_SPACING
        if (chairTex) {
          const c = new Sprite(chairTex)
          c.anchor.set(0.5, 1)
          c.x = x
          c.y = rowY - 20
          parent.addChild(c)
        }
        if (deskTex) {
          const d = new Sprite(deskTex)
          d.anchor.set(0.5, 1)
          d.x = x
          d.y = rowY + 30
          parent.addChild(d)
        }
      }
    }
  }

  // ── live monitors (binary toggle, no per-frame pulse) ────────────────────

  private buildMonitors(): void {
    for (let row = 0; row < DESK_ROW_Y.length; row++) {
      const rowY = DESK_ROW_Y[row]
      if (rowY === undefined) continue
      for (let col = 0; col < DESK_COLS; col++) {
        const idx = row * DESK_COLS + col
        const x = DESK_ORIGIN_X + col * DESK_SPACING
        const monitor = new Graphics()
        monitor.beginFill(OFFICE_COLORS.monitorScreen, 1)
        monitor.drawRoundedRect(-22, -30, 44, 18, 1.5)
        monitor.endFill()
        monitor.x = x
        monitor.y = rowY
        this.monitorLayer.addChild(monitor)
        this.desks.push({ index: idx, row, x, y: rowY, monitor, lastMode: 'other' })
      }
    }
  }

  // ── agents ────────────────────────────────────────────────────────────────

  private spawn(info: AgentInfo): void {
    const desk = this.nextDesk()
    const ci = this.cosmeticIdx++
    const cosmetics = cosmeticsForIndex(ci)
    const spriteSet = this.spriteAssets?.characters.get(info.type as AgentType)
    const character = new AgentCharacter(info, {
      ...cosmetics,
      ...(spriteSet ? { sprites: spriteSet } : {}),
    })
    character.on('pointerdown', (e) => {
      e.stopPropagation()
      this.opts.onSelectAgent?.(info.id)
    })

    const homeX = desk ? desk.x : 900
    const homeY = desk ? desk.y - 6 : WORLD_H - 100
    // Enter from the right edge.
    character.x = WORLD_W + 50
    character.y = homeY
    character.setWalking(true)
    // Set a fixed zIndex by row so back-row draws behind front.
    character.zIndex = homeY
    this.characterLayer.addChild(character)

    this.agents.set(info.id, {
      character,
      deskIndex: desk?.index ?? null,
      targetX: homeX,
      targetY: homeY,
      homeX,
      homeY,
      walking: true,
      returnAfterArrival: false,
      returnAt: null,
    })
  }

  private remove(id: string): void {
    const m = this.agents.get(id)
    if (!m) return
    this.characterLayer.removeChild(m.character)
    m.character.destroy({ children: true })
    this.agents.delete(id)
    if (this.selectedId === id) this.selectedId = null
  }

  private nextDesk(): DeskSlot | null {
    const taken = new Set<number>()
    for (const m of this.agents.values()) if (m.deskIndex !== null) taken.add(m.deskIndex)
    return this.desks.find((d) => !taken.has(d.index)) ?? null
  }

  // ── communication ─────────────────────────────────────────────────────────

  private onMessage(msg: AgentMessage): void {
    const sender = this.agents.get(msg.fromAgent)
    if (!sender) return

    // Cap bubbles.
    while (this.bubbles.length >= MAX_BUBBLES) {
      const old = this.bubbles.shift()
      if (old) {
        this.bubbleLayer.removeChild(old.bubble)
        old.bubble.destroy({ children: true })
      }
    }

    const bubble = new SpeechBubble(msg.content, {
      accentColor: sender.character.shirtColor,
    })
    bubble.x = sender.character.x
    bubble.y = sender.character.y - 56
    this.bubbleLayer.addChild(bubble)
    this.bubbles.push({ bubble, agentId: msg.fromAgent })

    // If receiver exists, sender walks toward them then back.
    const receiver = this.agents.get(msg.toAgent)
    if (receiver && receiver !== sender) {
      sender.character.setFacing(receiver.character.x >= sender.character.x ? 1 : -1)
      const sameRow =
        sender.deskIndex !== null &&
        receiver.deskIndex !== null &&
        Math.floor(sender.deskIndex / DESK_COLS) === Math.floor(receiver.deskIndex / DESK_COLS)
      if (!sameRow) {
        const offset = receiver.character.x > sender.character.x ? -40 : 40
        sender.targetX = receiver.character.x + offset
        sender.targetY = receiver.character.y
        sender.returnAfterArrival = true
        sender.walking = true
        sender.character.setWalking(true)
      } else {
        sender.returnAt = Date.now() + 2200
      }
    }
  }

  // ── tick (lean) ───────────────────────────────────────────────────────────

  private tick(deltaMs: number): void {
    const now = Date.now()

    for (const m of this.agents.values()) {
      const c = m.character
      const dx = m.targetX - c.x
      const dy = m.targetY - c.y
      if (dx * dx + dy * dy > 0.5) {
        const a = Math.min(1, WALK_ALPHA * (deltaMs / 16))
        c.x += dx * a
        c.y += dy * a
        if (!m.walking) {
          m.walking = true
          c.setWalking(true)
        }
        c.setFacing(dx >= 0 ? 1 : -1)
      } else if (m.walking) {
        c.x = m.targetX
        c.y = m.targetY
        m.walking = false
        c.setWalking(false)
        if (m.returnAfterArrival) {
          m.returnAfterArrival = false
          m.returnAt = now + 1800
        }
      }

      if (m.returnAt !== null && now >= m.returnAt) {
        m.returnAt = null
        if (m.targetX !== m.homeX || m.targetY !== m.homeY) {
          m.targetX = m.homeX
          m.targetY = m.homeY
          m.walking = true
          c.setWalking(true)
        } else {
          c.setFacing(1)
        }
      }

      c.tick(deltaMs)
    }

    // Bubbles.
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i]
      if (!b) continue
      const sender = this.agents.get(b.agentId)
      if (sender) {
        b.bubble.x = sender.character.x
        b.bubble.y = sender.character.y - 56
      }
      if (b.bubble.tick(deltaMs)) {
        this.bubbleLayer.removeChild(b.bubble)
        b.bubble.destroy({ children: true })
        this.bubbles.splice(i, 1)
      }
    }

    // Monitors — binary toggle, only redraw when mode changes.
    for (const desk of this.desks) {
      const occ = this.occupant(desk.index)
      const mode: 'coding' | 'other' = occ?.character.state === 'coding' ? 'coding' : 'other'
      if (mode !== desk.lastMode) {
        desk.lastMode = mode
        desk.monitor.clear()
        desk.monitor.beginFill(
          mode === 'coding' ? OFFICE_COLORS.monitorGlow : OFFICE_COLORS.monitorScreen,
          1,
        )
        desk.monitor.drawRoundedRect(-22, -30, 44, 18, 1.5)
        desk.monitor.endFill()
      }
    }
  }

  private occupant(deskIdx: number): ManagedAgent | null {
    for (const m of this.agents.values()) if (m.deskIndex === deskIdx) return m
    return null
  }

  // ── fixed-scale fit ───────────────────────────────────────────────────────

  private fitWorld(containerW: number, containerH: number): void {
    const scale = Math.min(containerW / WORLD_W, containerH / WORLD_H)
    this.world.scale.set(scale)
    this.world.x = (containerW - WORLD_W * scale) / 2
    this.world.y = (containerH - WORLD_H * scale) / 2
  }
}

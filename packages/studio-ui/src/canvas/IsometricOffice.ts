/**
 * IsometricOffice — front-facing Pixi.js office scene.
 *
 * Perspective: this is NOT a top-down grid. The "camera" sits at the
 * front of the room looking in. The back wall (with its window, poster,
 * clock, door, plant) takes the upper half of the canvas. The floor
 * stretches from the back wall toward the viewer in the lower half.
 * Desks and characters sit on the floor in two rows.
 *
 * Performance strategy:
 *   - Every static element (walls, floor, ceiling, fixtures, desk
 *     bodies, chairs, decorations) is drawn ONCE into a single
 *     `RenderTexture` at attach time, then rendered as one `Sprite`.
 *   - Live elements (characters, speech bubbles, monitor screens,
 *     clock hands, blocked-desk tints, recovery flash, dust motes)
 *     are the only things that redraw per frame.
 *   - Character layer has `sortableChildren = true` with zIndex = y so
 *     back-row characters are drawn behind front-row ones naturally.
 *
 * Animation strategy:
 *   - Per-frame lerps use `easeInOutQuad` for smooth start + end
 *   - `deltaMs` is passed to every tick, so movement is frame-rate
 *     independent
 *   - Pose transitions are handled inside `AgentCharacter`
 *
 * Ambient life:
 *   - Live clock hands rotate very slowly
 *   - Every 10–15s, an idle agent walks to the watercooler, stands for
 *     3s, then walks back
 *   - Characters have per-instance breathing jitter so they don't sync
 */

import {
  Application,
  Container,
  Graphics,
  RenderTexture,
  Sprite,
  Text,
} from 'pixi.js'

import {
  AgentCharacter,
  OFFICE_COLORS,
  POSE_TRANSITION_MS,
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
// Layout constants
// ─────────────────────────────────────────────────────────────────────────────

const WORLD_WIDTH = 1800
const WORLD_HEIGHT = 1000

// Vertical zones of the front-facing view.
const CEILING_H = 60
const WALL_TOP = CEILING_H
const WALL_BOTTOM = 520
const FLOOR_TOP = WALL_BOTTOM

// Desk layout — two rows of 6, row 0 closer to the viewer.
const DESK_ROW_Y = [820, 660] as const
const DESK_COLS = 6
const DESK_ORIGIN_X = 200
const DESK_COL_SPACING = 240
const DESK_WIDTH = 150
const DESK_HEIGHT = 56
const CHAIR_BACK_OFFSET = 42

// Watercooler position (on the back wall near the door).
const WATERCOOLER_X = 1480
const WATERCOOLER_Y = 470

// Camera bounds and defaults.
const MIN_ZOOM = 0.35
const MAX_ZOOM = 2.0

// Walking speed (0..1 lerp alpha per ~16ms frame).
const WALK_SPEED = 0.12

// Particles removed per A4 — they added visual noise without value
// and cost ~32 sprites updating position + alpha every frame.

const RECOVERY_FLASH_MS = 350
const WATERCOOLER_MIN_GAP_MS = 10_000
const WATERCOOLER_MAX_GAP_MS = 15_000
const WATERCOOLER_STAND_MS = 3_000

// ─────────────────────────────────────────────────────────────────────────────
// Internal types
// ─────────────────────────────────────────────────────────────────────────────

interface DeskSlot {
  index: number
  row: number
  col: number
  /** Center x of the desk. */
  x: number
  /** Top line of the desk (where the monitor sits). */
  y: number
  /** Live monitor screen graphic that glows when coding. */
  monitor: Graphics
  /** Live red tint overlay that fades in when the occupant is blocked. */
  tint: Graphics
  /** Cached monitor visual state so we skip redraws when nothing changed. */
  lastMonitorMode: 'coding' | 'blocked' | 'normal' | null
}

interface WatercoolerTrip {
  phase: 'going' | 'standing' | 'returning'
  phaseEndsAt: number
}

interface ManagedAgent {
  character: AgentCharacter
  deskIndex: number | null
  targetX: number
  targetY: number
  homeX: number
  homeY: number
  walking: boolean
  /** True if the character is on a round trip and should auto-return. */
  returnAfterArrival: boolean
  /** Wall-clock ms when the return-after-arrival timer should fire. */
  returnTimerAt: number | null
  /** Non-null while the agent is on a watercooler round trip. */
  watercooler: WatercoolerTrip | null
  /** Index used to look up shirt color for speech-bubble borders. */
  cosmeticIndex: number
}

interface ActiveBubble {
  bubble: SpeechBubble
  agentId: string
}

export interface IsometricOfficeOptions {
  onSelectAgent?: (id: string) => void
  onDeselect?: () => void
  /**
   * Base URL prefix for sprite assets. Defaults to '/assets/sprites'
   * which works with Vite's public folder serving. If sprite-manifest.json
   * isn't reachable there, the scene silently falls back to programmatic
   * rendering.
   */
  spritesBaseUrl?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// IsometricOffice
// ─────────────────────────────────────────────────────────────────────────────

export class IsometricOffice {
  private app: Application | null = null
  private hostElement: HTMLDivElement | null = null

  // Layers (z-ordered)
  private readonly world = new Container()
  private backgroundSprite: Sprite | null = null
  private readonly dynamicFurnitureLayer = new Container() // monitor screens, desk tints
  private readonly clockHands = new Container()
  private readonly particleLayer = new Container()
  private readonly characterLayer = new Container()
  private readonly bubbleLayer = new Container()
  private readonly flashOverlay = new Graphics()

  // Per-frame clock hand graphics.
  private hourHand = new Graphics()
  private minuteHand = new Graphics()
  private secondHand = new Graphics()

  // World state.
  private readonly particles: Graphics[] = []
  private readonly desks: DeskSlot[] = []
  private readonly agents = new Map<string, ManagedAgent>()
  private readonly bubbles: ActiveBubble[] = []
  private selectedAgentId: string | null = null
  private readonly options: IsometricOfficeOptions
  private cosmeticCounter = 0
  private spawnedCount = 0
  private flashRemaining = 0
  private nextWatercoolerAt = 0
  private currentWatercoolerAgentId: string | null = null

  // Sprite assets (null until loaded or if manifest is unavailable).
  private spriteAssets: OfficeAssets | null = null

  // FPS counter — visible during dev, removed before ship.
  private fpsText: Text | null = null
  private fpsFrameCount = 0
  private fpsLastSample = 0

  // Camera state.
  private cameraX = 0
  private cameraY = 0
  private cameraZoom = 0.6
  private dragging = false
  private dragStartX = 0
  private dragStartY = 0
  private cameraStartX = 0
  private cameraStartY = 0

  // Cleanup callbacks.
  private cleanup: Array<() => void> = []

  constructor(options: IsometricOfficeOptions = {}) {
    this.options = options
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  async attach(host: HTMLDivElement): Promise<void> {
    if (this.app) return
    this.hostElement = host

    const rect = host.getBoundingClientRect()
    const app = new Application({
      width: Math.max(320, rect.width),
      height: Math.max(240, rect.height),
      backgroundColor: OFFICE_COLORS.ceiling,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
      eventMode: 'passive',
    })
    this.app = app
    host.appendChild(app.view as HTMLCanvasElement)
    const canvas = app.view as HTMLCanvasElement
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    canvas.style.display = 'block'

    app.stage.addChild(this.world)

    // Try to load sprite assets from the manifest. If anything fails,
    // `spriteAssets` stays null and the scene falls back to the
    // programmatic RenderTexture bake below.
    const spritesBase = this.options.spritesBaseUrl ?? '/assets/sprites'
    try {
      this.spriteAssets = await loadOfficeAssets(spritesBase)
    } catch {
      this.spriteAssets = null
    }

    // Bake the static background ONCE — this is the big perf win.
    // In sprite mode, the bake composites the background PNG + all
    // furniture sprites into one texture. In procedural mode, it
    // falls back to drawing everything as Graphics.
    this.backgroundSprite = this.bakeBackground(app)
    this.world.addChild(this.backgroundSprite)

    // Live layers go on top.
    this.buildDesks()
    this.world.addChild(this.dynamicFurnitureLayer)
    this.buildClockHands()
    this.world.addChild(this.clockHands)
    this.characterLayer.sortableChildren = true
    this.world.addChild(this.characterLayer)
    this.world.addChild(this.bubbleLayer)

    // Flash overlay sits on top of the world, under the camera transform,
    // so it fills the whole world regardless of zoom.
    this.flashOverlay.beginFill(OFFICE_COLORS.recoveryFlash, 1)
    this.flashOverlay.drawRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT)
    this.flashOverlay.endFill()
    this.flashOverlay.alpha = 0
    this.world.addChild(this.flashOverlay)

    this.centerCamera()
    this.applyCamera()

    // Click-on-empty = deselect.
    app.stage.eventMode = 'static'
    app.stage.hitArea = app.screen
    app.stage.on('pointerdown', (event) => {
      if (event.target === app.stage) {
        this.options.onDeselect?.()
      }
    })

    // DOM-level pan / zoom on the canvas.
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 && event.button !== 1) return
      this.dragging = true
      this.dragStartX = event.clientX
      this.dragStartY = event.clientY
      this.cameraStartX = this.cameraX
      this.cameraStartY = this.cameraY
      canvas.setPointerCapture(event.pointerId)
    }
    const onPointerMove = (event: PointerEvent) => {
      if (!this.dragging) return
      const dx = event.clientX - this.dragStartX
      const dy = event.clientY - this.dragStartY
      if (Math.abs(dx) + Math.abs(dy) < 3) return
      this.cameraX = this.cameraStartX + dx
      this.cameraY = this.cameraStartY + dy
      this.applyCamera()
    }
    const onPointerUp = (event: PointerEvent) => {
      this.dragging = false
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId)
      }
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const direction = event.deltaY > 0 ? -1 : 1
      const factor = 1 + direction * 0.1
      const prevZoom = this.cameraZoom
      this.cameraZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.cameraZoom * factor))
      const canvasRect = canvas.getBoundingClientRect()
      const localX = event.clientX - canvasRect.left
      const localY = event.clientY - canvasRect.top
      const worldX = (localX - this.cameraX) / prevZoom
      const worldY = (localY - this.cameraY) / prevZoom
      this.cameraX = localX - worldX * this.cameraZoom
      this.cameraY = localY - worldY * this.cameraZoom
      this.applyCamera()
    }
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    this.cleanup.push(() => canvas.removeEventListener('pointerdown', onPointerDown))
    this.cleanup.push(() => canvas.removeEventListener('pointermove', onPointerMove))
    this.cleanup.push(() => canvas.removeEventListener('pointerup', onPointerUp))
    this.cleanup.push(() => canvas.removeEventListener('pointercancel', onPointerUp))
    this.cleanup.push(() => canvas.removeEventListener('wheel', onWheel))

    const resize = () => {
      if (!this.app || !this.hostElement) return
      const r = this.hostElement.getBoundingClientRect()
      this.app.renderer.resize(Math.max(320, r.width), Math.max(240, r.height))
      this.applyCamera()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(host)
    this.cleanup.push(() => ro.disconnect())

    this.nextWatercoolerAt =
      Date.now() + WATERCOOLER_MIN_GAP_MS +
      Math.random() * (WATERCOOLER_MAX_GAP_MS - WATERCOOLER_MIN_GAP_MS)

    // Dev-only FPS counter — sits on the stage (not the world) so it
    // doesn't zoom. Remove this block before shipping.
    this.fpsText = new Text('-- fps', {
      fontFamily: 'JetBrains Mono, ui-monospace, Menlo, monospace',
      fontSize: 12,
      fill: 0x4ecdc4,
    })
    this.fpsText.x = 8
    this.fpsText.y = 8
    app.stage.addChild(this.fpsText)
    this.fpsLastSample = performance.now()

    app.ticker.add((delta) => {
      const deltaMs = delta * (1000 / 60)
      this.tick(deltaMs)

      // Update FPS counter every 30 frames.
      this.fpsFrameCount += 1
      if (this.fpsFrameCount >= 30) {
        const now = performance.now()
        const elapsed = now - this.fpsLastSample
        const fps = Math.round((this.fpsFrameCount * 1000) / elapsed)
        if (this.fpsText) this.fpsText.text = `${fps} fps`
        this.fpsLastSample = now
        this.fpsFrameCount = 0
      }
    })
  }

  detach(): void {
    for (const fn of this.cleanup) {
      try {
        fn()
      } catch {
        // Ignore.
      }
    }
    this.cleanup = []

    for (const managed of this.agents.values()) {
      managed.character.destroy({ children: true })
    }
    this.agents.clear()
    for (const active of this.bubbles) {
      active.bubble.destroy({ children: true })
    }
    this.bubbles.length = 0
    for (const p of this.particles) p.destroy()
    this.particles.length = 0

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

  // ── public API ─────────────────────────────────────────────────────────────

  setAgents(agents: readonly AgentInfo[]): void {
    const seen = new Set<string>()
    for (const info of agents) {
      seen.add(info.id)
      const existing = this.agents.get(info.id)
      if (existing) {
        existing.character.setState(info.state)
        existing.character.setName(info.name)
      } else {
        this.spawnAgent(info)
      }
    }
    for (const id of this.agents.keys()) {
      if (!seen.has(id)) this.removeAgent(id)
    }
  }

  applyEvent(event: StudioEvent): void {
    switch (event.type) {
      case 'agent:spawned':
        if (!this.agents.has(event.agent.id)) this.spawnAgent(event.agent)
        return
      case 'agent:state-changed': {
        const managed = this.agents.get(event.agentId)
        if (!managed) return
        const prev = managed.character.state
        managed.character.setState(event.newState)
        if (
          (prev === 'blocked' || prev === 'error') &&
          event.newState !== 'blocked' &&
          event.newState !== 'error'
        ) {
          this.flashRemaining = RECOVERY_FLASH_MS
        }
        return
      }
      case 'agent:terminated':
        this.removeAgent(event.agentId)
        return
      case 'message:sent':
        this.handleMessage(event.message)
        return
      default:
        return
    }
  }

  setSelectedAgent(id: string | null): void {
    if (id === this.selectedAgentId) return
    if (this.selectedAgentId) {
      this.agents.get(this.selectedAgentId)?.character.setSelected(false)
    }
    this.selectedAgentId = id
    if (id) {
      this.agents.get(id)?.character.setSelected(true)
    }
  }

  // ── scene bake ────────────────────────────────────────────────────────────

  /**
   * Render every static element into a RenderTexture and return a
   * single Sprite that displays it. After this call, the input
   * container is destroyed — only the texture remains in memory.
   *
   * Two paths:
   *   - Sprite mode (assets loaded): composite the background PNG +
   *     placed furniture sprites into a single RenderTexture.
   *   - Procedural mode: draw everything with Graphics primitives.
   */
  private bakeBackground(app: Application): Sprite {
    const bg = new Container()

    if (this.spriteAssets) {
      this.composeSpriteBackground(bg, this.spriteAssets)
    } else {
      this.drawCeiling(bg)
      this.drawBackWall(bg)
      this.drawFloor(bg)
      this.drawBookshelf(bg)
      this.drawFilingCabinet(bg)
      this.drawTrashCan(bg)
      this.drawWatercooler(bg)
      this.drawStaticDesks(bg)
    }

    const texture = RenderTexture.create({
      width: WORLD_WIDTH,
      height: WORLD_HEIGHT,
      resolution: window.devicePixelRatio || 1,
    })
    app.renderer.render(bg, { renderTexture: texture })
    bg.destroy({ children: true })

    const sprite = new Sprite(texture)
    sprite.x = 0
    sprite.y = 0
    return sprite
  }

  /**
   * Compose the sprite-based static layer: stretch the background PNG
   * across the world, then place individual furniture sprites on top
   * at fixed positions. Called from bakeBackground when sprite assets
   * are available. Everything gets flattened into one RenderTexture.
   */
  private composeSpriteBackground(parent: Container, assets: OfficeAssets): void {
    // 1. Background image — stretched to fill the entire world.
    const bgSprite = new Sprite(assets.background)
    bgSprite.width = WORLD_WIDTH
    bgSprite.height = WORLD_HEIGHT
    parent.addChild(bgSprite)

    // 2. Wall fixtures. Use sprite if present, skip silently otherwise.
    // Each placement is: [furniture name, x, y, anchor-y (0=top, 1=bottom)]
    const wallPlacements: Array<[string, number, number, number]> = [
      ['window', 300, 240, 0.5],
      ['poster-ship-it', 680, 230, 0.5],
      ['clock', 920, 240, 0.5],
      ['whiteboard', 500, 380, 1],
    ]
    for (const [name, x, y, anchorY] of wallPlacements) {
      const tex = assets.furniture.get(name)
      if (!tex) continue
      const s = new Sprite(tex)
      s.anchor.set(0.5, anchorY)
      s.x = x
      s.y = y
      parent.addChild(s)
    }

    // 3. Floor fixtures along the back wall — bookshelf + filing cabinet.
    const floorFixtures: Array<[string, number, number]> = [
      ['bookshelf', 100, WORLD_HEIGHT - 40],
      ['filing-cabinet', 220, WORLD_HEIGHT - 40],
      ['plant', 1640, WORLD_HEIGHT - 40],
      ['water-cooler', WATERCOOLER_X, WATERCOOLER_Y + 90],
      ['trash-can', 1700, WORLD_HEIGHT - 40],
      ['ceiling-light', WORLD_WIDTH / 2, 30],
    ]
    for (const [name, x, y] of floorFixtures) {
      const tex = assets.furniture.get(name)
      if (!tex) continue
      const s = new Sprite(tex)
      s.anchor.set(0.5, 1) // bottom-center so things sit on their y line
      s.x = x
      s.y = y
      parent.addChild(s)
    }

    // 4. Desks + chairs at every desk slot.
    const deskTex = assets.furniture.get('desk')
    const chairTex = assets.furniture.get('chair')
    for (let row = 0; row < DESK_ROW_Y.length; row += 1) {
      const rowY = DESK_ROW_Y[row]
      if (rowY === undefined) continue
      for (let col = 0; col < DESK_COLS; col += 1) {
        const x = DESK_ORIGIN_X + col * DESK_COL_SPACING
        if (chairTex) {
          const chair = new Sprite(chairTex)
          chair.anchor.set(0.5, 1)
          chair.x = x
          chair.y = rowY - 20
          parent.addChild(chair)
        }
        if (deskTex) {
          const desk = new Sprite(deskTex)
          desk.anchor.set(0.5, 1)
          desk.x = x
          desk.y = rowY + 30
          parent.addChild(desk)
        }
      }
    }
  }

  private drawCeiling(parent: Container): void {
    const ceiling = new Graphics()
    ceiling.beginFill(OFFICE_COLORS.ceiling, 1)
    ceiling.drawRect(0, 0, WORLD_WIDTH, CEILING_H)
    ceiling.endFill()
    // Ceiling rails / trim.
    ceiling.beginFill(OFFICE_COLORS.backWallTrim, 1)
    ceiling.drawRect(0, CEILING_H - 4, WORLD_WIDTH, 4)
    ceiling.endFill()
    parent.addChild(ceiling)

    // Two rectangular fluorescent lights with a soft glow halo.
    const lights = new Graphics()
    for (let i = 0; i < 3; i += 1) {
      const cx = 340 + i * 560
      // Halo
      lights.beginFill(OFFICE_COLORS.ceilingLightGlow, 0.18)
      lights.drawEllipse(cx, CEILING_H / 2, 140, 22)
      lights.endFill()
      // Body
      lights.lineStyle({ width: 1, color: 0x1c1c28, alpha: 0.9 })
      lights.beginFill(OFFICE_COLORS.ceilingLight, 1)
      lights.drawRoundedRect(cx - 90, 14, 180, 16, 3)
      lights.endFill()
      // Center filament line
      lights.lineStyle({ width: 0 })
      lights.beginFill(0xffe6a0, 1)
      lights.drawRect(cx - 80, 20, 160, 4)
      lights.endFill()
    }
    parent.addChild(lights)
  }

  private drawBackWall(parent: Container): void {
    const wall = new Graphics()
    wall.beginFill(OFFICE_COLORS.backWall, 1)
    wall.drawRect(0, WALL_TOP, WORLD_WIDTH, WALL_BOTTOM - WALL_TOP)
    wall.endFill()
    // Wall trim at the top and bottom.
    wall.beginFill(OFFICE_COLORS.backWallTrim, 1)
    wall.drawRect(0, WALL_TOP, WORLD_WIDTH, 6)
    wall.drawRect(0, WALL_BOTTOM - 8, WORLD_WIDTH, 8)
    wall.endFill()
    parent.addChild(wall)

    // Window (left side) with sky gradient.
    const windowGroup = new Container()
    const windowFrame = new Graphics()
    const winX = 140
    const winY = WALL_TOP + 70
    const winW = 260
    const winH = 180
    // Frame
    windowFrame.beginFill(OFFICE_COLORS.windowFrame, 1)
    windowFrame.drawRoundedRect(winX - 8, winY - 8, winW + 16, winH + 16, 4)
    windowFrame.endFill()
    windowGroup.addChild(windowFrame)
    // Sky gradient — fake it with a dozen horizontal bands.
    const sky = new Graphics()
    for (let i = 0; i < 18; i += 1) {
      const t = i / 17
      const r = Math.round(lerpByte(0x67, 0x2f, t))
      const g = Math.round(lerpByte(0xc7, 0x6e, t))
      const b = Math.round(lerpByte(0xf0, 0xa3, t))
      const color = (r << 16) | (g << 8) | b
      sky.beginFill(color, 1)
      sky.drawRect(winX, winY + (winH * i) / 18, winW, winH / 18 + 0.5)
      sky.endFill()
    }
    windowGroup.addChild(sky)
    // Clouds
    const clouds = new Graphics()
    clouds.beginFill(OFFICE_COLORS.cloud, 0.9)
    clouds.drawEllipse(winX + 60, winY + 40, 24, 10)
    clouds.drawEllipse(winX + 78, winY + 36, 18, 8)
    clouds.drawEllipse(winX + 180, winY + 80, 26, 11)
    clouds.drawEllipse(winX + 200, winY + 75, 16, 7)
    clouds.drawEllipse(winX + 120, winY + 110, 22, 9)
    clouds.endFill()
    windowGroup.addChild(clouds)
    // Window cross bars.
    const bars = new Graphics()
    bars.lineStyle({ width: 3, color: OFFICE_COLORS.windowFrame, alpha: 1 })
    bars.moveTo(winX + winW / 2, winY)
    bars.lineTo(winX + winW / 2, winY + winH)
    bars.moveTo(winX, winY + winH / 2)
    bars.lineTo(winX + winW, winY + winH / 2)
    windowGroup.addChild(bars)
    parent.addChild(windowGroup)

    // Plant between window and poster.
    const plant = new Graphics()
    const plantX = 470
    const plantY = winY + winH + 8
    plant.beginFill(OFFICE_COLORS.plantPot, 1)
    plant.drawRoundedRect(plantX - 16, plantY, 32, 22, 2)
    plant.endFill()
    plant.lineStyle({ width: 1, color: 0x3a2410, alpha: 0.6 })
    plant.moveTo(plantX - 16, plantY + 6)
    plant.lineTo(plantX + 16, plantY + 6)
    plant.lineStyle({ width: 0 })
    plant.beginFill(OFFICE_COLORS.plantLeaf, 1)
    plant.drawPolygon([plantX, plantY - 30, plantX - 14, plantY - 2, plantX + 14, plantY - 2])
    plant.drawPolygon([plantX - 12, plantY - 20, plantX - 26, plantY - 2, plantX + 2, plantY - 2])
    plant.drawPolygon([plantX + 12, plantY - 24, plantX - 2, plantY - 2, plantX + 26, plantY - 2])
    plant.endFill()
    parent.addChild(plant)

    // Motivational poster.
    const poster = new Container()
    const posterX = 600
    const posterY = winY + 20
    const posterW = 140
    const posterH = 90
    const posterBg = new Graphics()
    posterBg.lineStyle({ width: 3, color: OFFICE_COLORS.posterBorder, alpha: 1 })
    posterBg.beginFill(OFFICE_COLORS.poster, 1)
    posterBg.drawRoundedRect(posterX, posterY, posterW, posterH, 3)
    posterBg.endFill()
    poster.addChild(posterBg)
    const posterText = new Text('SHIP IT', {
      fontFamily: 'Instrument Sans, ui-sans-serif, system-ui, sans-serif',
      fontSize: 24,
      fontWeight: '700',
      fill: OFFICE_COLORS.posterText,
      letterSpacing: 2,
    })
    posterText.anchor.set(0.5, 0.5)
    posterText.x = posterX + posterW / 2
    posterText.y = posterY + posterH / 2 - 6
    poster.addChild(posterText)
    const posterTag = new Text('— Every Day', {
      fontFamily: 'Instrument Sans, ui-sans-serif, system-ui, sans-serif',
      fontSize: 10,
      fill: OFFICE_COLORS.posterBorder,
    })
    posterTag.anchor.set(0.5, 0.5)
    posterTag.x = posterX + posterW / 2
    posterTag.y = posterY + posterH - 14
    poster.addChild(posterTag)
    parent.addChild(poster)

    // Wall clock (face only — hands are live).
    const clock = new Graphics()
    const clockX = 880
    const clockY = winY + 70
    const clockR = 48
    clock.lineStyle({ width: 4, color: OFFICE_COLORS.clockBorder, alpha: 1 })
    clock.beginFill(OFFICE_COLORS.clockFace, 1)
    clock.drawCircle(clockX, clockY, clockR)
    clock.endFill()
    // Tick marks
    clock.lineStyle({ width: 2, color: OFFICE_COLORS.clockBorder, alpha: 0.85 })
    for (let i = 0; i < 12; i += 1) {
      const a = (i / 12) * Math.PI * 2 - Math.PI / 2
      const x1 = clockX + Math.cos(a) * (clockR - 6)
      const y1 = clockY + Math.sin(a) * (clockR - 6)
      const x2 = clockX + Math.cos(a) * (clockR - 2)
      const y2 = clockY + Math.sin(a) * (clockR - 2)
      clock.moveTo(x1, y1)
      clock.lineTo(x2, y2)
    }
    parent.addChild(clock)
    // Record the clock center so `buildClockHands` can place hands over it.
    this._clockX = clockX
    this._clockY = clockY
    this._clockR = clockR

    // Door on the right side of the wall.
    const door = new Graphics()
    const doorX = 1220
    const doorY = WALL_TOP + 90
    const doorW = 90
    const doorH = WALL_BOTTOM - doorY - 14
    door.lineStyle({ width: 4, color: OFFICE_COLORS.doorFrame, alpha: 1 })
    door.beginFill(OFFICE_COLORS.door, 1)
    door.drawRoundedRect(doorX, doorY, doorW, doorH, 3)
    door.endFill()
    // Panel lines
    door.lineStyle({ width: 1.5, color: OFFICE_COLORS.doorFrame, alpha: 0.8 })
    door.drawRect(doorX + 10, doorY + 10, doorW - 20, doorH / 2 - 14)
    door.drawRect(doorX + 10, doorY + doorH / 2 + 4, doorW - 20, doorH / 2 - 18)
    // Knob
    door.lineStyle({ width: 0 })
    door.beginFill(OFFICE_COLORS.doorKnob, 1)
    door.drawCircle(doorX + doorW - 14, doorY + doorH / 2, 3)
    door.endFill()
    parent.addChild(door)
  }

  private _clockX = 0
  private _clockY = 0
  private _clockR = 0

  private drawFloor(parent: Container): void {
    const floor = new Graphics()
    floor.beginFill(OFFICE_COLORS.floor, 1)
    floor.drawRect(0, FLOOR_TOP, WORLD_WIDTH, WORLD_HEIGHT - FLOOR_TOP)
    floor.endFill()
    // Horizontal carpet / tile lines, every 20px.
    floor.lineStyle({ width: 1, color: OFFICE_COLORS.floorLine, alpha: 0.6 })
    for (let y = FLOOR_TOP + 20; y < WORLD_HEIGHT; y += 20) {
      floor.moveTo(0, y)
      floor.lineTo(WORLD_WIDTH, y)
    }
    parent.addChild(floor)
  }

  private drawBookshelf(parent: Container): void {
    const shelf = new Graphics()
    const sx = 40
    const sy = WALL_BOTTOM + 30
    const sw = 140
    const sh = 280
    shelf.lineStyle({ width: 3, color: 0x2a1a08, alpha: 1 })
    shelf.beginFill(OFFICE_COLORS.bookshelfBody, 1)
    shelf.drawRect(sx, sy, sw, sh)
    shelf.endFill()
    // Shelf dividers
    shelf.beginFill(OFFICE_COLORS.bookshelfShelf, 1)
    for (let i = 1; i < 4; i += 1) {
      shelf.drawRect(sx + 4, sy + (sh / 4) * i - 2, sw - 8, 4)
    }
    shelf.endFill()
    parent.addChild(shelf)
    // Books on each shelf.
    const bookColors = [0xef4444, 0x10b981, 0x3b82f6, 0xf59e0b, 0xa78bfa, 0xec4899, 0x22d3ee]
    const books = new Graphics()
    for (let row = 0; row < 4; row += 1) {
      let bx = sx + 8
      const by = sy + (sh / 4) * row + 8
      while (bx < sx + sw - 16) {
        const w = 8 + Math.floor(Math.random() * 8)
        const h = (sh / 4) - 14
        const color = bookColors[Math.floor(Math.random() * bookColors.length)] ?? 0x3b82f6
        books.lineStyle({ width: 0.8, color: OFFICE_COLORS.backWallTrim, alpha: 0.7 })
        books.beginFill(color, 1)
        books.drawRect(bx, by, w, h)
        books.endFill()
        bx += w + 1
      }
    }
    parent.addChild(books)
  }

  private drawFilingCabinet(parent: Container): void {
    const cab = new Graphics()
    const cx = 200
    const cy = WALL_BOTTOM + 40
    const cw = 90
    const ch = 220
    cab.lineStyle({ width: 2, color: 0x2c3140, alpha: 1 })
    cab.beginFill(OFFICE_COLORS.cabinetBody, 1)
    cab.drawRoundedRect(cx, cy, cw, ch, 2)
    cab.endFill()
    // Drawer dividers.
    cab.lineStyle({ width: 1.5, color: OFFICE_COLORS.cabinetLine, alpha: 1 })
    for (let i = 1; i < 4; i += 1) {
      const y = cy + (ch / 4) * i
      cab.moveTo(cx + 3, y)
      cab.lineTo(cx + cw - 3, y)
    }
    // Drawer handles.
    cab.lineStyle({ width: 0 })
    cab.beginFill(OFFICE_COLORS.cabinetHandle, 1)
    for (let i = 0; i < 4; i += 1) {
      const y = cy + (ch / 4) * (i + 0.5)
      cab.drawCircle(cx + cw / 2, y, 2.5)
    }
    cab.endFill()
    parent.addChild(cab)
  }

  private drawTrashCan(parent: Container): void {
    const trash = new Graphics()
    const tx = 1620
    const ty = WORLD_HEIGHT - 90
    trash.lineStyle({ width: 2, color: 0x0a0e14, alpha: 0.9 })
    trash.beginFill(OFFICE_COLORS.trashCan, 1)
    trash.drawRoundedRect(tx, ty, 32, 46, 3)
    trash.endFill()
    trash.lineStyle({ width: 1, color: 0x5e626e, alpha: 0.7 })
    for (let i = 0; i < 3; i += 1) {
      trash.drawRect(tx + 4, ty + 8 + i * 12, 24, 2)
    }
    parent.addChild(trash)
  }

  private drawWatercooler(parent: Container): void {
    const cooler = new Graphics()
    const wx = WATERCOOLER_X
    const wy = WATERCOOLER_Y
    cooler.lineStyle({ width: 2, color: 0x2c3140, alpha: 1 })
    cooler.beginFill(OFFICE_COLORS.watercoolerBase, 1)
    cooler.drawRoundedRect(wx - 24, wy + 30, 48, 36, 4)
    cooler.endFill()
    cooler.lineStyle({ width: 1.5, color: 0x2c3140, alpha: 1 })
    cooler.beginFill(OFFICE_COLORS.watercooler, 0.85)
    cooler.drawRoundedRect(wx - 20, wy - 20, 40, 50, 6)
    cooler.endFill()
    cooler.beginFill(0xcbd5f5, 0.95)
    cooler.drawRoundedRect(wx - 16, wy - 16, 32, 42, 4)
    cooler.endFill()
    // Tap
    cooler.beginFill(0x0a0e14, 1)
    cooler.drawRect(wx - 2, wy + 30, 4, 6)
    cooler.endFill()
    parent.addChild(cooler)

    // Label
    const label = new Text('WATER', {
      fontFamily: 'JetBrains Mono, ui-monospace, Menlo, monospace',
      fontSize: 9,
      fill: 0x4ecdc4,
      letterSpacing: 1.2,
    })
    label.anchor.set(0.5, 0)
    label.x = wx
    label.y = wy + 70
    parent.addChild(label)
  }

  /** Draw the part of each desk that never changes (top, front, chair, decorations). */
  private drawStaticDesks(parent: Container): void {
    for (let row = 0; row < DESK_ROW_Y.length; row += 1) {
      const rowY = DESK_ROW_Y[row]
      if (rowY === undefined) continue
      for (let col = 0; col < DESK_COLS; col += 1) {
        const x = DESK_ORIGIN_X + col * DESK_COL_SPACING
        this.drawOneDesk(parent, x, rowY, row * DESK_COLS + col)
      }
    }
  }

  private drawOneDesk(parent: Container, x: number, y: number, deterministicSeed: number): void {
    // Chair behind the desk.
    const chair = new Graphics()
    chair.lineStyle({ width: 2, color: 0x0f1a38, alpha: 1 })
    chair.beginFill(OFFICE_COLORS.chair, 1)
    chair.drawRoundedRect(x - 22, y - CHAIR_BACK_OFFSET, 44, 40, 6)
    chair.endFill()
    chair.beginFill(OFFICE_COLORS.chairHighlight, 1)
    chair.drawRoundedRect(x - 20, y - CHAIR_BACK_OFFSET + 3, 40, 18, 4)
    chair.endFill()
    // Wheel base
    chair.beginFill(OFFICE_COLORS.chair, 1)
    chair.drawRoundedRect(x - 4, y - 6, 8, 14, 2)
    chair.endFill()
    parent.addChild(chair)

    // Desk top + front (front-facing perspective: top is slightly above
    // the floor contact line, front panel extends down to hide legs).
    const desk = new Graphics()
    desk.lineStyle({ width: 2, color: OFFICE_COLORS.deskEdge, alpha: 1 })
    desk.beginFill(OFFICE_COLORS.deskFront, 1)
    desk.drawRoundedRect(x - DESK_WIDTH / 2, y + 4, DESK_WIDTH, DESK_HEIGHT, 3)
    desk.endFill()
    desk.beginFill(OFFICE_COLORS.deskTop, 1)
    desk.drawRoundedRect(x - DESK_WIDTH / 2, y - 2, DESK_WIDTH, 12, 2)
    desk.endFill()
    parent.addChild(desk)

    // Decorations — deterministic per desk so the layout stays stable.
    const rnd = mulberry32(0x5a17 + deterministicSeed * 97)
    const showCoffee = rnd() > 0.35
    const showPlant = rnd() > 0.5
    const showPencils = rnd() > 0.3
    const paperCount = Math.floor(rnd() * 3)

    // Monitor frame (baked — only the SCREEN is live).
    const monitorFrame = new Graphics()
    monitorFrame.lineStyle({ width: 1, color: OFFICE_COLORS.monitorFrame, alpha: 1 })
    monitorFrame.beginFill(OFFICE_COLORS.monitorFrame, 1)
    monitorFrame.drawRoundedRect(x - 26, y - 32, 52, 24, 2)
    monitorFrame.endFill()
    // Monitor stand
    monitorFrame.beginFill(OFFICE_COLORS.monitorFrame, 1)
    monitorFrame.drawRoundedRect(x - 8, y - 10, 16, 6, 1)
    monitorFrame.drawRoundedRect(x - 14, y - 5, 28, 3, 1)
    monitorFrame.endFill()
    parent.addChild(monitorFrame)

    // Coffee mug
    if (showCoffee) {
      const mx = x - DESK_WIDTH / 2 + 18
      const my = y + 6
      const mug = new Graphics()
      mug.lineStyle({ width: 1, color: 0x0a0e14, alpha: 0.8 })
      mug.beginFill(OFFICE_COLORS.coffeeMug, 1)
      mug.drawRoundedRect(mx - 4, my - 8, 8, 8, 1)
      mug.endFill()
      // Handle
      mug.lineStyle({ width: 1.2, color: OFFICE_COLORS.coffeeMugHandle, alpha: 1 })
      mug.drawCircle(mx + 5, my - 4, 2.5)
      // Coffee liquid
      mug.lineStyle({ width: 0 })
      mug.beginFill(OFFICE_COLORS.coffeeLiquid, 1)
      mug.drawRect(mx - 3, my - 7, 6, 1.2)
      mug.endFill()
      parent.addChild(mug)
    }

    // Small plant pot
    if (showPlant) {
      const px = x + DESK_WIDTH / 2 - 16
      const py = y + 4
      const plant = new Graphics()
      plant.lineStyle({ width: 1, color: 0x3a2410, alpha: 0.8 })
      plant.beginFill(OFFICE_COLORS.deskPlantPot, 1)
      plant.drawRoundedRect(px - 5, py - 6, 10, 8, 1.2)
      plant.endFill()
      plant.lineStyle({ width: 0 })
      plant.beginFill(OFFICE_COLORS.deskPlantLeaf, 1)
      plant.drawPolygon([px, py - 18, px - 6, py - 6, px + 6, py - 6])
      plant.drawPolygon([px - 4, py - 14, px - 10, py - 5, px + 2, py - 5])
      plant.drawPolygon([px + 4, py - 16, px - 2, py - 5, px + 10, py - 5])
      plant.endFill()
      parent.addChild(plant)
    }

    // Pencil holder
    if (showPencils) {
      const hx = x - 6
      const hy = y + 4
      const holder = new Graphics()
      holder.lineStyle({ width: 1, color: 0x0a0e14, alpha: 0.8 })
      holder.beginFill(OFFICE_COLORS.pencilHolder, 1)
      holder.drawRoundedRect(hx - 5, hy - 7, 10, 9, 1.5)
      holder.endFill()
      // Pencils sticking up
      const pencilColors = [0xef4444, 0xfbbf24, 0x10b981]
      holder.lineStyle({ width: 0 })
      for (let i = 0; i < 3; i += 1) {
        holder.beginFill(pencilColors[i] ?? 0xfbbf24, 1)
        holder.drawRect(hx - 3 + i * 2.5, hy - 11, 1.6, 5)
        holder.endFill()
      }
    }

    // Scattered papers
    for (let i = 0; i < paperCount; i += 1) {
      const paper = new Graphics()
      const px = x + 12 + i * 8 - 6
      const py = y + 6
      paper.lineStyle({ width: 0.8, color: 0x9ca3af, alpha: 0.7 })
      paper.beginFill(OFFICE_COLORS.paper, 1)
      paper.drawRect(px - 4, py - 6, 8, 5)
      paper.endFill()
      paper.rotation = (rnd() - 0.5) * 0.3
      paper.x = px
      paper.y = py
      parent.addChild(paper)
    }
  }

  // ── live elements ────────────────────────────────────────────────────────

  /** Build the per-desk live graphics (monitor screen + blocked tint). */
  private buildDesks(): void {
    for (let row = 0; row < DESK_ROW_Y.length; row += 1) {
      const rowY = DESK_ROW_Y[row]
      if (rowY === undefined) continue
      for (let col = 0; col < DESK_COLS; col += 1) {
        const index = row * DESK_COLS + col
        const x = DESK_ORIGIN_X + col * DESK_COL_SPACING

        const monitor = new Graphics()
        monitor.x = x
        monitor.y = rowY
        this.dynamicFurnitureLayer.addChild(monitor)

        const tint = new Graphics()
        tint.beginFill(OFFICE_COLORS.blockedTint, 1)
        tint.drawRoundedRect(-DESK_WIDTH / 2 - 6, -40, DESK_WIDTH + 12, 80, 4)
        tint.endFill()
        tint.x = x
        tint.y = rowY
        tint.alpha = 0
        this.dynamicFurnitureLayer.addChild(tint)

        this.desks.push({ index, row, col, x, y: rowY, monitor, tint, lastMonitorMode: null })
      }
    }
  }

  private buildClockHands(): void {
    this.hourHand = new Graphics()
    this.minuteHand = new Graphics()
    this.secondHand = new Graphics()
    this.hourHand.x = this._clockX
    this.hourHand.y = this._clockY
    this.minuteHand.x = this._clockX
    this.minuteHand.y = this._clockY
    this.secondHand.x = this._clockX
    this.secondHand.y = this._clockY
    this.clockHands.addChild(this.hourHand)
    this.clockHands.addChild(this.minuteHand)
    this.clockHands.addChild(this.secondHand)
  }

  // ── agent lifecycle ────────────────────────────────────────────────────────

  private spawnAgent(info: AgentInfo): void {
    const desk = this.nextAvailableDesk()
    const cosmeticIndex = this.cosmeticCounter++
    const cosmetics = cosmeticsForIndex(cosmeticIndex)
    // In sprite mode, grab the character variant for this agent's role.
    const spriteSet = this.spriteAssets?.characters.get(info.type as AgentType)
    const character = new AgentCharacter(info, {
      ...cosmetics,
      ...(spriteSet ? { sprites: spriteSet } : {}),
    })
    character.on('pointerdown', (event) => {
      event.stopPropagation()
      this.options.onSelectAgent?.(info.id)
    })

    let homeX: number
    let homeY: number
    if (desk) {
      homeX = desk.x
      homeY = desk.y - 6
    } else {
      homeX = 900 + (this.spawnedCount * 40 - 100)
      homeY = WORLD_HEIGHT - 120
    }

    // Characters enter from the door on the right.
    character.x = 1260
    character.y = WORLD_HEIGHT - 60
    character.setWalking(true)
    this.characterLayer.addChild(character)

    this.agents.set(info.id, {
      character,
      deskIndex: desk ? desk.index : null,
      targetX: homeX,
      targetY: homeY,
      homeX,
      homeY,
      walking: true,
      returnAfterArrival: false,
      returnTimerAt: null,
      watercooler: null,
      cosmeticIndex,
    })

    this.spawnedCount += 1
  }

  private removeAgent(id: string): void {
    const managed = this.agents.get(id)
    if (!managed) return
    this.characterLayer.removeChild(managed.character)
    managed.character.destroy({ children: true })
    this.agents.delete(id)
    if (this.selectedAgentId === id) this.selectedAgentId = null
    if (this.currentWatercoolerAgentId === id) this.currentWatercoolerAgentId = null
  }

  private nextAvailableDesk(): DeskSlot | null {
    const taken = new Set<number>()
    for (const managed of this.agents.values()) {
      if (managed.deskIndex !== null) taken.add(managed.deskIndex)
    }
    for (const desk of this.desks) {
      if (!taken.has(desk.index)) return desk
    }
    return null
  }

  // ── communication ─────────────────────────────────────────────────────────

  private handleMessage(message: AgentMessage): void {
    const sender = this.agents.get(message.fromAgent)
    const receiver = this.agents.get(message.toAgent)
    if (!sender) return

    const senderDesk =
      sender.deskIndex !== null ? this.desks[sender.deskIndex] ?? null : null
    const receiverDesk =
      receiver && receiver.deskIndex !== null
        ? this.desks[receiver.deskIndex] ?? null
        : null

    const sameRow =
      senderDesk && receiverDesk && senderDesk.row === receiverDesk.row

    // Cap at 4 simultaneous bubbles — evict the oldest if full.
    while (this.bubbles.length >= 4) {
      const oldest = this.bubbles.shift()
      if (oldest) {
        this.bubbleLayer.removeChild(oldest.bubble)
        oldest.bubble.destroy({ children: true })
      }
    }

    // Bubble with the sender's shirt color as an accent.
    const bubble = new SpeechBubble(message.content, {
      accentColor: sender.character.shirtColor,
    })
    bubble.x = sender.character.x
    bubble.y = sender.character.y - 56
    this.bubbleLayer.addChild(bubble)
    this.bubbles.push({ bubble, agentId: message.fromAgent })

    if (receiver && sender !== receiver) {
      // Turn the speaker to face the listener.
      sender.character.setFacing(
        receiver.character.x >= sender.character.x ? 1 : -1,
      )

      if (sameRow) {
        // Near conversation — stay put, just turn + show bubble. Schedule
        // a turn-back after the bubble lifetime.
        sender.returnTimerAt = Date.now() + 2000
        sender.returnAfterArrival = false
      } else {
        // Far conversation — walk to the listener's desk, hold, walk back.
        const offset = receiver.character.x > sender.character.x ? -40 : 40
        sender.targetX = receiver.character.x + offset
        sender.targetY = receiver.character.y
        sender.returnAfterArrival = true
        sender.walking = true
        sender.character.setWalking(true)
      }
    }
  }

  // ── per-frame tick ────────────────────────────────────────────────────────

  private tick(deltaMs: number): void {
    const now = Date.now()

    // Advance agent movement + per-character logic.
    for (const managed of this.agents.values()) {
      const c = managed.character
      const dx = managed.targetX - c.x
      const dy = managed.targetY - c.y
      const dist2 = dx * dx + dy * dy
      if (dist2 > 0.5) {
        // Eased lerp toward target.
        const raw = Math.min(1, WALK_SPEED * (deltaMs / 16))
        const alpha = easeInOutQuad(raw)
        c.x += dx * alpha
        c.y += dy * alpha
        if (!managed.walking) {
          managed.walking = true
          c.setWalking(true)
        }
        c.setFacing(dx >= 0 ? 1 : -1)
      } else if (managed.walking) {
        c.x = managed.targetX
        c.y = managed.targetY
        managed.walking = false
        c.setWalking(false)

        if (managed.watercooler) {
          // Advance the watercooler trip state machine.
          if (managed.watercooler.phase === 'going') {
            managed.watercooler.phase = 'standing'
            managed.watercooler.phaseEndsAt = now + WATERCOOLER_STAND_MS
          } else if (managed.watercooler.phase === 'returning') {
            managed.watercooler = null
            this.currentWatercoolerAgentId = null
          }
        } else if (managed.returnAfterArrival) {
          managed.returnAfterArrival = false
          managed.returnTimerAt = now + POSE_TRANSITION_MS * 2 + 800
        }
      }

      // Handle the "standing at the cooler" phase.
      if (managed.watercooler && managed.watercooler.phase === 'standing') {
        if (now >= managed.watercooler.phaseEndsAt) {
          managed.watercooler.phase = 'returning'
          managed.targetX = managed.homeX
          managed.targetY = managed.homeY
          managed.walking = true
          c.setWalking(true)
        }
      }

      // Return-home timer (used by both far-convo and near-convo turn-back).
      if (managed.returnTimerAt !== null && now >= managed.returnTimerAt) {
        managed.returnTimerAt = null
        if (managed.targetX !== managed.homeX || managed.targetY !== managed.homeY) {
          managed.targetX = managed.homeX
          managed.targetY = managed.homeY
          managed.walking = true
          c.setWalking(true)
        } else {
          // Near conversation: just flip the sender back toward their monitor.
          c.setFacing(1)
        }
      }

      c.tick(deltaMs)

      // Z-sort characters by y so back row draws behind front row.
      c.zIndex = Math.round(c.y)
    }

    // Bubbles follow their sender and age out.
    for (let i = this.bubbles.length - 1; i >= 0; i -= 1) {
      const active = this.bubbles[i]
      if (!active) continue
      const sender = this.agents.get(active.agentId)
      if (sender) {
        active.bubble.x = sender.character.x
        active.bubble.y = sender.character.y - 56
      }
      const expired = active.bubble.tick(deltaMs)
      if (expired) {
        this.bubbleLayer.removeChild(active.bubble)
        active.bubble.destroy({ children: true })
        this.bubbles.splice(i, 1)
      }
    }

    // Monitor glow + blocked tint — only REDRAW the Graphics when mode changes.
    for (const desk of this.desks) {
      const occupant = this.occupantOfDesk(desk.index)
      const state: AgentState | null = occupant?.character.state ?? null
      const mode: 'coding' | 'blocked' | 'normal' =
        state === 'coding' ? 'coding' : state === 'blocked' || state === 'error' ? 'blocked' : 'normal'

      if (mode !== desk.lastMonitorMode) {
        desk.lastMonitorMode = mode
        desk.monitor.clear()
        desk.monitor.beginFill(
          mode === 'coding'
            ? OFFICE_COLORS.monitorGlow
            : mode === 'blocked'
              ? OFFICE_COLORS.monitorBlack
              : OFFICE_COLORS.monitorScreen,
          1,
        )
        desk.monitor.drawRoundedRect(-22, -30, 44, 18, 1.5)
        desk.monitor.endFill()
      }
      // The coding glow pulse only needs an alpha flicker on the monitor —
      // use the Graphics alpha instead of clear+redraw.
      if (mode === 'coding') {
        desk.monitor.alpha = 0.7 + 0.3 * Math.sin(now / 180)
      } else if (desk.monitor.alpha !== 1) {
        desk.monitor.alpha = 1
      }

      // Blocked desk tint fades in/out smoothly — alpha only, no redraw.
      const targetTintAlpha = mode === 'blocked' ? 0.14 : 0
      desk.tint.alpha += (targetTintAlpha - desk.tint.alpha) * 0.12
    }

    // Live clock hands — a minute per real second to keep it visually lively.
    const angle = (now / 1000) * Math.PI * 0.02 // slow rotation
    this.hourHand.clear()
    this.hourHand.lineStyle({ width: 3.5, color: OFFICE_COLORS.clockHand, alpha: 1 })
    this.hourHand.moveTo(0, 0)
    this.hourHand.lineTo(
      Math.cos(angle - Math.PI / 2) * (this._clockR * 0.45),
      Math.sin(angle - Math.PI / 2) * (this._clockR * 0.45),
    )
    this.minuteHand.clear()
    this.minuteHand.lineStyle({ width: 2.2, color: OFFICE_COLORS.clockHand, alpha: 1 })
    const minuteAngle = angle * 12
    this.minuteHand.moveTo(0, 0)
    this.minuteHand.lineTo(
      Math.cos(minuteAngle - Math.PI / 2) * (this._clockR * 0.7),
      Math.sin(minuteAngle - Math.PI / 2) * (this._clockR * 0.7),
    )
    this.secondHand.clear()
    this.secondHand.lineStyle({ width: 1, color: 0xef4444, alpha: 0.9 })
    const secondAngle = (now / 1000) * (Math.PI / 30)
    this.secondHand.moveTo(0, 0)
    this.secondHand.lineTo(
      Math.cos(secondAngle - Math.PI / 2) * (this._clockR * 0.8),
      Math.sin(secondAngle - Math.PI / 2) * (this._clockR * 0.8),
    )

    // Recovery flash fade.
    if (this.flashRemaining > 0) {
      this.flashRemaining = Math.max(0, this.flashRemaining - deltaMs)
      const t = this.flashRemaining / RECOVERY_FLASH_MS
      this.flashOverlay.alpha = 0.05 * t
    }

    // Random watercooler visits.
    if (now >= this.nextWatercoolerAt && !this.currentWatercoolerAgentId) {
      this.pickWatercoolerVisitor(now)
      this.nextWatercoolerAt =
        now +
        WATERCOOLER_MIN_GAP_MS +
        Math.random() * (WATERCOOLER_MAX_GAP_MS - WATERCOOLER_MIN_GAP_MS)
    }
  }

  private pickWatercoolerVisitor(now: number): void {
    const candidates: ManagedAgent[] = []
    for (const managed of this.agents.values()) {
      if (managed.watercooler) continue
      if (managed.walking) continue
      if (managed.returnAfterArrival) continue
      if (managed.character.state !== 'idle') continue
      candidates.push(managed)
    }
    if (candidates.length === 0) return
    const pick = candidates[Math.floor(Math.random() * candidates.length)]
    if (!pick) return
    pick.watercooler = { phase: 'going', phaseEndsAt: now + 10_000 }
    pick.targetX = WATERCOOLER_X
    pick.targetY = WATERCOOLER_Y + 90
    pick.walking = true
    pick.character.setWalking(true)
    this.currentWatercoolerAgentId = pick.character.id
  }

  private occupantOfDesk(deskIndex: number): ManagedAgent | null {
    for (const managed of this.agents.values()) {
      if (managed.deskIndex === deskIndex) return managed
    }
    return null
  }

  // ── camera ────────────────────────────────────────────────────────────────

  private centerCamera(): void {
    if (!this.app) return
    const rect = this.app.screen
    this.cameraZoom = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, Math.min(rect.width / WORLD_WIDTH, rect.height / WORLD_HEIGHT) * 0.95),
    )
    this.cameraX = rect.width / 2 - (WORLD_WIDTH / 2) * this.cameraZoom
    this.cameraY = rect.height / 2 - (WORLD_HEIGHT / 2) * this.cameraZoom
  }

  private applyCamera(): void {
    this.world.x = this.cameraX
    this.world.y = this.cameraY
    this.world.scale.set(this.cameraZoom)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tiny deterministic helpers
// ─────────────────────────────────────────────────────────────────────────────

const lerpByte = (a: number, b: number, t: number): number => a + (b - a) * t

/** Mulberry32 — fast, seedable PRNG used for deterministic desk decorations. */
const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

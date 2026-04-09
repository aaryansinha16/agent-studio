/**
 * DesktopAgent — overlay-specific wrapper around the shared
 * `AgentCharacter` from @agent-studio/canvas-core.
 *
 * The office scene and the desktop overlay use the same humanoid
 * character class, the same state-driven animations, and the same
 * color palette. What differs is the environment:
 *
 *   Office    → agents sit at assigned desks on a grid floor
 *   Overlay   → agents roam freely on a transparent fullscreen canvas
 *
 * So DesktopAgent owns the overlay-specific bookkeeping (target / home
 * positions, walking flag) and delegates all rendering to
 * AgentCharacter. OverlayRenderer keeps its existing API unchanged.
 */

import type { Container } from 'pixi.js'

import {
  AgentCharacter,
  CHAR_HEIGHT,
  CHAR_HIT_RADIUS,
} from '@agent-studio/canvas-core'
import type { AgentInfo, AgentState } from '@agent-studio/shared'

/** Padding around the visible character, used by hit-testing. */
export const AGENT_HIT_PADDING = 8
/**
 * Exposed so OverlayRenderer can use the same hit radius constant it
 * used to own directly. Historical name kept to minimize diff.
 */
export const AGENT_RADIUS = Math.round(CHAR_HIT_RADIUS * 0.7)
/** Character height — exposed for speech-bubble vertical offsets. */
export { CHAR_HEIGHT }

export class DesktopAgent {
  readonly id: string
  readonly character: AgentCharacter
  /** The "home" position — where the agent returns to between trips. */
  homeX: number
  homeY: number
  /** Active lerp target. */
  targetX: number
  targetY: number
  /** True while the character is actively moving toward a target. */
  private walking = false

  constructor(info: AgentInfo, spawnX: number, spawnY: number) {
    this.id = info.id
    this.character = new AgentCharacter(info)
    this.character.x = spawnX
    this.character.y = spawnY
    this.homeX = spawnX
    this.homeY = spawnY
    this.targetX = spawnX
    this.targetY = spawnY
  }

  /** The underlying Pixi Container — what the renderer adds to the stage. */
  get container(): Container {
    return this.character
  }

  /** Current agent state. */
  get state(): AgentState {
    return this.character.state
  }

  /** Point the agent at a new target; optionally update its home too. */
  setTarget(x: number, y: number, updateHome = false): void {
    this.targetX = x
    this.targetY = y
    if (updateHome) {
      this.homeX = x
      this.homeY = y
    }
  }

  /** Apply a state change and replay the pose lerp. */
  setState(state: AgentState): void {
    this.character.setState(state)
  }

  /** Current screen position of the character's base point. */
  position(): { x: number; y: number } {
    return { x: this.character.x, y: this.character.y }
  }

  /** Per-frame update — lerp position + delegate to AgentCharacter. */
  tick(deltaMs: number): void {
    const dx = this.targetX - this.character.x
    const dy = this.targetY - this.character.y
    const dist2 = dx * dx + dy * dy
    if (dist2 > 0.5) {
      const alpha = Math.min(1, 0.16 * (deltaMs / 16))
      this.character.x += dx * alpha
      this.character.y += dy * alpha
      if (!this.walking) {
        this.walking = true
        this.character.setWalking(true)
      }
      this.character.setFacing(dx >= 0 ? 1 : -1)
    } else if (this.walking) {
      this.character.x = this.targetX
      this.character.y = this.targetY
      this.walking = false
      this.character.setWalking(false)
    }
    this.character.tick(deltaMs)
  }

  /** Destroy Pixi resources. */
  destroy(): void {
    this.character.destroy({ children: true })
  }
}

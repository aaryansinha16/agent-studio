/**
 * AgentCharacter — a humanoid figure drawn entirely with Pixi.js
 * Graphics primitives. Used by both the Studio Window's IsometricOffice
 * and the Desktop Overlay. No sprite sheets, no external assets —
 * everything is procedural so we can tweak shapes and colors in one
 * place.
 *
 * The character is a Pixi.Container with these children (back-to-front):
 *   1. shadow (soft ellipse under feet / desk)
 *   2. error glow (red pulse behind character)
 *   3. selection ring (cyan highlight)
 *   4. rig (legs → body → arms → head → hair → accessories)
 *   5. name label text
 *   6. floating badges: red "!", green "✓"
 *
 * State animation is pose-lerped: each state maps to a `Pose` object of
 * target offsets / angles / alphas, and every tick we ease the current
 * pose toward the target using `easeInOutQuad`. Walking, breathing, and
 * the pulsing "!" badge are additive wiggles layered on top.
 */

import { Container, Graphics, Text } from 'pixi.js'

import type { AgentInfo, AgentState, AgentType } from '@agent-studio/shared'

import {
  HAIR_COLOR_POOL,
  OUTLINE_COLOR,
  POSE_TRANSITION_MS,
  ROLE_BODY_COLOR,
  ROLE_LEG_COLOR,
  SELECTED_RING_COLOR,
  SHIRT_COLOR_POOL,
  SKIN_COLOR,
  STATE_ACCENT_COLOR,
  easeInOutQuad,
} from './palette.js'

// ─────────────────────────────────────────────────────────────────────────────
// Geometry constants — shared by draw + hit-test.
// ─────────────────────────────────────────────────────────────────────────────

export const CHAR_HEIGHT = 52
export const CHAR_HALF_WIDTH = 13
/** Hit area radius — click target slightly larger than visible body. */
export const CHAR_HIT_RADIUS = 28

const HEAD_RADIUS = 9
const BODY_WIDTH = 16
const BODY_HEIGHT = 18
const ARM_WIDTH = 3.2
const ARM_HEIGHT = 11
const HAND_RADIUS = 2
const LEG_WIDTH = 4.4
const LEG_HEIGHT = 12

const RECOVERY_FLASH_DURATION_MS = 1200

// ─────────────────────────────────────────────────────────────────────────────
// Public options — let callers customize appearance per agent.
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentCharacterOptions {
  /** Override the shirt/body color. Falls back to the role color. */
  shirtColor?: number
  /** Override the leg/pants color. Falls back to the role leg color. */
  legColor?: number
  /** Override the hair color (0 = no hair drawn). */
  hairColor?: number
  /**
   * Hair style index (0 = short cap, 1 = side part, 2 = spiky). Used to
   * make same-hair-color characters still look distinct.
   */
  hairStyle?: 0 | 1 | 2
  /** Color stripe for the name tag on the torso. */
  nameTagColor?: number
}

/** Convenience helper — pick deterministic cosmetics for an agent index. */
export const cosmeticsForIndex = (index: number): Required<AgentCharacterOptions> => {
  const shirtColor = SHIRT_COLOR_POOL[index % SHIRT_COLOR_POOL.length] ?? 0x60a5fa
  const hairColor = HAIR_COLOR_POOL[index % HAIR_COLOR_POOL.length] ?? 0x8b5e3c
  const style = (index % 3) as 0 | 1 | 2
  return {
    shirtColor,
    legColor: darken(shirtColor, 0.55),
    hairColor,
    hairStyle: style,
    nameTagColor: brighten(shirtColor, 0.3),
  }
}

const darken = (hex: number, factor: number): number => {
  const r = (hex >> 16) & 0xff
  const g = (hex >> 8) & 0xff
  const b = hex & 0xff
  const dr = Math.round(r * factor)
  const dg = Math.round(g * factor)
  const db = Math.round(b * factor)
  return (dr << 16) | (dg << 8) | db
}

const brighten = (hex: number, factor: number): number => {
  const r = (hex >> 16) & 0xff
  const g = (hex >> 8) & 0xff
  const b = hex & 0xff
  const br = Math.min(255, Math.round(r + (255 - r) * factor))
  const bg = Math.min(255, Math.round(g + (255 - g) * factor))
  const bb = Math.min(255, Math.round(b + (255 - b) * factor))
  return (br << 16) | (bg << 8) | bb
}

// ─────────────────────────────────────────────────────────────────────────────
// Pose — the target values we lerp toward on state changes.
// ─────────────────────────────────────────────────────────────────────────────

interface Pose {
  /** Offset of the entire body rig from the character origin. */
  bodyOffsetX: number
  bodyOffsetY: number
  /** Head-specific offset (so BLOCKED can drop the head without moving arms). */
  headOffsetX: number
  headOffsetY: number
  /** Arm rotations in radians — positive is "forward" (on desk). */
  armAngleL: number
  armAngleR: number
  /** Whether the leg pair is contracted (sitting) or extended (standing). */
  sitting: number // 0..1
  /** Accessory alphas. */
  showExclaim: number
  showErrorGlow: number
  showClipboard: number
}

const basePose = (): Pose => ({
  bodyOffsetX: 0,
  bodyOffsetY: 0,
  headOffsetX: 0,
  headOffsetY: 0,
  armAngleL: 0,
  armAngleR: 0,
  sitting: 1,
  showExclaim: 0,
  showErrorGlow: 0,
  showClipboard: 0,
})

const POSE_BY_STATE: Record<AgentState, Pose> = {
  idle: { ...basePose(), sitting: 1, armAngleL: 0.05, armAngleR: -0.05 },
  planning: {
    ...basePose(),
    sitting: 0,
    armAngleL: -0.7,
    armAngleR: 0.15,
  },
  coding: {
    ...basePose(),
    sitting: 1,
    armAngleL: 1.05,
    armAngleR: 1.05,
  },
  testing: {
    ...basePose(),
    sitting: 0,
    showClipboard: 1,
    armAngleL: 0.45,
    armAngleR: -0.2,
  },
  blocked: {
    ...basePose(),
    sitting: 1,
    headOffsetY: 5,
    // Arms drop off the desk: negative angles swing them downward.
    armAngleL: -0.9,
    armAngleR: -0.9,
    showExclaim: 1,
  },
  error: {
    ...basePose(),
    sitting: 1,
    headOffsetY: 4,
    armAngleL: -0.6,
    armAngleR: -0.6,
    showErrorGlow: 1,
  },
  communicating: {
    ...basePose(),
    sitting: 0,
    armAngleL: 0.3,
    armAngleR: -0.3,
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const lerp = (from: number, to: number, t: number): number => from + (to - from) * t

const lerpPose = (from: Pose, to: Pose, t: number): Pose => ({
  bodyOffsetX: lerp(from.bodyOffsetX, to.bodyOffsetX, t),
  bodyOffsetY: lerp(from.bodyOffsetY, to.bodyOffsetY, t),
  headOffsetX: lerp(from.headOffsetX, to.headOffsetX, t),
  headOffsetY: lerp(from.headOffsetY, to.headOffsetY, t),
  armAngleL: lerp(from.armAngleL, to.armAngleL, t),
  armAngleR: lerp(from.armAngleR, to.armAngleR, t),
  sitting: lerp(from.sitting, to.sitting, t),
  showExclaim: lerp(from.showExclaim, to.showExclaim, t),
  showErrorGlow: lerp(from.showErrorGlow, to.showErrorGlow, t),
  showClipboard: lerp(from.showClipboard, to.showClipboard, t),
})

// ─────────────────────────────────────────────────────────────────────────────
// AgentCharacter
// ─────────────────────────────────────────────────────────────────────────────

export class AgentCharacter extends Container {
  readonly id: string
  readonly type: AgentType
  readonly shirtColor: number
  private readonly legColor: number
  private readonly hairColor: number
  private readonly hairStyle: 0 | 1 | 2
  private readonly nameTagColor: number
  private agentName: string
  private _state: AgentState

  // Visual layers
  private readonly shadow = new Graphics()
  private readonly errorGlow = new Graphics()
  private readonly selectionRing = new Graphics()
  private readonly rig = new Container()
  private readonly legL = new Graphics()
  private readonly legR = new Graphics()
  private readonly body = new Graphics()
  private readonly armL = new Container() // arm + hand
  private readonly armR = new Container()
  private readonly armLGraphic = new Graphics()
  private readonly armRGraphic = new Graphics()
  private readonly handL = new Graphics()
  private readonly handR = new Graphics()
  private readonly head = new Graphics()
  private readonly hair = new Graphics()
  private readonly collar = new Graphics()
  private readonly nameTag = new Graphics()
  private readonly clipboard = new Graphics()
  private readonly nameLabel: Text
  private readonly exclaim: Text
  private readonly recoveryCheck: Text

  // Animation state
  private poseCurrent: Pose = basePose()
  private poseFrom: Pose = basePose()
  private poseTo: Pose = POSE_BY_STATE.idle
  private poseElapsed = POSE_TRANSITION_MS
  private breathePhase = 0
  private readonly breatheOffset: number
  private readonly breatheSpeedJitter: number
  private walkPhase = 0
  private walking = false
  private selected = false
  private facing: -1 | 1 = 1
  private recoveryRemaining = 0

  constructor(info: AgentInfo, options: AgentCharacterOptions = {}) {
    super()
    this.id = info.id
    this.type = info.type
    this.agentName = info.name
    this._state = info.state
    this.shirtColor = options.shirtColor ?? ROLE_BODY_COLOR[info.type]
    this.legColor = options.legColor ?? ROLE_LEG_COLOR[info.type]
    this.hairColor = options.hairColor ?? 0x5a3a1e
    this.hairStyle = options.hairStyle ?? 1
    this.nameTagColor = options.nameTagColor ?? brighten(this.shirtColor, 0.4)
    this.poseTo = POSE_BY_STATE[info.state]
    this.poseCurrent = { ...this.poseTo }
    this.poseFrom = { ...this.poseTo }
    this.poseElapsed = POSE_TRANSITION_MS

    // Deterministic-but-varied breathing based on agent id hash.
    const hash = hashString(info.id)
    this.breatheOffset = (hash % 1000) / 1000 // 0..1
    this.breatheSpeedJitter = 0.85 + ((hash >> 10) % 30) / 100 // 0.85..1.15

    // Back-to-front z order.
    this.addChild(this.shadow)
    this.addChild(this.errorGlow)
    this.addChild(this.selectionRing)
    this.addChild(this.rig)

    this.rig.addChild(this.legL)
    this.rig.addChild(this.legR)
    this.rig.addChild(this.body)
    this.rig.addChild(this.collar)
    this.rig.addChild(this.nameTag)
    this.rig.addChild(this.armL)
    this.rig.addChild(this.armR)
    this.armL.addChild(this.armLGraphic)
    this.armL.addChild(this.handL)
    this.armR.addChild(this.armRGraphic)
    this.armR.addChild(this.handR)
    this.rig.addChild(this.head)
    this.rig.addChild(this.hair)
    this.rig.addChild(this.clipboard)

    this.nameLabel = new Text(this.agentName, {
      fontFamily: 'Instrument Sans, ui-sans-serif, system-ui, sans-serif',
      fontSize: 11,
      fontWeight: '500',
      fill: 0xffffff,
      align: 'center',
      dropShadow: true,
      dropShadowColor: 0x000000,
      dropShadowBlur: 3,
      dropShadowDistance: 1,
      dropShadowAlpha: 0.85,
    })
    this.nameLabel.anchor.set(0.5, 0)
    this.nameLabel.y = 14
    this.addChild(this.nameLabel)

    this.exclaim = new Text('!', {
      fontFamily: 'Instrument Sans, ui-sans-serif, system-ui, sans-serif',
      fontSize: 18,
      fontWeight: '700',
      fill: 0xef4444,
      dropShadow: true,
      dropShadowColor: 0x000000,
      dropShadowBlur: 2,
      dropShadowAlpha: 0.9,
    })
    this.exclaim.anchor.set(0.5, 1)
    this.exclaim.y = -(CHAR_HEIGHT - 4)
    this.exclaim.alpha = 0
    this.addChild(this.exclaim)

    this.recoveryCheck = new Text('✓', {
      fontFamily: 'Instrument Sans, ui-sans-serif, system-ui, sans-serif',
      fontSize: 16,
      fontWeight: '700',
      fill: 0x10b981,
      dropShadow: true,
      dropShadowColor: 0x000000,
      dropShadowBlur: 2,
      dropShadowAlpha: 0.9,
    })
    this.recoveryCheck.anchor.set(0.5, 1)
    this.recoveryCheck.y = -(CHAR_HEIGHT - 4)
    this.recoveryCheck.alpha = 0
    this.addChild(this.recoveryCheck)

    this.drawStatic()

    this.eventMode = 'static'
    this.cursor = 'pointer'
    this.hitArea = {
      contains: (x: number, y: number) => {
        const dy = y + CHAR_HEIGHT / 2 - 10
        return x * x + dy * dy <= CHAR_HIT_RADIUS * CHAR_HIT_RADIUS
      },
    }
  }

  // ── public API ─────────────────────────────────────────────────────────────

  get state(): AgentState {
    return this._state
  }

  /** Current agent display name. */
  get displayName(): string {
    return this.agentName
  }

  /** Update the agent state and kick off a lerp to the new pose. */
  setState(next: AgentState): void {
    if (next === this._state) return
    const prev = this._state
    this._state = next
    this.poseFrom = { ...this.poseCurrent }
    this.poseTo = POSE_BY_STATE[next]
    this.poseElapsed = 0
    // Recovering from a stuck state? Flash the green checkmark badge.
    if ((prev === 'blocked' || prev === 'error') && next !== 'blocked' && next !== 'error') {
      this.recoveryRemaining = RECOVERY_FLASH_DURATION_MS
    }
  }

  /** Replace the displayed name. */
  setName(name: string): void {
    if (name === this.agentName) return
    this.agentName = name
    this.nameLabel.text = name
  }

  /** Highlight the character with a cyan ring. */
  setSelected(selected: boolean): void {
    if (selected === this.selected) return
    this.selected = selected
    this.drawSelectionRing()
  }

  /** Tell the character which way it's facing (for walk / conversation). */
  setFacing(direction: -1 | 1): void {
    this.facing = direction
    this.rig.scale.x = direction
    this.nameLabel.scale.x = direction === -1 ? -1 : 1
  }

  /** Toggle walk animation (leg alternation). */
  setWalking(walking: boolean): void {
    this.walking = walking
    if (!walking) {
      this.walkPhase = 0
      this.legL.y = 0
      this.legR.y = 0
    }
  }

  /** Per-frame update — call from the Pixi ticker. */
  tick(deltaMs: number): void {
    if (this.poseElapsed < POSE_TRANSITION_MS) {
      this.poseElapsed = Math.min(POSE_TRANSITION_MS, this.poseElapsed + deltaMs)
      const t = easeInOutQuad(this.poseElapsed / POSE_TRANSITION_MS)
      this.poseCurrent = lerpPose(this.poseFrom, this.poseTo, t)
    } else {
      this.poseCurrent = this.poseTo
    }
    this.applyPose(this.poseCurrent, deltaMs)
  }

  // ── drawing ────────────────────────────────────────────────────────────────

  /** Draw the parts that never change — shapes and base colors. */
  private drawStatic(): void {
    // Shadow under the character.
    this.shadow.clear()
    this.shadow.beginFill(0x000000, 0.2)
    this.shadow.drawEllipse(0, 2, 16, 5)
    this.shadow.endFill()

    // Body torso.
    this.body.clear()
    this.body.lineStyle({ width: 1.5, color: OUTLINE_COLOR, alpha: 0.8 })
    this.body.beginFill(this.shirtColor, 1)
    this.body.drawRoundedRect(-BODY_WIDTH / 2, 0, BODY_WIDTH, BODY_HEIGHT, 4)
    this.body.endFill()

    // Subtle collar line — a slightly lighter strip at the top of the body.
    this.collar.clear()
    this.collar.beginFill(brighten(this.shirtColor, 0.3), 0.9)
    this.collar.drawRect(-BODY_WIDTH / 2 + 2, 0.5, BODY_WIDTH - 4, 1.6)
    this.collar.endFill()

    // Name tag — small colored stripe on the chest.
    this.nameTag.clear()
    this.nameTag.lineStyle({ width: 0.8, color: OUTLINE_COLOR, alpha: 0.7 })
    this.nameTag.beginFill(this.nameTagColor, 1)
    this.nameTag.drawRoundedRect(BODY_WIDTH / 4 - 2, 6, 4, 2.5, 0.5)
    this.nameTag.endFill()

    // Head.
    this.head.clear()
    this.head.lineStyle({ width: 1.5, color: OUTLINE_COLOR, alpha: 0.9 })
    this.head.beginFill(SKIN_COLOR, 1)
    this.head.drawCircle(0, 0, HEAD_RADIUS)
    this.head.endFill()

    // Hair — drawn on top of the head circle, shape depends on hairStyle.
    this.drawHair()

    // Arms (pivot at shoulder). Hands are at the far end.
    this.drawArm(this.armLGraphic, this.handL, -1)
    this.drawArm(this.armRGraphic, this.handR, 1)
    this.armL.x = -(BODY_WIDTH / 2 + ARM_WIDTH / 2)
    this.armL.y = 2
    this.armR.x = BODY_WIDTH / 2 + ARM_WIDTH / 2
    this.armR.y = 2

    // Legs.
    for (const [leg, xSign] of [
      [this.legL, -1],
      [this.legR, 1],
    ] as const) {
      leg.clear()
      leg.lineStyle({ width: 1.2, color: OUTLINE_COLOR, alpha: 0.8 })
      leg.beginFill(this.legColor, 1)
      leg.drawRoundedRect(-LEG_WIDTH / 2, 0, LEG_WIDTH, LEG_HEIGHT, 1.2)
      leg.endFill()
      leg.x = (BODY_WIDTH / 4) * xSign
      leg.y = BODY_HEIGHT
    }

    // Clipboard (tester, initially hidden).
    this.clipboard.clear()
    this.clipboard.lineStyle({ width: 1.2, color: OUTLINE_COLOR, alpha: 0.9 })
    this.clipboard.beginFill(0xf5f5f5, 1)
    this.clipboard.drawRoundedRect(-4, -3, 8, 10, 1)
    this.clipboard.endFill()
    this.clipboard.lineStyle({ width: 0.8, color: 0x3a4458, alpha: 0.7 })
    this.clipboard.moveTo(-3, 0)
    this.clipboard.lineTo(3, 0)
    this.clipboard.moveTo(-3, 3)
    this.clipboard.lineTo(3, 3)
    this.clipboard.x = BODY_WIDTH / 2 + 6
    this.clipboard.y = 4
    this.clipboard.alpha = 0

    // Initial rig position — character origin is centered on the floor / chair seat.
    this.rig.y = -(BODY_HEIGHT + HEAD_RADIUS * 2 + LEG_HEIGHT) + 6

    this.drawSelectionRing()
  }

  /** Draw the arm rectangle + the hand circle at its tip. */
  private drawArm(arm: Graphics, hand: Graphics, _xSign: -1 | 1): void {
    arm.clear()
    arm.lineStyle({ width: 1.1, color: OUTLINE_COLOR, alpha: 0.8 })
    arm.beginFill(this.shirtColor, 1)
    arm.drawRoundedRect(-ARM_WIDTH / 2, 0, ARM_WIDTH, ARM_HEIGHT, 1.2)
    arm.endFill()

    hand.clear()
    hand.lineStyle({ width: 0.8, color: OUTLINE_COLOR, alpha: 0.8 })
    hand.beginFill(SKIN_COLOR, 1)
    hand.drawCircle(0, ARM_HEIGHT + 0.5, HAND_RADIUS)
    hand.endFill()
  }

  /** Draw hair on top of the head, shape varies by `hairStyle`. */
  private drawHair(): void {
    this.hair.clear()
    this.hair.lineStyle({ width: 0.8, color: OUTLINE_COLOR, alpha: 0.5 })
    this.hair.beginFill(this.hairColor, 1)
    switch (this.hairStyle) {
      case 0: {
        // Short cap — covers top half of head.
        this.hair.arc(0, 0, HEAD_RADIUS, Math.PI, 0, false)
        this.hair.lineTo(HEAD_RADIUS, -1)
        this.hair.lineTo(-HEAD_RADIUS, -1)
        break
      }
      case 1: {
        // Side part — asymmetric, a bit more volume on the left.
        this.hair.moveTo(-HEAD_RADIUS, -1)
        this.hair.bezierCurveTo(
          -HEAD_RADIUS - 1,
          -HEAD_RADIUS - 3,
          HEAD_RADIUS,
          -HEAD_RADIUS - 2,
          HEAD_RADIUS - 1,
          -2,
        )
        this.hair.lineTo(HEAD_RADIUS - 1, 1)
        this.hair.lineTo(-HEAD_RADIUS, 1)
        break
      }
      case 2: {
        // Spiky top.
        this.hair.moveTo(-HEAD_RADIUS, -1)
        for (let i = -HEAD_RADIUS; i <= HEAD_RADIUS; i += 2) {
          this.hair.lineTo(i + 1, -HEAD_RADIUS - 3)
          this.hair.lineTo(i + 2, -1)
        }
        this.hair.lineTo(HEAD_RADIUS, -1)
        break
      }
    }
    this.hair.closePath()
    this.hair.endFill()
    // Position relative to head (which moves with pose).
    this.hair.x = 0
    this.hair.y = 0
  }

  private drawSelectionRing(): void {
    this.selectionRing.clear()
    if (!this.selected) return
    this.selectionRing.lineStyle({ width: 2, color: SELECTED_RING_COLOR, alpha: 0.9 })
    this.selectionRing.drawEllipse(0, -2, 24, 8)
  }

  /** Draw the pulsing error glow behind the character. */
  private redrawErrorGlow(pose: Pose): void {
    this.errorGlow.clear()
    if (pose.showErrorGlow > 0.01) {
      const alpha = pose.showErrorGlow * (0.45 + 0.25 * Math.sin(this.breathePhase * 0.006))
      this.errorGlow.beginFill(STATE_ACCENT_COLOR.error, alpha)
      this.errorGlow.drawCircle(0, -CHAR_HEIGHT / 2 + 6, 30)
      this.errorGlow.endFill()
    }
  }

  private applyPose(pose: Pose, deltaMs: number): void {
    this.breathePhase += deltaMs * this.breatheSpeedJitter

    // Breathing — gentle vertical wiggle when sitting, silent when walking.
    const breatheAmplitude = pose.sitting * 0.8 * (this.walking ? 0 : 1)
    const breathe = Math.sin(this.breathePhase / 450 + this.breatheOffset * Math.PI * 2) *
      breatheAmplitude

    // Sit offset tucks the legs up and hides them.
    const sitOffset = pose.sitting * LEG_HEIGHT * 0.55
    const legsVisible = 1 - pose.sitting
    this.legL.alpha = legsVisible
    this.legR.alpha = legsVisible
    if (this.walking) {
      this.walkPhase += deltaMs
      const phase = Math.sin(this.walkPhase / 120)
      this.legL.y = BODY_HEIGHT - sitOffset + phase * 1.8
      this.legR.y = BODY_HEIGHT - sitOffset - phase * 1.8
    } else {
      this.legL.y = BODY_HEIGHT - sitOffset
      this.legR.y = BODY_HEIGHT - sitOffset
    }

    // Body position — add breathing wiggle.
    this.rig.x = pose.bodyOffsetX
    this.rig.y = -(BODY_HEIGHT + HEAD_RADIUS * 2 + LEG_HEIGHT) + 6 + pose.bodyOffsetY + breathe

    // Head + hair offset relative to body top.
    const headY = -HEAD_RADIUS - 1 + pose.headOffsetY
    this.head.x = pose.headOffsetX
    this.head.y = headY
    this.hair.x = pose.headOffsetX
    this.hair.y = headY

    // Arm rotations.
    this.armL.rotation = pose.armAngleL
    this.armR.rotation = pose.armAngleR

    // Accessories.
    this.clipboard.alpha = pose.showClipboard
    this.redrawErrorGlow(pose)

    // Pulsing "!" when blocked.
    if (pose.showExclaim > 0.01) {
      this.exclaim.alpha = pose.showExclaim
      const pulse = 0.8 + 0.4 * Math.abs(Math.sin(this.breathePhase / 220))
      this.exclaim.scale.set(pulse)
    } else {
      this.exclaim.alpha = 0
      this.exclaim.scale.set(1)
    }

    // Green recovery checkmark fade.
    if (this.recoveryRemaining > 0) {
      this.recoveryRemaining = Math.max(0, this.recoveryRemaining - deltaMs)
      const progress = 1 - this.recoveryRemaining / RECOVERY_FLASH_DURATION_MS
      const fade = progress < 0.4 ? progress / 0.4 : Math.max(0, 1 - (progress - 0.4) / 0.6)
      this.recoveryCheck.alpha = fade
      this.recoveryCheck.scale.set(1 + (1 - fade) * 0.2)
    } else if (this.recoveryCheck.alpha !== 0) {
      this.recoveryCheck.alpha = 0
      this.recoveryCheck.scale.set(1)
    }
  }
}

/** Simple deterministic string hash — used for per-instance jitter. */
const hashString = (s: string): number => {
  let h = 5381
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}

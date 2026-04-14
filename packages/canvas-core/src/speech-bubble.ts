/**
 * Shared speech bubble used by both the office scene and the desktop
 * overlay.
 *
 * Life cycle:
 *   - Grow from scale 0 to 1 with `easeInOutQuad` over GROW_MS
 *   - Hold at full scale for HOLD_MS
 *   - Shrink + fade back to 0 over SHRINK_MS
 *
 * The caller ticks the bubble each frame and it reports when it has
 * expired so the scene can detach / destroy it.
 */

import { Container, Graphics, Text } from 'pixi.js'

import { easeInOutQuad } from './palette.js'

const GROW_MS = 200
const HOLD_MS = 1800
const SHRINK_MS = 260
const MAX_TEXT_LENGTH = 60
const PADDING = 10
const FONT_SIZE = 12

interface SpeechBubbleOptions {
  /**
   * Color used for the 3px left accent stripe on the bubble. Usually
   * the sender's shirt color so viewers can tell at a glance who's
   * speaking even when their character is off-screen.
   */
  accentColor?: number
}

export class SpeechBubble extends Container {
  private elapsed = 0
  private readonly total = GROW_MS + HOLD_MS + SHRINK_MS

  constructor(message: string, options: SpeechBubbleOptions = {}) {
    super()

    const accentColor = options.accentColor ?? 0x4ecdc4

    const truncated =
      message.length > MAX_TEXT_LENGTH ? `${message.slice(0, MAX_TEXT_LENGTH - 1)}…` : message

    const text = new Text(truncated, {
      fontFamily: 'Instrument Sans, ui-sans-serif, system-ui, sans-serif',
      fontSize: FONT_SIZE,
      fontWeight: '500',
      fill: 0x0a0e14,
      wordWrap: true,
      wordWrapWidth: 200,
      align: 'left',
    })
    text.anchor.set(0.5, 0.5)
    // The office scene runs the Pixi Application at resolution 1 for
    // perf, which leaves Text rasterized at 1x and visibly blurry on
    // Retina. Bump the Text's own resolution to DPR so each glyph
    // texture is rendered at the display's native pixel density.
    text.resolution = typeof window !== 'undefined' ? Math.max(2, window.devicePixelRatio || 2) : 2

    const bgWidth = Math.min(240, text.width + PADDING * 2 + 8)
    const bgHeight = text.height + PADDING * 2

    const bg = new Graphics()
    // Shadow below the bubble — cheap depth cue.
    bg.beginFill(0x000000, 0.25)
    bg.drawRoundedRect(-bgWidth / 2 + 1, -bgHeight / 2 + 2, bgWidth, bgHeight, 10)
    bg.endFill()
    // Main bubble body.
    bg.lineStyle({ width: 1.2, color: 0x0a0e14, alpha: 0.85 })
    bg.beginFill(0xffffff, 0.97)
    bg.drawRoundedRect(-bgWidth / 2, -bgHeight / 2, bgWidth, bgHeight, 10)
    bg.endFill()
    // Colored left accent stripe — the sender identifier.
    bg.lineStyle({ width: 0 })
    bg.beginFill(accentColor, 1)
    bg.drawRoundedRect(-bgWidth / 2 + 1, -bgHeight / 2 + 4, 3, bgHeight - 8, 1.5)
    bg.endFill()
    // Downward tail.
    bg.beginFill(0xffffff, 0.97)
    bg.drawPolygon([-6, bgHeight / 2 - 0.5, 6, bgHeight / 2 - 0.5, 0, bgHeight / 2 + 8])
    bg.endFill()

    // Small text indent so it doesn't sit flush with the accent stripe.
    text.x = 4

    this.addChild(bg)
    this.addChild(text)

    // Anchor the bubble's transform origin near the tail so the scale-in
    // animation grows UP from the character instead of scaling around
    // the center.
    this.pivot.set(0, bgHeight / 2 + 4)

    this.scale.set(0)
    this.alpha = 0
  }

  /**
   * Advance this bubble by `deltaMs`. Returns true when the bubble has
   * reached the end of its life and should be removed from the scene.
   */
  tick(deltaMs: number): boolean {
    this.elapsed += deltaMs
    if (this.elapsed >= this.total) {
      this.alpha = 0
      this.scale.set(0)
      return true
    }

    if (this.elapsed < GROW_MS) {
      const t = easeInOutQuad(this.elapsed / GROW_MS)
      this.scale.set(t)
      this.alpha = t
    } else if (this.elapsed < GROW_MS + HOLD_MS) {
      this.scale.set(1)
      this.alpha = 1
    } else {
      const shrinkElapsed = this.elapsed - GROW_MS - HOLD_MS
      const t = easeInOutQuad(shrinkElapsed / SHRINK_MS)
      const scale = 1 - t * 0.4
      this.scale.set(scale)
      this.alpha = 1 - t
    }
    return false
  }
}

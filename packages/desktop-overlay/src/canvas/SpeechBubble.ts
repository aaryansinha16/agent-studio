/**
 * SpeechBubble — a short-lived rounded-rectangle Pixi container that
 * pops up above the sender during a `message:sent` event.
 *
 * Lifetime is fixed: the OverlayRenderer schedules a removal after
 * SPEECH_BUBBLE_DURATION_MS via `tick()`. Bubbles never overlap because
 * the renderer keeps at most one bubble per sender.
 */

import { Container, Graphics, Text } from 'pixi.js'

import { AGENT_RADIUS } from './DesktopAgent.js'

export const SPEECH_BUBBLE_DURATION_MS = 2000
const MAX_TEXT_LENGTH = 60
const PADDING = 10
const FONT_SIZE = 12

export class SpeechBubble {
  readonly container: Container
  /** Milliseconds remaining before this bubble should be removed. */
  remainingMs = SPEECH_BUBBLE_DURATION_MS

  constructor(message: string) {
    this.container = new Container()

    const truncated =
      message.length > MAX_TEXT_LENGTH ? `${message.slice(0, MAX_TEXT_LENGTH - 1)}…` : message

    const text = new Text(truncated, {
      fontFamily: 'Instrument Sans, ui-sans-serif, system-ui, sans-serif',
      fontSize: FONT_SIZE,
      fontWeight: '500',
      fill: 0x0a0e14,
      wordWrap: true,
      wordWrapWidth: 220,
      align: 'center',
    })
    text.anchor.set(0.5, 0.5)

    const bgWidth = Math.min(240, text.width + PADDING * 2)
    const bgHeight = text.height + PADDING * 2

    const bg = new Graphics()
    bg.lineStyle({ width: 1.5, color: 0x4ecdc4, alpha: 1 })
    bg.beginFill(0xffffff, 0.96)
    bg.drawRoundedRect(-bgWidth / 2, -bgHeight / 2, bgWidth, bgHeight, 10)
    bg.endFill()
    // Tail pointing down at the agent.
    bg.beginFill(0xffffff, 0.96)
    bg.lineStyle({ width: 0 })
    bg.drawPolygon([-6, bgHeight / 2 - 0.5, 6, bgHeight / 2 - 0.5, 0, bgHeight / 2 + 8])
    bg.endFill()

    this.container.addChild(bg)
    this.container.addChild(text)

    // Float above the sender, just clear of the name label.
    this.container.y = -(AGENT_RADIUS + 26 + bgHeight / 2)
  }

  /** Returns true when this bubble has expired and can be removed. */
  tick(deltaMs: number): boolean {
    this.remainingMs -= deltaMs
    return this.remainingMs <= 0
  }

  destroy(): void {
    this.container.destroy({ children: true })
  }
}

/**
 * Shared color palette for all canvas renderers.
 *
 * Values are numeric (0xRRGGBB) so they can be passed directly to
 * pixi.js Graphics methods without conversion. When the studio dashboard
 * or desktop overlay needs the same color as a CSS string, it should
 * import from here and format itself.
 */

import type { AgentState, AgentType } from '@agent-studio/shared'

/** Primary body color per role (what fills the torso rectangle). */
export const ROLE_BODY_COLOR: Record<AgentType, number> = {
  architect: 0x8b5cf6, // violet-500
  coder: 0x06b6d4, // cyan-500
  tester: 0xf59e0b, // amber-500
  researcher: 0x3b82f6, // blue-500
  coordinator: 0xec4899, // pink-500
}

/** Darker shade of the body color used for pants/legs. */
export const ROLE_LEG_COLOR: Record<AgentType, number> = {
  architect: 0x5b21b6,
  coder: 0x0e7490,
  tester: 0xb45309,
  researcher: 0x1d4ed8,
  coordinator: 0x9d174d,
}

/** Highlight ring color used when an agent is selected. */
export const SELECTED_RING_COLOR = 0x4ecdc4

/** Neutral skin tone — chosen to read on both dark and bright backgrounds. */
export const SKIN_COLOR = 0xfcd7a0

/** Outline color for all character parts — helps the sprite "pop" on busy backgrounds. */
export const OUTLINE_COLOR = 0x0a0e14

/** Status dot / accent color by state — used by small "state badge" indicators. */
export const STATE_ACCENT_COLOR: Record<AgentState, number> = {
  idle: 0x6b7a8f,
  planning: 0xa78bfa,
  coding: 0x4ecdc4,
  testing: 0xfbbf24,
  blocked: 0xf87171,
  error: 0xef4444,
  communicating: 0x60a5fa,
}

/** Floor / office environment colors. */
export const OFFICE_COLORS = {
  floor: 0x2a2a3a,
  floorLine: 0x1f1f2e,
  ceiling: 0x1f1f2b,
  ceilingLight: 0xfff2c9,
  ceilingLightGlow: 0xfde68a,
  backWall: 0x3a3a4a,
  backWallTrim: 0x252534,
  windowFrame: 0x1c1c28,
  windowSkyTop: 0x67c7f0,
  windowSkyBottom: 0x2f6ea3,
  cloud: 0xf1f5f9,
  poster: 0x0a0e14,
  posterBorder: 0xf59e0b,
  posterText: 0xfafafa,
  clockFace: 0xf5e9c8,
  clockBorder: 0x1c1c28,
  clockHand: 0x1c1c28,
  door: 0x7a4a22,
  doorFrame: 0x4a2c12,
  doorKnob: 0xfbbf24,
  plantPot: 0x7a4a22,
  plantLeaf: 0x4caf50,
  deskTop: 0x8a5a2b,
  deskEdge: 0x5a3a1a,
  deskFront: 0x6a4520,
  chair: 0x2d5db3,
  chairHighlight: 0x4279d4,
  monitorFrame: 0x0a0e14,
  monitorScreen: 0x111827,
  monitorGlow: 0x4ecdc4,
  monitorBlack: 0x0a0a0a,
  cabinetBody: 0xa0a4b0,
  cabinetLine: 0x5e626e,
  cabinetHandle: 0x2c3140,
  bookshelfBody: 0x5a3a1a,
  bookshelfShelf: 0x3a2410,
  trashCan: 0x2c3140,
  watercooler: 0x60a5fa,
  watercoolerBase: 0x2c3140,
  coffeeMug: 0xf5f5f5,
  coffeeMugHandle: 0xcbd5f5,
  coffeeLiquid: 0x5a3a1a,
  deskPlantPot: 0x8a5a2b,
  deskPlantLeaf: 0x6fbf73,
  pencilHolder: 0x3a3a4a,
  paper: 0xe8e8e8,
  particle: 0x4ecdc4,
  shadow: 0x000000,
  /** Very light red tint overlaid on blocked desks. */
  blockedTint: 0xef4444,
  /** Light green used for recovery flash. */
  recoveryFlash: 0x10b981,
  /** Backwards-compat — referenced by some older helpers. */
  whiteboard: 0xf5f5f5,
  whiteboardFrame: 0x3a4458,
  testingMat: 0x2c3140,
  grid: 0x1b2230,
} as const

/** Milliseconds we lerp over when transitioning between character poses. */
export const POSE_TRANSITION_MS = 300

/**
 * Pool of shirt colors used to make each agent visually distinct from
 * their peers. Warmer and more varied than the role-based palette.
 * Consumers pick an index (usually by spawn order) to get a unique color.
 */
export const SHIRT_COLOR_POOL: readonly number[] = [
  0x6fbf73, // green
  0xa78bfa, // purple
  0x60a5fa, // blue
  0xfbbf24, // yellow
  0xf472b6, // pink
  0x67e8f9, // light cyan
  0x14b8a6, // teal
  0xfb923c, // orange
  0xfb7185, // coral
  0xa3e635, // lime
  0x818cf8, // indigo
  0xfca5a5, // rose
]

/** Pool of hair colors, cycled alongside shirt colors per-agent. */
export const HAIR_COLOR_POOL: readonly number[] = [
  0x8b5e3c, // brown
  0x1f1f2e, // black
  0xd4543a, // red
  0xeed27d, // blonde
  0x5a3a1e, // dark brown
  0xb08654, // light brown
  0x9ca3af, // grey
  0x2a1a0a, // near-black
]

/**
 * Easing function used by every animation in the character + office scene.
 * Smooth start + smooth end; eases in AND out.
 */
export const easeInOutQuad = (t: number): number =>
  t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2

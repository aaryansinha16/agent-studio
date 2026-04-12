/**
 * Sprite loading infrastructure.
 *
 * Loads the office sprite assets described by `sprite-manifest.json`
 * (written by `scripts/process-sprites.ts`). Everything returns `null`
 * on failure so callers can gracefully fall back to the programmatic
 * Graphics renderer when sprites aren't available.
 *
 * The manifest lives at `<basePath>/sprite-manifest.json` and describes:
 *   - background: a single pre-rendered office image
 *   - characters: per-role pose → PNG path mapping
 *   - roleMapping: which character variant maps to each AgentType
 *   - furniture: named prop → PNG path mapping
 *
 * Consumers:
 *   - IsometricOffice calls `loadOfficeAssets(basePath)` once at attach
 *     time. If the manifest is missing, it falls back to procedural
 *     rendering.
 *   - AgentCharacter accepts an optional CharacterSpriteSet via its
 *     options — IsometricOffice plucks one out of the loaded bundle.
 */

import { Assets, Texture } from 'pixi.js'

import type { AgentType } from '@agent-studio/shared'

// ─────────────────────────────────────────────────────────────────────────────
// Manifest shapes
// ─────────────────────────────────────────────────────────────────────────────

/** Per-variant character pose → PNG path. */
export interface CharacterVariantManifest {
  sitting?: string
  standing?: string
  walkRight?: string
  walkLeft?: string
}

/** Top-level manifest written by scripts/process-sprites.ts. */
export interface SpriteManifest {
  background: { file: string }
  characters: Record<string, CharacterVariantManifest>
  /** Maps AgentType → character variant key. */
  roleMapping: Record<string, string>
  furniture: Record<string, string>
}

// ─────────────────────────────────────────────────────────────────────────────
// Loaded asset bundles
// ─────────────────────────────────────────────────────────────────────────────

/** One character's full set of pose textures, keyed off the AgentState. */
export interface CharacterSpriteSet {
  /** Sitting (used for idle / coding / blocked / error — agents sit at desks). */
  sitting: Texture
  /** Standing still, facing the viewer. */
  standing: Texture
  /** Walking right (used for positive-x movement + planning/testing). */
  walkRight: Texture
  /** Walking left (used for negative-x movement). */
  walkLeft: Texture
}

/** Loaded furniture textures keyed by the manifest prop name. */
export type FurnitureBundle = Map<string, Texture>

/** Everything the office scene needs, returned as one bundle. */
export interface OfficeAssets {
  background: Texture
  characters: Map<AgentType, CharacterSpriteSet>
  furniture: FurnitureBundle
  manifest: SpriteManifest
}

// ─────────────────────────────────────────────────────────────────────────────
// Loader
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load every sprite described by the manifest at `<basePath>/sprite-manifest.json`.
 *
 * Returns `null` if the manifest can't be fetched or any required
 * character variant texture is missing. Callers should treat `null` as
 * "sprites unavailable, fall back to programmatic rendering".
 */
export const loadOfficeAssets = async (basePath: string): Promise<OfficeAssets | null> => {
  const trimmedBase = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath

  // 1. Fetch the manifest.
  let manifest: SpriteManifest
  try {
    const res = await fetch(`${trimmedBase}/sprite-manifest.json`)
    if (!res.ok) return null
    manifest = (await res.json()) as SpriteManifest
  } catch {
    return null
  }

  // 2. Load the background texture.
  let background: Texture
  try {
    background = await Assets.load<Texture>(`${trimmedBase}/${manifest.background.file}`)
  } catch {
    return null
  }

  // 3. Load each character variant referenced by the roleMapping.
  const agentTypes: AgentType[] = [
    'architect',
    'coder',
    'tester',
    'researcher',
    'coordinator',
  ]
  const characters = new Map<AgentType, CharacterSpriteSet>()

  for (const role of agentTypes) {
    const variantKey = manifest.roleMapping[role] ?? manifest.roleMapping['default']
    if (!variantKey) continue
    const variant = manifest.characters[variantKey]
    if (!variant) continue
    const set = await loadCharacterVariant(trimmedBase, variant)
    if (set) characters.set(role, set)
  }

  // 4. Load all furniture textures. Missing ones are tolerated — the
  //    scene skips props it can't render.
  const furniture = new Map<string, Texture>()
  for (const [name, relPath] of Object.entries(manifest.furniture)) {
    try {
      const tex = await Assets.load<Texture>(`${trimmedBase}/${relPath}`)
      furniture.set(name, tex)
    } catch {
      // Skip silently — IsometricOffice will draw a Graphics placeholder.
    }
  }

  return { background, characters, furniture, manifest }
}

/**
 * Load one character variant's pose textures. We try each slot and fall
 * back sensibly: if a pose is missing, substitute the best available
 * alternative so the scene never shows a blank sprite.
 */
const loadCharacterVariant = async (
  basePath: string,
  variant: CharacterVariantManifest,
): Promise<CharacterSpriteSet | null> => {
  const loaded: Partial<CharacterSpriteSet> = {}

  const slots: Array<[keyof CharacterSpriteSet, string | undefined]> = [
    ['sitting', variant.sitting],
    ['standing', variant.standing],
    ['walkRight', variant.walkRight],
    ['walkLeft', variant.walkLeft],
  ]

  for (const [slot, relPath] of slots) {
    if (!relPath) continue
    try {
      loaded[slot] = await Assets.load<Texture>(`${basePath}/${relPath}`)
    } catch {
      // Leave empty — we'll fill it in with a fallback below.
    }
  }

  // Pick a fallback texture — prefer standing, then sitting, then any.
  const fallback = loaded.standing ?? loaded.sitting ?? loaded.walkRight ?? loaded.walkLeft
  if (!fallback) return null

  return {
    sitting: loaded.sitting ?? fallback,
    standing: loaded.standing ?? fallback,
    walkRight: loaded.walkRight ?? loaded.standing ?? fallback,
    walkLeft: loaded.walkLeft ?? loaded.walkRight ?? loaded.standing ?? fallback,
  }
}

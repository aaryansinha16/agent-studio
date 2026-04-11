/**
 * Sprite asset processor.
 *
 * Three jobs:
 *   1. Fix furniture PNGs — detect the solid background color from the
 *      corner pixels, punch matching pixels out to transparent, auto-trim,
 *      resize with nearest-neighbor, save in place.
 *   2. Extract characters from assets-raw/characters.png using verified
 *      bounding boxes. Remove the grey/white checker background, trim,
 *      resize to 120px height, save each to
 *      packages/studio-ui/public/assets/sprites/characters/.
 *   3. Emit sprite-manifest.json with paths + role mapping, and mirror
 *      the characters + manifest into desktop-overlay's public folder.
 *
 * Usage:
 *   npm run process-sprites
 *
 * All paths are repo-relative so the script must be run from the repo root.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import sharp from 'sharp'

const REPO_ROOT = path.resolve(process.cwd())
const STUDIO_PUBLIC = path.join(REPO_ROOT, 'packages/studio-ui/public/assets/sprites')
const OVERLAY_PUBLIC = path.join(REPO_ROOT, 'packages/desktop-overlay/public/assets/sprites')
const RAW_CHARACTERS = path.join(REPO_ROOT, 'assets-raw/characters.png')
const FURNITURE_DIR = path.join(STUDIO_PUBLIC, 'furniture')
const CHARACTERS_OUT = path.join(STUDIO_PUBLIC, 'characters')

/** Background-color sensitivity for furniture: ±40 on each channel. */
const FURNITURE_BG_THRESHOLD = 40

/** Target widths for each furniture sprite (in pixels). */
const FURNITURE_WIDTHS: Record<string, number> = {
  desk: 160,
  chair: 80,
  whiteboard: 180,
  bookshelf: 120,
  'filing-cabinet': 70,
  'water-cooler': 60,
  plant: 50,
  clock: 50,
  'poster-ship-it': 60,
  window: 160,
  'coffee-mug': 30,
  cup: 24,
  'trash-can': 36,
  'ceiling-light': 180,
}

// ─────────────────────────────────────────────────────────────────────────────
// Character bounding boxes (verified visually by the user).
// ─────────────────────────────────────────────────────────────────────────────

interface CharSpec {
  name: string
  x: number
  y: number
  w: number
  h: number
}

const CHARACTER_SPECS: CharSpec[] = [
  // Row 1
  { name: 'architect-sitting', x: 0, y: 0, w: 210, h: 185 },
  { name: 'coder-standing', x: 210, y: 0, w: 120, h: 185 },
  { name: 'coder-walk-right', x: 330, y: 0, w: 130, h: 185 },
  { name: 'tester-walk-right', x: 460, y: 0, w: 120, h: 185 },
  { name: 'researcher-sitting', x: 680, y: 0, w: 200, h: 185 },
  { name: 'coordinator-walk-right', x: 880, y: 0, w: 130, h: 185 },
  { name: 'coder2-sitting', x: 1100, y: 0, w: 276, h: 185 },
  // Row 2
  { name: 'architect-standing', x: 0, y: 185, w: 140, h: 195 },
  { name: 'coder-walk-right2', x: 210, y: 185, w: 130, h: 195 },
  { name: 'tester-standing', x: 460, y: 185, w: 120, h: 195 },
  { name: 'coordinator-standing', x: 880, y: 185, w: 120, h: 195 },
  { name: 'coder2-standing', x: 1100, y: 185, w: 120, h: 195 },
  { name: 'coder2-walk-right', x: 1220, y: 185, w: 156, h: 195 },
  // Row 3
  { name: 'architect-sitting2', x: 0, y: 375, w: 200, h: 185 },
  { name: 'coder-walk-left', x: 330, y: 375, w: 130, h: 185 },
  { name: 'tester-walk-left', x: 460, y: 375, w: 120, h: 185 },
  { name: 'researcher-sitting2', x: 680, y: 375, w: 200, h: 185 },
  { name: 'researcher-standing', x: 880, y: 375, w: 110, h: 185 },
  { name: 'researcher-walk', x: 990, y: 375, w: 110, h: 185 },
  // Row 4
  { name: 'coordinator-sitting', x: 0, y: 565, w: 210, h: 203 },
  { name: 'coordinator-walk-left', x: 330, y: 565, w: 130, h: 203 },
]

/** Target character height after processing. */
const CHARACTER_TARGET_HEIGHT = 120

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Ensure a directory exists, creating it recursively if needed. */
const ensureDir = async (dir: string): Promise<void> => {
  await fs.mkdir(dir, { recursive: true })
}

/**
 * Detect the dominant background color from the corners of an RGBA buffer.
 * Returns [r, g, b] — alpha is assumed 255 for source pixels.
 */
const detectCornerBackground = (
  buffer: Buffer,
  width: number,
  height: number,
): [number, number, number] => {
  const corners = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
  ] as const
  const samples: Array<[number, number, number]> = []
  for (const [cx, cy] of corners) {
    const idx = (cy * width + cx) * 4
    const r = buffer[idx] ?? 0
    const g = buffer[idx + 1] ?? 0
    const b = buffer[idx + 2] ?? 0
    samples.push([r, g, b])
  }
  // Average the four corner samples.
  const avg: [number, number, number] = [0, 0, 0]
  for (const s of samples) {
    avg[0] += s[0]
    avg[1] += s[1]
    avg[2] += s[2]
  }
  return [
    Math.round(avg[0] / samples.length),
    Math.round(avg[1] / samples.length),
    Math.round(avg[2] / samples.length),
  ]
}

/**
 * Mutate an RGBA buffer: any pixel within `threshold` of `target` color
 * (per channel) gets its alpha zeroed.
 */
const keyOutColor = (
  buffer: Buffer,
  target: [number, number, number],
  threshold: number,
): void => {
  const [tr, tg, tb] = target
  for (let i = 0; i < buffer.length; i += 4) {
    const r = buffer[i] ?? 0
    const g = buffer[i + 1] ?? 0
    const b = buffer[i + 2] ?? 0
    if (
      Math.abs(r - tr) <= threshold &&
      Math.abs(g - tg) <= threshold &&
      Math.abs(b - tb) <= threshold
    ) {
      buffer[i + 3] = 0
    }
  }
}

/**
 * Mutate an RGBA buffer: punch out pixels that look like the grey/white
 * checker pattern used as fake transparency in the raw character sheet.
 * Any pixel where R>170, G>170, B>170 AND (max-min channel diff < 20)
 * becomes transparent.
 */
const keyOutCheckerBackground = (buffer: Buffer): void => {
  for (let i = 0; i < buffer.length; i += 4) {
    const r = buffer[i] ?? 0
    const g = buffer[i + 1] ?? 0
    const b = buffer[i + 2] ?? 0
    if (r > 170 && g > 170 && b > 170) {
      const maxCh = Math.max(r, g, b)
      const minCh = Math.min(r, g, b)
      if (maxCh - minCh < 20) {
        buffer[i + 3] = 0
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Furniture processor
// ─────────────────────────────────────────────────────────────────────────────

const processFurniture = async (): Promise<void> => {
  console.log('→ Processing furniture sprites…')
  const files = await fs.readdir(FURNITURE_DIR)
  const pngs = files.filter((f) => f.toLowerCase().endsWith('.png'))

  for (const file of pngs) {
    const baseName = file.replace(/\.png$/i, '')
    const targetWidth = FURNITURE_WIDTHS[baseName]
    if (!targetWidth) {
      console.log(`  skip ${file} (no target width)`)
      continue
    }

    const fullPath = path.join(FURNITURE_DIR, file)

    // Load into RGBA raw buffer.
    const img = sharp(fullPath).ensureAlpha()
    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true })

    // Detect background color from corners.
    const bg = detectCornerBackground(data, info.width, info.height)

    // Key out background pixels.
    keyOutColor(data, bg, FURNITURE_BG_THRESHOLD)

    // Reconstruct image from modified buffer, then auto-trim + resize.
    const processed = await sharp(data, {
      raw: {
        width: info.width,
        height: info.height,
        channels: 4,
      },
    })
      .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 1 })
      .resize({
        width: targetWidth,
        kernel: sharp.kernel.nearest,
        withoutEnlargement: false,
      })
      .png()
      .toBuffer()

    await fs.writeFile(fullPath, processed)
    console.log(`  ✓ ${file} → w=${targetWidth}, bg=rgb(${bg.join(',')})`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Character processor
// ─────────────────────────────────────────────────────────────────────────────

const processCharacters = async (): Promise<void> => {
  console.log('→ Extracting characters from raw sheet…')
  await ensureDir(CHARACTERS_OUT)

  // Load the full raw sheet once.
  const sheet = sharp(RAW_CHARACTERS).ensureAlpha()
  const sheetMeta = await sheet.metadata()
  console.log(
    `  sheet ${sheetMeta.width}×${sheetMeta.height}, ${CHARACTER_SPECS.length} characters to extract`,
  )

  for (const spec of CHARACTER_SPECS) {
    // Extract the bounding box as a raw RGBA buffer.
    const { data, info } = await sharp(RAW_CHARACTERS)
      .ensureAlpha()
      .extract({ left: spec.x, top: spec.y, width: spec.w, height: spec.h })
      .raw()
      .toBuffer({ resolveWithObject: true })

    // Punch out the checker background.
    keyOutCheckerBackground(data)

    // Reconstruct, trim, resize to 120 height.
    const processed = await sharp(data, {
      raw: { width: info.width, height: info.height, channels: 4 },
    })
      .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 1 })
      .resize({
        height: CHARACTER_TARGET_HEIGHT,
        kernel: sharp.kernel.nearest,
      })
      .png()
      .toBuffer()

    const outPath = path.join(CHARACTERS_OUT, `${spec.name}.png`)
    await fs.writeFile(outPath, processed)
    console.log(`  ✓ ${spec.name}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Manifest + mirror to desktop-overlay
// ─────────────────────────────────────────────────────────────────────────────

interface SpriteManifest {
  background: { file: string }
  characters: Record<string, Record<string, string>>
  roleMapping: Record<string, string>
  furniture: Record<string, string>
}

const writeManifest = async (): Promise<void> => {
  console.log('→ Writing sprite-manifest.json…')
  const manifest: SpriteManifest = {
    background: { file: 'background/office-bg.png' },
    characters: {
      architect: {
        sitting: 'characters/architect-sitting.png',
        standing: 'characters/architect-standing.png',
      },
      coder: {
        standing: 'characters/coder-standing.png',
        walkRight: 'characters/coder-walk-right.png',
        walkLeft: 'characters/coder-walk-left.png',
      },
      tester: {
        standing: 'characters/tester-standing.png',
        walkRight: 'characters/tester-walk-right.png',
        walkLeft: 'characters/tester-walk-left.png',
      },
      researcher: {
        sitting: 'characters/researcher-sitting.png',
        standing: 'characters/researcher-standing.png',
        walkRight: 'characters/researcher-walk.png',
      },
      coordinator: {
        sitting: 'characters/coordinator-sitting.png',
        standing: 'characters/coordinator-standing.png',
        walkRight: 'characters/coordinator-walk-right.png',
        walkLeft: 'characters/coordinator-walk-left.png',
      },
      coder2: {
        sitting: 'characters/coder2-sitting.png',
        standing: 'characters/coder2-standing.png',
        walkRight: 'characters/coder2-walk-right.png',
      },
    },
    roleMapping: {
      architect: 'architect',
      coder: 'coder',
      tester: 'tester',
      researcher: 'researcher',
      coordinator: 'coordinator',
      default: 'coder2',
    },
    furniture: {
      desk: 'furniture/desk.png',
      chair: 'furniture/chair.png',
      whiteboard: 'furniture/whiteboard.png',
      bookshelf: 'furniture/bookshelf.png',
      'filing-cabinet': 'furniture/filing-cabinet.png',
      'water-cooler': 'furniture/water-cooler.png',
      plant: 'furniture/plant.png',
      clock: 'furniture/clock.png',
      'poster-ship-it': 'furniture/poster-ship-it.png',
      window: 'furniture/window.png',
      'coffee-mug': 'furniture/coffee-mug.png',
      cup: 'furniture/cup.png',
      'trash-can': 'furniture/trash-can.png',
      'ceiling-light': 'furniture/ceiling-light.png',
    },
  }
  const json = JSON.stringify(manifest, null, 2)
  const studioManifest = path.join(STUDIO_PUBLIC, 'sprite-manifest.json')
  await fs.writeFile(studioManifest, json)
  console.log(`  ✓ ${studioManifest}`)
}

const mirrorToOverlay = async (): Promise<void> => {
  console.log('→ Mirroring characters + manifest into desktop-overlay…')
  const overlayCharactersDir = path.join(OVERLAY_PUBLIC, 'characters')
  await ensureDir(overlayCharactersDir)

  // Copy each character sprite.
  const files = await fs.readdir(CHARACTERS_OUT)
  for (const file of files) {
    if (!file.toLowerCase().endsWith('.png')) continue
    const src = path.join(CHARACTERS_OUT, file)
    const dst = path.join(overlayCharactersDir, file)
    await fs.copyFile(src, dst)
  }

  // Copy manifest.
  const manifestSrc = path.join(STUDIO_PUBLIC, 'sprite-manifest.json')
  const manifestDst = path.join(OVERLAY_PUBLIC, 'sprite-manifest.json')
  await ensureDir(OVERLAY_PUBLIC)
  await fs.copyFile(manifestSrc, manifestDst)

  console.log(`  ✓ mirrored ${files.length} files + manifest`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  const started = Date.now()
  try {
    await processFurniture()
    await processCharacters()
    await writeManifest()
    await mirrorToOverlay()
    console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  } catch (err) {
    console.error('Sprite processing failed:', err)
    process.exit(1)
  }
}

void main()

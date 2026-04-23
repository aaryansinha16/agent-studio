/**
 * Sprite asset processor.
 *
 * Three jobs:
 *   1. Fix furniture PNGs — detect the solid background color from the
 *      corner pixels, punch matching pixels out to transparent, auto-trim,
 *      resize with nearest-neighbor, save in place.
 *   2. Copy user-provided character PNGs from assets-raw/characters/ into
 *      packages/studio-ui/public/assets/sprites/characters/, resized to
 *      120px tall with nearest-neighbor. The user drops pre-cut,
 *      transparent PNGs named to match the manifest (e.g.
 *      `architect-sitting.png`) — no extraction or keying is performed.
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
const RAW_CHARACTERS_DIR = path.join(REPO_ROOT, 'assets-raw/characters')
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

/**
 * Character names referenced by the manifest. These are the files the
 * script expects to find in `assets-raw/characters/` (as `<name>.png`).
 * Missing files are reported but don't fail the build — the manifest
 * still references the expected output paths so the loader falls back
 * to procedural rendering for unavailable variants.
 */
const CHARACTER_NAMES = [
  // architect
  'architect-sitting',
  'architect-standing',
  // coder
  'coder-standing',
  'coder-walk-right',
  'coder-walk-left',
  // tester
  'tester-standing',
  'tester-walk-right',
  'tester-walk-left',
  // researcher
  'researcher-sitting',
  'researcher-standing',
  'researcher-walk',
  // coordinator
  'coordinator-sitting',
  'coordinator-standing',
  'coordinator-walk-right',
  'coordinator-walk-left',
  // default fallback variant
  'coder2-sitting',
  'coder2-standing',
  'coder2-walk-right',
] as const

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
  console.log('→ Processing user-cut characters from assets-raw/characters/…')
  await ensureDir(CHARACTERS_OUT)

  // Verify the source directory exists. If it doesn't, skip gracefully —
  // the manifest is still written so the loader falls back to procedural
  // rendering for everything.
  try {
    await fs.access(RAW_CHARACTERS_DIR)
  } catch {
    console.log(`  ⚠ ${RAW_CHARACTERS_DIR} not found — skipping character processing`)
    console.log('    Drop pre-cut, transparent PNGs (e.g. architect-sitting.png) there to enable sprites.')
    return
  }

  const files = await fs.readdir(RAW_CHARACTERS_DIR)
  const pngs = new Set(
    files.filter((f) => f.toLowerCase().endsWith('.png')).map((f) => f.replace(/\.png$/i, '')),
  )

  let processed = 0
  const missing: string[] = []

  for (const name of CHARACTER_NAMES) {
    if (!pngs.has(name)) {
      missing.push(name)
      continue
    }
    const src = path.join(RAW_CHARACTERS_DIR, `${name}.png`)
    const resized = await sharp(src)
      .ensureAlpha()
      .resize({
        height: CHARACTER_TARGET_HEIGHT,
        kernel: sharp.kernel.nearest,
      })
      .png()
      .toBuffer()
    const outPath = path.join(CHARACTERS_OUT, `${name}.png`)
    await fs.writeFile(outPath, resized)
    console.log(`  ✓ ${name}`)
    processed += 1
  }

  // Also copy through any extra PNGs the user dropped in (useful for
  // experimentation without wiring them into the manifest yet).
  for (const base of pngs) {
    if (CHARACTER_NAMES.includes(base as (typeof CHARACTER_NAMES)[number])) continue
    const src = path.join(RAW_CHARACTERS_DIR, `${base}.png`)
    const resized = await sharp(src)
      .ensureAlpha()
      .resize({
        height: CHARACTER_TARGET_HEIGHT,
        kernel: sharp.kernel.nearest,
      })
      .png()
      .toBuffer()
    const outPath = path.join(CHARACTERS_OUT, `${base}.png`)
    await fs.writeFile(outPath, resized)
    console.log(`  ✓ ${base} (extra)`)
    processed += 1
  }

  console.log(`  processed ${processed} file(s)`)
  if (missing.length > 0) {
    console.log(
      `  ⚠ missing ${missing.length} manifest character(s): ${missing.join(', ')}`,
    )
    console.log('    The loader will fall back to procedural rendering for these roles.')
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
      bookshelf: 'furniture/bookshelf.png',
      'filing-cabinet': 'furniture/filing-cabinet.png',
      'water-cooler': 'furniture/water-cooler.png',
      plant: 'furniture/plant.png',
      clock: 'furniture/clock.png',
      'poster-ship-it': 'furniture/poster-ship-it.png',
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

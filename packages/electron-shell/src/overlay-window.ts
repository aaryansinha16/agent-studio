/**
 * Overlay Window — transparent, frameless, always-on-top window that
 * covers the entire primary display. Renders only the agent sprites; the
 * rest of the canvas is transparent so the user's normal desktop is
 * visible underneath.
 *
 * Mouse events pass through by default. The renderer toggles capture on a
 * per-mousemove basis via the OVERLAY_SET_MOUSE_PASSTHROUGH IPC channel
 * whenever the cursor enters or leaves an agent sprite's hit area.
 */

import path from 'node:path'

import { BrowserWindow, screen } from 'electron'

import { createLogger } from '@agent-studio/shared'

const log = createLogger('electron-shell:overlay-window')

interface CreateOverlayWindowOptions {
  preloadPath: string
  rendererUrl: string
  openDevtools?: boolean
}

/** Construct, position, and load the Overlay Window. */
export const createOverlayWindow = (
  options: CreateOverlayWindowOptions,
): BrowserWindow => {
  const display = screen.getPrimaryDisplay()

  const window = new BrowserWindow({
    width: display.bounds.width,
    height: display.bounds.height,
    x: display.bounds.x,
    y: display.bounds.y,
    show: false,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    hasShadow: false,
    fullscreenable: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: false,
    // 'panel' on macOS produces a window that doesn't steal focus from
    // the active application — perfect for an overlay that the user
    // should be able to "see through" while continuing to type elsewhere.
    type: process.platform === 'darwin' ? 'panel' : undefined,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: options.preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false,
      // Tells the preload script which window it's running in.
      additionalArguments: ['--studio-role=overlay'],
    },
  })

  // Cover the full display, in case BrowserWindow defaults clipped us.
  window.setBounds(display.bounds)

  // Default to mouse-passthrough; the renderer flips this off temporarily
  // whenever the cursor is over an agent.
  window.setIgnoreMouseEvents(true, { forward: true })

  // Float above other always-on-top windows but stay below the cursor.
  window.setAlwaysOnTop(true, 'screen-saver')
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  window.once('ready-to-show', () => {
    window.showInactive() // show without stealing focus
    if (options.openDevtools) window.webContents.openDevTools({ mode: 'detach' })
  })

  // If the display arrangement changes (resolution, external monitors),
  // resize to whatever the new primary display is.
  const handleDisplayChange = () => {
    if (window.isDestroyed()) return
    const next = screen.getPrimaryDisplay()
    window.setBounds(next.bounds)
  }
  screen.on('display-metrics-changed', handleDisplayChange)
  screen.on('display-added', handleDisplayChange)
  screen.on('display-removed', handleDisplayChange)
  window.once('closed', () => {
    screen.off('display-metrics-changed', handleDisplayChange)
    screen.off('display-added', handleDisplayChange)
    screen.off('display-removed', handleDisplayChange)
  })

  loadRenderer(window, options.rendererUrl).catch((err) => {
    log.error('failed to load overlay renderer', {
      url: options.rendererUrl,
      error: err instanceof Error ? err.message : String(err),
    })
  })

  return window
}

const loadRenderer = async (window: BrowserWindow, target: string): Promise<void> => {
  const isFile = target.startsWith('file://') || path.isAbsolute(target)
  if (isFile) {
    await window.loadFile(target.replace(/^file:\/\//, ''))
    return
  }
  const deadline = Date.now() + 30_000
  let attempt = 0
  while (Date.now() < deadline) {
    try {
      await window.loadURL(target)
      log.info('overlay renderer loaded', { url: target, attempts: attempt + 1 })
      return
    } catch (err) {
      attempt += 1
      log.debug('overlay renderer not ready, retrying', {
        url: target,
        attempt,
        error: err instanceof Error ? err.message : String(err),
      })
      await new Promise<void>((resolve) => setTimeout(resolve, 500))
    }
  }
  throw new Error(`overlay renderer at ${target} did not respond within 30s`)
}

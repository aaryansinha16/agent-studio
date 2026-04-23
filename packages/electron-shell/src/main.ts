/**
 * Electron main process — entry point for Agent Studio's desktop shell.
 *
 * Responsibilities:
 *   1. Connect to the event bridge over WebSocket (single client for the
 *      entire app — both renderer windows receive their data via IPC)
 *   2. Create the Studio Window (bordered React dashboard)
 *   3. Create the Desktop Overlay Window (transparent, click-through Pixi)
 *   4. Wire IPC channels between main and the two renderers
 *   5. Build the system tray with quick controls
 *   6. Handle app lifecycle (single-instance lock, hide on close, quit)
 */

import path from 'node:path'

import { BrowserWindow, app } from 'electron'

import { createLogger } from '@agent-studio/shared'

import { DEFAULT_BRIDGE_HOST, DEFAULT_BRIDGE_PORT } from '@agent-studio/shared'

import { BridgeClient } from './bridge-client.js'
import { type BridgeProcessHandle, startBridgeProcess } from './bridge-process.js'
import { wireIpcBridge } from './ipc-bridge.js'
import { LaunchOrchestrator } from './launch-orchestrator.js'
import { createOverlayWindow } from './overlay-window.js'
import { createStudioWindow } from './studio-window.js'
import { createTray } from './tray.js'

const log = createLogger('electron-shell:main')

// ── runtime configuration ────────────────────────────────────────────────────

const isDev = !app.isPackaged
const STUDIO_URL =
  process.env.STUDIO_URL ??
  (isDev
    ? 'http://localhost:5173'
    : `file://${path.join(__dirname, '../../../studio-ui/dist/index.html')}`)
const OVERLAY_URL =
  process.env.OVERLAY_URL ??
  (isDev
    ? 'http://localhost:5174'
    : `file://${path.join(__dirname, '../../../desktop-overlay/dist/index.html')}`)
const PRELOAD_PATH = path.join(__dirname, '../preload/preload.js')
const OPEN_DEVTOOLS = process.env.STUDIO_DEVTOOLS === '1'

// ── single-instance lock ─────────────────────────────────────────────────────
//
// macOS users routinely double-click apps; we should never spawn a second
// instance because that would mean two overlay windows fighting over
// alwaysOnTop and two WebSocket clients on the bridge.

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
  process.exit(0)
}

// ── lifecycle wiring ─────────────────────────────────────────────────────────

interface RuntimeHandles {
  studioWindow: BrowserWindow | null
  overlayWindow: BrowserWindow | null
  tray: Electron.Tray | null
  bridgeClient: BridgeClient | null
  bridgeProcess: BridgeProcessHandle | null
  launchOrchestrator: LaunchOrchestrator | null
  teardownIpc: (() => void) | null
}

const runtime: RuntimeHandles = {
  studioWindow: null,
  overlayWindow: null,
  tray: null,
  bridgeClient: null,
  bridgeProcess: null,
  launchOrchestrator: null,
  teardownIpc: null,
}

const EXTERNAL_BRIDGE = process.env.RUFLO_EXTERNAL_BRIDGE === '1'
const BRIDGE_HOST = process.env.BRIDGE_HOST ?? DEFAULT_BRIDGE_HOST
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT ?? DEFAULT_BRIDGE_PORT)

const buildStudioWindow = (): BrowserWindow => {
  const window = createStudioWindow({
    preloadPath: PRELOAD_PATH,
    rendererUrl: STUDIO_URL,
    openDevtools: OPEN_DEVTOOLS,
  })
  window.on('closed', () => {
    runtime.studioWindow = null
  })
  return window
}

const buildOverlayWindow = (): BrowserWindow => {
  const window = createOverlayWindow({
    preloadPath: PRELOAD_PATH,
    rendererUrl: OVERLAY_URL,
    openDevtools: OPEN_DEVTOOLS,
  })
  window.on('closed', () => {
    runtime.overlayWindow = null
  })
  return window
}

const ensureWindows = (): void => {
  if (!runtime.studioWindow || runtime.studioWindow.isDestroyed()) {
    runtime.studioWindow = buildStudioWindow()
  } else {
    runtime.studioWindow.show()
    runtime.studioWindow.focus()
  }
  if (!runtime.overlayWindow || runtime.overlayWindow.isDestroyed()) {
    runtime.overlayWindow = buildOverlayWindow()
  } else if (!runtime.overlayWindow.isVisible()) {
    runtime.overlayWindow.showInactive()
  }
}

const resolveRepoRoot = (): string => {
  // In dev, electron runs from packages/electron-shell — the repo root is
  // three levels up from the compiled out/main/ directory.
  // In a packaged app, main.js lives inside app.asar; the bridge cannot
  // run from source in that case and the operator must supply their own
  // via RUFLO_EXTERNAL_BRIDGE=1.
  return path.resolve(__dirname, '../../../..')
}

const startup = async (): Promise<void> => {
  log.info('starting agent studio shell', {
    isDev,
    studioUrl: STUDIO_URL,
    overlayUrl: OVERLAY_URL,
    preload: PRELOAD_PATH,
    externalBridge: EXTERNAL_BRIDGE,
  })

  if (!EXTERNAL_BRIDGE) {
    if (app.isPackaged) {
      log.warn(
        'running packaged build without RUFLO_EXTERNAL_BRIDGE=1 — ' +
          'auto-supervising the bridge via tsx is not supported in packaged builds, ' +
          'the UI will stay in "bridge offline" until a bridge is reachable',
      )
    } else {
      runtime.bridgeProcess = startBridgeProcess({
        host: BRIDGE_HOST,
        port: BRIDGE_PORT,
        repoRoot: resolveRepoRoot(),
      })
      try {
        await runtime.bridgeProcess.waitReady()
      } catch (err) {
        log.error('bridge failed to become ready', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  runtime.bridgeClient = new BridgeClient()
  runtime.bridgeClient.start()

  runtime.launchOrchestrator = new LaunchOrchestrator({
    bridgeClient: runtime.bridgeClient,
  })

  ensureWindows()

  runtime.teardownIpc = wireIpcBridge({
    bridgeClient: runtime.bridgeClient,
    launchOrchestrator: runtime.launchOrchestrator,
    getStudioWindow: () => runtime.studioWindow,
    getOverlayWindow: () => runtime.overlayWindow,
  })

  runtime.tray = createTray({
    getStudioWindow: () => runtime.studioWindow,
    getOverlayWindow: () => runtime.overlayWindow,
  })
}

// ── electron app events ──────────────────────────────────────────────────────

app.on('second-instance', () => {
  // Another launch happened — bring our existing studio window to the front.
  if (runtime.studioWindow && !runtime.studioWindow.isDestroyed()) {
    if (runtime.studioWindow.isMinimized()) runtime.studioWindow.restore()
    runtime.studioWindow.show()
    runtime.studioWindow.focus()
  }
})

app.whenReady().then(() => {
  startup().catch((err) => {
    log.error('startup failed', { error: err instanceof Error ? err.message : String(err) })
    app.quit()
  })
})

app.on('activate', () => {
  // macOS: clicking the dock icon recreates windows if they were closed.
  if (BrowserWindow.getAllWindows().length === 0) {
    ensureWindows()
  }
})

app.on('window-all-closed', () => {
  // We never auto-quit — the tray is the only way out. The overlay window
  // is also kept alive even when the studio window is closed because the
  // user may want to "release" agents to the desktop and tuck the dashboard
  // away.
  if (process.platform !== 'darwin') {
    // Linux/Windows users expect close-to-quit; macOS users don't.
    // Compromise: if the user explicitly closed every window AND we're not
    // on macOS, quit. Otherwise stay alive.
    app.quit()
  }
})

let beforeQuitRan = false
app.on('before-quit', (event) => {
  if (beforeQuitRan) return
  beforeQuitRan = true
  log.info('app quitting, tearing down')
  // Stop any running swarm child process before tearing down IPC.
  runtime.launchOrchestrator?.stop()
  runtime.teardownIpc?.()
  runtime.bridgeClient?.stop()
  if (runtime.tray) {
    runtime.tray.destroy()
    runtime.tray = null
  }
  // Kill the bridge child asynchronously but let Electron wait on us.
  if (runtime.bridgeProcess) {
    event.preventDefault()
    void runtime.bridgeProcess.stop().finally(() => {
      runtime.bridgeProcess = null
      app.quit()
    })
  }
})

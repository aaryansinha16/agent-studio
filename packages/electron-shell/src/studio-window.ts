/**
 * Studio Window — the bordered, resizable utility window that hosts the
 * existing React dashboard (packages/studio-ui).
 *
 * In dev, the window loads the studio-ui Vite dev server URL. In prod,
 * it loads the bundled studio-ui index.html from disk. The path is
 * resolved at startup so we don't pin a specific layout here.
 */

import path from 'node:path'

import { BrowserWindow, shell } from 'electron'

import { createLogger } from '@agent-studio/shared'

const log = createLogger('electron-shell:studio-window')

interface CreateStudioWindowOptions {
  /** Absolute path to the compiled preload script. */
  preloadPath: string
  /** Renderer URL to load. In dev this is a Vite dev server URL. */
  rendererUrl: string
  /** Whether to open Chrome devtools on launch (dev only). */
  openDevtools?: boolean
}

/** Construct and load the Studio Window. */
export const createStudioWindow = (options: CreateStudioWindowOptions): BrowserWindow => {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0A0E14',
    titleBarStyle: 'hiddenInset',
    title: 'Agent Studio',
    webPreferences: {
      preload: options.preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      // Tells the preload script which window it's running in.
      additionalArguments: ['--studio-role=studio'],
    },
  })

  // External links open in the system browser, not inside the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  window.once('ready-to-show', () => {
    window.show()
    if (options.openDevtools) window.webContents.openDevTools({ mode: 'detach' })
  })

  loadRenderer(window, options.rendererUrl).catch((err) => {
    log.error('failed to load studio renderer', {
      url: options.rendererUrl,
      error: err instanceof Error ? err.message : String(err),
    })
  })

  return window
}

/**
 * Load the renderer URL with a small retry loop. The dev script starts
 * Electron alongside the studio-ui Vite server; on a cold start the window
 * may try to load before Vite is listening. We retry every 500 ms for up
 * to 30 seconds before giving up.
 */
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
      log.info('studio renderer loaded', { url: target, attempts: attempt + 1 })
      return
    } catch (err) {
      attempt += 1
      log.debug('studio renderer not ready, retrying', {
        url: target,
        attempt,
        error: err instanceof Error ? err.message : String(err),
      })
      await new Promise<void>((resolve) => setTimeout(resolve, 500))
    }
  }
  throw new Error(`studio renderer at ${target} did not respond within 30s`)
}

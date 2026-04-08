/**
 * System tray icon with quick controls for the dual-window app.
 *
 * The tray menu lets users:
 *   - jump back to the Studio Window if it's hidden
 *   - hide/show the desktop overlay (kill the magic, then bring it back)
 *   - quit the app entirely
 *
 * The icon is a tiny generated PNG so we don't need to ship binary
 * resources for the Phase 3 bootstrap. Phase 5 (polish) will replace it
 * with a proper macOS template image that auto-adjusts for dark/light
 * menu bar.
 */

import { BrowserWindow, Menu, Tray, app, nativeImage } from 'electron'

import { createLogger } from '@agent-studio/shared'

const log = createLogger('electron-shell:tray')

/**
 * 16x16 PNG of a cyan dot (#4ECDC4 with antialiasing) used as the tray
 * icon. Encoded inline so the bootstrap doesn't depend on a resource
 * file. Generated once and pasted here.
 */
const TRAY_ICON_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAZ0lEQVR4nGNgoAXwO3' +
  'uEE4hDgLgaikFsTmI1gzR8AeL/aBgkVk1I8yIsGtHxInw2E9IMw9XomjlxOBsX/oIS' +
  'JtBAIlYzDIeQ63xMb1DDAIq9QFkgUhyNVElIaC4hLymjhQl5mYlUAABjtahEOwqCig' +
  'AAAABJRU5ErkJggg=='

interface TrayOptions {
  getStudioWindow(): BrowserWindow | null
  getOverlayWindow(): BrowserWindow | null
}

/** Build the tray icon. Returns the Tray instance so callers can destroy it. */
export const createTray = (options: TrayOptions): Tray => {
  const icon = buildTrayIcon()
  const tray = new Tray(icon)
  tray.setToolTip('Agent Studio')

  const rebuildMenu = () => {
    const overlay = options.getOverlayWindow()
    const overlayVisible = overlay !== null && !overlay.isDestroyed() && overlay.isVisible()

    const menu = Menu.buildFromTemplate([
      {
        label: 'Show Studio',
        click: () => {
          const studio = options.getStudioWindow()
          if (!studio || studio.isDestroyed()) return
          if (studio.isMinimized()) studio.restore()
          studio.show()
          studio.focus()
        },
      },
      {
        label: overlayVisible ? 'Hide Desktop Agents' : 'Show Desktop Agents',
        click: () => {
          const ov = options.getOverlayWindow()
          if (!ov || ov.isDestroyed()) return
          if (ov.isVisible()) {
            ov.hide()
          } else {
            ov.showInactive()
          }
          rebuildMenu()
        },
      },
      { type: 'separator' },
      {
        label: 'Quit Agent Studio',
        click: () => {
          app.quit()
        },
      },
    ])

    tray.setContextMenu(menu)
  }

  rebuildMenu()
  log.info('system tray ready')
  return tray
}

/** Decode the inlined base64 PNG into a NativeImage usable by Tray. */
const buildTrayIcon = (): Electron.NativeImage => {
  const buffer = Buffer.from(TRAY_ICON_PNG_BASE64, 'base64')
  const image = nativeImage.createFromBuffer(buffer)
  if (image.isEmpty()) {
    log.warn('tray icon decoded as empty image, falling back to empty native image')
    return nativeImage.createEmpty()
  }
  // Mark as a template image so macOS recolors it for the menu bar style.
  if (process.platform === 'darwin') image.setTemplateImage(true)
  return image
}

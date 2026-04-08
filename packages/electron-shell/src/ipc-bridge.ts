/**
 * IPC bridge — wires the main-process BridgeClient to both renderer
 * windows and handles requests coming back the other direction.
 *
 * Channels (defined in @agent-studio/shared/electron-api):
 *   main → renderers : STUDIO_EVENT, STUDIO_CONNECTION, STUDIO_FOCUS_AGENT
 *   renderer → main  : STUDIO_GET_STATE (invoke), OVERLAY_SET_MOUSE_PASSTHROUGH,
 *                      OVERLAY_FOCUS_AGENT
 */

import { BrowserWindow, dialog, ipcMain } from 'electron'

import {
  type BridgeConnectionStatus,
  type LaunchParams,
  type LaunchResult,
  type ProjectSession,
  type StudioEvent,
  type WorkspaceInfo,
  type WorldSnapshot,
  IPC_CHANNELS,
  createLogger,
} from '@agent-studio/shared'

import type { BridgeClient } from './bridge-client.js'
import type { LaunchOrchestrator } from './launch-orchestrator.js'
import { scanWorkspace } from './workspace-scanner.js'

const log = createLogger('electron-shell:ipc')

interface WireOptions {
  bridgeClient: BridgeClient
  /** Synthesizes mock swarms (or, in the future, spawns real Ruflo). */
  launchOrchestrator: LaunchOrchestrator
  /** Returns the current Studio Window, or null if it isn't created yet. */
  getStudioWindow(): BrowserWindow | null
  /** Returns the current Overlay Window, or null if it isn't created yet. */
  getOverlayWindow(): BrowserWindow | null
}

/**
 * Wire all IPC handlers and start fanning bridge events out to renderers.
 * Returns a teardown function that removes every listener.
 */
export const wireIpcBridge = (options: WireOptions): (() => void) => {
  const { bridgeClient, launchOrchestrator, getStudioWindow, getOverlayWindow } = options

  const everyWindow = (): BrowserWindow[] => {
    const out: BrowserWindow[] = []
    const studio = getStudioWindow()
    const overlay = getOverlayWindow()
    if (studio && !studio.isDestroyed()) out.push(studio)
    if (overlay && !overlay.isDestroyed()) out.push(overlay)
    return out
  }

  const broadcast = (channel: string, payload: unknown) => {
    for (const win of everyWindow()) {
      win.webContents.send(channel, payload)
    }
  }

  // ── main → renderers ───────────────────────────────────────────────────────

  const onEvent = (event: StudioEvent) => {
    broadcast(IPC_CHANNELS.STUDIO_EVENT, event)
  }
  const onStatus = (status: BridgeConnectionStatus) => {
    broadcast(IPC_CHANNELS.STUDIO_CONNECTION, status)
  }
  const onSnapshot = (snapshot: WorldSnapshot) => {
    // Snapshots aren't pushed continuously — renderers ask for them via
    // STUDIO_GET_STATE. We just keep the latest cached on the bridge client
    // for that handler. Logging the receipt is useful for diagnosing
    // first-paint issues.
    log.debug('cached new snapshot', {
      agents: snapshot.agents.length,
      tasks: snapshot.tasks.length,
    })
  }

  bridgeClient.on('event', onEvent)
  bridgeClient.on('status', onStatus)
  bridgeClient.on('snapshot', onSnapshot)

  // ── renderer → main (invoke) ───────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.STUDIO_GET_STATE, (): WorldSnapshot => {
    const cached = bridgeClient.getLatestSnapshot()
    if (cached) return cached
    // Bridge client hasn't received a snapshot yet — hand back an empty
    // shell so the renderer can render a "waiting" state instead of
    // throwing.
    return {
      agents: [],
      tasks: [],
      messages: [],
      swarm: null,
      snapshotAt: Date.now(),
    }
  })

  // ── overlay → main ─────────────────────────────────────────────────────────

  const onSetMousePassthrough = (
    _event: Electron.IpcMainEvent,
    passthrough: unknown,
  ) => {
    if (typeof passthrough !== 'boolean') return
    const overlay = getOverlayWindow()
    if (!overlay || overlay.isDestroyed()) return
    overlay.setIgnoreMouseEvents(passthrough, { forward: true })
  }

  const onOverlayFocusAgent = (
    _event: Electron.IpcMainEvent,
    agentId: unknown,
  ) => {
    if (typeof agentId !== 'string' || agentId.length === 0) return
    const studio = getStudioWindow()
    if (!studio || studio.isDestroyed()) {
      log.warn('focus-agent received but studio window not available', { agentId })
      return
    }
    if (studio.isMinimized()) studio.restore()
    if (!studio.isVisible()) studio.show()
    studio.focus()
    studio.webContents.send(IPC_CHANNELS.STUDIO_FOCUS_AGENT, agentId)
  }

  ipcMain.on(IPC_CHANNELS.OVERLAY_SET_MOUSE_PASSTHROUGH, onSetMousePassthrough)
  ipcMain.on(IPC_CHANNELS.OVERLAY_FOCUS_AGENT, onOverlayFocusAgent)

  // ── workspace + launcher (renderer → main, invoke) ────────────────────────

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_PICK, async (): Promise<WorkspaceInfo | null> => {
    const studio = getStudioWindow()
    const result = studio
      ? await dialog.showOpenDialog(studio, {
          properties: ['openDirectory'],
          title: 'Select workspace folder',
        })
      : await dialog.showOpenDialog({
          properties: ['openDirectory'],
          title: 'Select workspace folder',
        })
    if (result.canceled || result.filePaths.length === 0) return null
    const folderPath = result.filePaths[0]
    if (!folderPath) return null
    try {
      return await scanWorkspace(folderPath)
    } catch (err) {
      log.warn('workspace scan failed', {
        path: folderPath,
        error: err instanceof Error ? err.message : String(err),
      })
      return null
    }
  })

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_SCAN,
    async (_event, folderPath: unknown): Promise<WorkspaceInfo | null> => {
      if (typeof folderPath !== 'string' || folderPath.length === 0) return null
      try {
        return await scanWorkspace(folderPath)
      } catch (err) {
        log.warn('workspace scan failed', {
          path: folderPath,
          error: err instanceof Error ? err.message : String(err),
        })
        return null
      }
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.LAUNCH_SWARM,
    async (_event, params: unknown): Promise<LaunchResult> => {
      const validated = validateLaunchParams(params)
      if (!validated) {
        return {
          ok: false,
          command: '',
          mode: 'mock',
          swarmId: '',
          error: 'invalid launch parameters',
        }
      }
      return launchOrchestrator.launch(validated)
    },
  )

  // ── overlay visibility (renderer → main) ──────────────────────────────────

  const onSetOverlayVisible = (
    _event: Electron.IpcMainEvent,
    visible: unknown,
  ) => {
    if (typeof visible !== 'boolean') return
    const overlay = getOverlayWindow()
    if (!overlay || overlay.isDestroyed()) return
    if (visible) {
      if (!overlay.isVisible()) overlay.showInactive()
    } else if (overlay.isVisible()) {
      overlay.hide()
    }
  }
  ipcMain.on(IPC_CHANNELS.OVERLAY_SET_VISIBLE, onSetOverlayVisible)

  // ── projects (renderer → main) ────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.PROJECTS_LIST, async (): Promise<ProjectSession[]> => {
    try {
      return await bridgeClient.listProjects()
    } catch (err) {
      log.warn('listProjects failed, returning cached list', {
        error: err instanceof Error ? err.message : String(err),
      })
      return bridgeClient.getLatestProjects()
    }
  })

  const onSaveProject = (_event: Electron.IpcMainEvent, project: unknown) => {
    if (!project || typeof project !== 'object') return
    const p = project as ProjectSession
    if (typeof p.id !== 'string' || typeof p.folderPath !== 'string') return
    bridgeClient.saveProject(p)
  }
  ipcMain.on(IPC_CHANNELS.PROJECTS_SAVE, onSaveProject)

  // ── teardown ───────────────────────────────────────────────────────────────

  return () => {
    bridgeClient.off('event', onEvent)
    bridgeClient.off('status', onStatus)
    bridgeClient.off('snapshot', onSnapshot)
    ipcMain.removeHandler(IPC_CHANNELS.STUDIO_GET_STATE)
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_PICK)
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_SCAN)
    ipcMain.removeHandler(IPC_CHANNELS.LAUNCH_SWARM)
    ipcMain.removeHandler(IPC_CHANNELS.PROJECTS_LIST)
    ipcMain.removeListener(IPC_CHANNELS.OVERLAY_SET_MOUSE_PASSTHROUGH, onSetMousePassthrough)
    ipcMain.removeListener(IPC_CHANNELS.OVERLAY_FOCUS_AGENT, onOverlayFocusAgent)
    ipcMain.removeListener(IPC_CHANNELS.OVERLAY_SET_VISIBLE, onSetOverlayVisible)
    ipcMain.removeListener(IPC_CHANNELS.PROJECTS_SAVE, onSaveProject)
  }
}

/** Defensively narrow the unknown payload from the renderer into LaunchParams. */
const validateLaunchParams = (raw: unknown): LaunchParams | null => {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const prompt = typeof r.prompt === 'string' ? r.prompt.trim() : ''
  if (!prompt) return null
  const agentCount =
    typeof r.agentCount === 'number' && Number.isFinite(r.agentCount)
      ? Math.max(1, Math.min(20, Math.floor(r.agentCount)))
      : 5
  const strategyRaw = typeof r.strategy === 'string' ? r.strategy : 'development'
  const strategy: LaunchParams['strategy'] =
    strategyRaw === 'review' ||
    strategyRaw === 'testing' ||
    strategyRaw === 'research' ||
    strategyRaw === 'development'
      ? strategyRaw
      : 'development'
  const workspacePath = typeof r.workspacePath === 'string' ? r.workspacePath : null
  return { prompt, agentCount, strategy, workspacePath }
}

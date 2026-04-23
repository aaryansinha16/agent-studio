/**
 * Preload script for both Studio Window and Desktop Overlay.
 *
 * Runs in a privileged renderer-side context with `contextIsolation: true`,
 * so renderer code never touches `ipcRenderer` directly. Instead, we expose
 * a typed `window.studioBridge` object whose shape is documented in
 * `@agent-studio/shared/electron-api`.
 *
 * The same preload is reused by both windows; each renderer reads
 * `window.studioBridge.role` to know which window it's running in.
 */

import { contextBridge, ipcRenderer } from 'electron'

import {
  type BridgeConnectionStatus,
  type LaunchParams,
  type LaunchResult,
  type ProducerOrigin,
  type ProjectSession,
  type RendererRole,
  type StudioBridgeApi,
  type StudioEvent,
  type WorkspaceInfo,
  type WorldSnapshot,
  IPC_CHANNELS,
} from '@agent-studio/shared'

/**
 * The role is injected via a process arg added when each window is
 * created (`additionalArguments` in webPreferences). We default to
 * 'studio' if it's missing so a misconfigured window degrades gracefully.
 */
const resolveRole = (): RendererRole => {
  for (const arg of process.argv) {
    if (arg === '--studio-role=overlay') return 'overlay'
    if (arg === '--studio-role=studio') return 'studio'
  }
  return 'studio'
}

const role = resolveRole()

const api: StudioBridgeApi = {
  role,

  onEvent(handler) {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: StudioEvent) => {
      handler(payload)
    }
    ipcRenderer.on(IPC_CHANNELS.STUDIO_EVENT, wrapped)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.STUDIO_EVENT, wrapped)
    }
  },

  onConnection(handler) {
    const wrapped = (_event: Electron.IpcRendererEvent, status: BridgeConnectionStatus) => {
      handler(status)
    }
    ipcRenderer.on(IPC_CHANNELS.STUDIO_CONNECTION, wrapped)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.STUDIO_CONNECTION, wrapped)
    }
  },

  onProducer(handler) {
    const wrapped = (_event: Electron.IpcRendererEvent, origin: ProducerOrigin | null) => {
      handler(origin)
    }
    ipcRenderer.on(IPC_CHANNELS.STUDIO_PRODUCER, wrapped)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.STUDIO_PRODUCER, wrapped)
    }
  },

  async requestState() {
    const snapshot = (await ipcRenderer.invoke(IPC_CHANNELS.STUDIO_GET_STATE)) as WorldSnapshot
    return snapshot
  },

  setMousePassthrough(passthrough) {
    if (role !== 'overlay') return
    ipcRenderer.send(IPC_CHANNELS.OVERLAY_SET_MOUSE_PASSTHROUGH, passthrough)
  },

  focusAgent(agentId) {
    if (role !== 'overlay') return
    ipcRenderer.send(IPC_CHANNELS.OVERLAY_FOCUS_AGENT, agentId)
  },

  onAgentFocused(handler) {
    const wrapped = (_event: Electron.IpcRendererEvent, agentId: string) => {
      handler(agentId)
    }
    ipcRenderer.on(IPC_CHANNELS.STUDIO_FOCUS_AGENT, wrapped)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.STUDIO_FOCUS_AGENT, wrapped)
    }
  },

  async pickWorkspace() {
    const result = (await ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_PICK)) as WorkspaceInfo | null
    return result
  },

  async scanWorkspace(folderPath: string) {
    const result = (await ipcRenderer.invoke(
      IPC_CHANNELS.WORKSPACE_SCAN,
      folderPath,
    )) as WorkspaceInfo | null
    return result
  },

  async launchSwarm(params: LaunchParams) {
    const result = (await ipcRenderer.invoke(
      IPC_CHANNELS.LAUNCH_SWARM,
      params,
    )) as LaunchResult
    return result
  },

  setOverlayVisible(visible: boolean) {
    ipcRenderer.send(IPC_CHANNELS.OVERLAY_SET_VISIBLE, visible)
  },

  async listProjects() {
    const result = (await ipcRenderer.invoke(IPC_CHANNELS.PROJECTS_LIST)) as ProjectSession[]
    return result
  },

  saveProject(project: ProjectSession) {
    ipcRenderer.send(IPC_CHANNELS.PROJECTS_SAVE, project)
  },

  async checkRuflo() {
    const result = (await ipcRenderer.invoke(IPC_CHANNELS.RUFLO_CHECK)) as boolean
    return result
  },

  async stopSwarm() {
    await ipcRenderer.invoke(IPC_CHANNELS.SWARM_STOP)
  },
}

contextBridge.exposeInMainWorld('studioBridge', api)

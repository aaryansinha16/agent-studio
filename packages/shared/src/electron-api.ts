/**
 * Contract for the IPC bridge exposed to renderer windows by the Electron
 * preload script.
 *
 * Both the Studio Window and the Desktop Overlay receive the same surface,
 * exposed on `window.studioBridge`. The main process owns the single
 * WebSocket connection to the event bridge and forwards events to whichever
 * renderers are listening; renderers never speak to the bridge directly.
 *
 * IPC channel names live alongside the type so producers and consumers
 * can't drift.
 */

import type {
  AgentType,
  ProjectSession,
  StudioEvent,
  WorldSnapshot,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Workspace + launcher types
// ─────────────────────────────────────────────────────────────────────────────

/** Detected primary stack of a workspace folder, derived from manifest files. */
export type WorkspaceStack =
  | 'node'
  | 'rust'
  | 'python'
  | 'go'
  | 'ruby'
  | 'java'
  | 'unknown';

/** Information about a workspace folder, gathered by the main process. */
export interface WorkspaceInfo {
  /** Absolute folder path (POSIX or Windows). */
  path: string;
  /** Basename of the folder. */
  name: string;
  /** Shallow file count of the folder (excluding common ignored dirs). */
  fileCount: number;
  /** Detected primary stack from manifest files (best-effort). */
  stack: WorkspaceStack;
  /** Current git branch name, or null if not a git repo. */
  gitBranch: string | null;
  /** Unix epoch ms when the scan completed. */
  scannedAt: number;
}

/** Strategy hint passed to the launcher — currently informational only. */
export type SwarmStrategy = 'development' | 'review' | 'testing' | 'research';

/** Parameters the studio renderer sends when the user clicks "Launch Swarm". */
export interface LaunchParams {
  /** The user's free-text description of the work. */
  prompt: string;
  /** Number of agents to spawn (3, 5, 8, 12 in the UI). */
  agentCount: number;
  /** High-level strategy hint. */
  strategy: SwarmStrategy;
  /** Workspace folder the swarm should operate in, if any. */
  workspacePath: string | null;
}

/** Result of a launch — what main tells the renderer happened. */
export interface LaunchResult {
  /** True if the swarm was actually started. */
  ok: boolean;
  /** The constructed CLI command, for display in the UI. */
  command: string;
  /** Either 'mock' (synthesized events) or 'real' (spawned ruflo subprocess). */
  mode: 'mock' | 'real';
  /** Generated swarm id so the UI can correlate events back to this launch. */
  swarmId: string;
  /** Human-readable explanation if ok=false. */
  error?: string;
}

/** Identifies which window a renderer is running in. */
export type RendererRole = 'studio' | 'overlay';

/** Connection status of the main process → event bridge link. */
export type BridgeConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

/** Unsubscribe function returned by every `on*` listener. */
export type Unsubscribe = () => void;

/**
 * The full preload-exposed API. Both renderers may call every method —
 * overlay-specific methods (`setMousePassthrough`, `focusAgent`) are
 * harmless no-ops in the Studio Window.
 */
export interface StudioBridgeApi {
  /** Returns which window this renderer is running in. */
  readonly role: RendererRole;

  /**
   * Subscribe to every StudioEvent forwarded by the main process.
   * Fires for every agent/task/swarm/message event observed on the bridge.
   */
  onEvent(handler: (event: StudioEvent) => void): Unsubscribe;

  /**
   * Subscribe to bridge connection status changes (connecting / connected
   * / disconnected / error). Fires immediately with the current status on
   * subscribe so consumers don't need to poll.
   */
  onConnection(handler: (status: BridgeConnectionStatus) => void): Unsubscribe;

  /** Request the current full world snapshot from the main process. */
  requestState(): Promise<WorldSnapshot>;

  /**
   * Overlay-only: toggle whether the overlay window captures mouse events.
   * `true` means clicks pass through to the desktop; `false` means the
   * window starts capturing them. The renderer calls this on every
   * mousemove based on whether the cursor is currently over an agent
   * sprite.
   */
  setMousePassthrough(passthrough: boolean): void;

  /**
   * Overlay-only: tell the main process the user clicked an agent sprite
   * on the desktop. Main raises and focuses the Studio Window and pushes
   * `studio:focus-agent` to it.
   */
  focusAgent(agentId: string): void;

  /**
   * Studio-only: subscribe to "focus this agent" requests from the
   * overlay. Fires when the user clicks a desktop agent.
   */
  onAgentFocused(handler: (agentId: string) => void): Unsubscribe;

  // ── Workspace ────────────────────────────────────────────────────────────

  /**
   * Studio-only: prompt the user to pick a folder via the OS file dialog
   * and return its scanned `WorkspaceInfo`. Resolves to null if the user
   * cancels.
   */
  pickWorkspace(): Promise<WorkspaceInfo | null>;

  /** Studio-only: re-scan a workspace path and return fresh `WorkspaceInfo`. */
  scanWorkspace(path: string): Promise<WorkspaceInfo | null>;

  // ── Launcher ─────────────────────────────────────────────────────────────

  /**
   * Studio-only: ask the main process to launch a swarm with the given
   * parameters. In mock mode this synthesizes events through the bridge;
   * in real mode it would spawn `ruflo swarm` as a child process (Phase 4).
   */
  launchSwarm(params: LaunchParams): Promise<LaunchResult>;

  // ── Display mode ─────────────────────────────────────────────────────────

  /**
   * Tell the main process to show or hide the desktop overlay window.
   * Used by the Studio Window's display-mode toggle. Safe to call even
   * when no overlay window exists.
   */
  setOverlayVisible(visible: boolean): void;

  // ── Projects ─────────────────────────────────────────────────────────────

  /**
   * Studio-only: ask the bridge for every persisted project. Resolves
   * with the current list — empty array on first run or if the SQLite
   * file is unreachable.
   */
  listProjects(): Promise<ProjectSession[]>;

  /**
   * Studio-only: upsert a project row into the bridge's SQLite store.
   * Fire-and-forget; failures are logged by main but not surfaced to
   * the renderer.
   */
  saveProject(project: ProjectSession): void;
}

/**
 * Helper guard — exposed types depend on whether `window.studioBridge` is
 * present (running inside Electron) or undefined (running in a plain
 * browser dev server).
 */
export const isElectronRuntime = (): boolean =>
  typeof globalThis !== 'undefined' &&
  // @ts-expect-error — global augmentation lives in each renderer
  globalThis.studioBridge !== undefined;

/**
 * IPC channel names — single source of truth for both sides of the IPC
 * boundary. If you add a channel, add it here first.
 */
export const IPC_CHANNELS = {
  /** main → renderer: forward a StudioEvent */
  STUDIO_EVENT: 'studio:event',
  /** main → renderer: bridge connection status changed */
  STUDIO_CONNECTION: 'studio:connection',
  /** main → renderer: focus a specific agent in the studio panel */
  STUDIO_FOCUS_AGENT: 'studio:focus-agent',
  /** renderer → main (invoke): get current world snapshot */
  STUDIO_GET_STATE: 'studio:get-state',
  /** overlay → main: enable/disable mouse passthrough on the overlay window */
  OVERLAY_SET_MOUSE_PASSTHROUGH: 'overlay:set-mouse-passthrough',
  /** overlay → main: open the studio focused on this agent */
  OVERLAY_FOCUS_AGENT: 'overlay:focus-agent',
  /** renderer → main (invoke): show OS folder picker, scan, return info */
  WORKSPACE_PICK: 'workspace:pick',
  /** renderer → main (invoke): re-scan a known path */
  WORKSPACE_SCAN: 'workspace:scan',
  /** renderer → main (invoke): launch a swarm with the given params */
  LAUNCH_SWARM: 'launch:swarm',
  /** renderer → main: show/hide the overlay window */
  OVERLAY_SET_VISIBLE: 'overlay:set-visible',
  /** renderer → main (invoke): ask for the persisted project list */
  PROJECTS_LIST: 'projects:list',
  /** renderer → main: upsert a project */
  PROJECTS_SAVE: 'projects:save',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Launch helper — agent role distribution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pick the agent role mix for a launch given the chosen agent count.
 *
 * Lives in shared so the main-process orchestrator and the renderer
 * preview UI agree on the same distribution. The orchestrator uses it to
 * actually spawn agents; the studio could surface it to the user as a
 * "you'll get N coders, M testers..." preview.
 */
export const distributeAgentRoles = (count: number): AgentType[] => {
  // Defensive clamp — UI offers 3/5/8/12 but be tolerant of arbitrary input.
  const n = Math.max(1, Math.min(20, Math.floor(count)));
  // Always include an architect first; coordinator only when count >= 5.
  const out: AgentType[] = ['architect'];
  if (n >= 5) out.push('coordinator');
  if (n >= 3) out.push('tester');
  if (n >= 4) out.push('researcher');
  // Fill the rest with coders.
  while (out.length < n) out.push('coder');
  return out.slice(0, n);
};

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

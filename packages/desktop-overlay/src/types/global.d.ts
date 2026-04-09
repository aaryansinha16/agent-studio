/// <reference types="vite/client" />

/**
 * `window.studioBridge` is injected by the Electron preload script. The
 * shape lives in @agent-studio/shared so the preload, the studio renderer,
 * and this overlay renderer all see the same contract.
 */

import type { StudioBridgeApi } from '@agent-studio/shared'

declare global {
  interface Window {
    /** Injected by the Electron preload. Undefined when running in a plain browser. */
    studioBridge?: StudioBridgeApi
  }
}

export {}

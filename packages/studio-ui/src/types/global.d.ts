/// <reference types="vite/client" />

import type { StudioBridgeApi } from '@agent-studio/shared'

declare global {
  interface Window {
    /** Injected by the Electron preload script. Undefined in plain browser dev. */
    studioBridge?: StudioBridgeApi
  }
}

export {}

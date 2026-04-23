/**
 * useStudioTransport — pick the right state transport for the runtime.
 *
 * When the studio UI is loaded inside the Electron shell, `window.studioBridge`
 * is injected by the preload script and the main process owns the only
 * WebSocket connection to the event bridge. We subscribe to its IPC stream.
 *
 * When the studio UI is loaded by a plain browser (`npm run dev`), there is
 * no preload, no `studioBridge`, and we open our own WebSocket directly.
 * The behavioral contract for the Zustand store is identical either way.
 *
 * Both transports are wired with mutually-exclusive `enabled` flags so we
 * can call them unconditionally — no Rules-of-Hooks violations, no
 * runtime branching.
 */

import { useEffect } from 'react'

import { useStudioStore } from '../store/studioStore'
import { useWebSocket } from './useWebSocket'

/**
 * Decided once at module load. Electron-vs-browser cannot change inside a
 * running session, so a constant is the right granularity.
 */
const inElectron =
  typeof window !== 'undefined' && window.studioBridge !== undefined

/**
 * Subscribe to the bridge over IPC. No-op when `enabled` is false (i.e.
 * when running in a plain browser).
 *
 * Also subscribes to STUDIO_FOCUS_AGENT so clicks on desktop overlay
 * agents jump back to the studio inspector via `selectAgent`.
 */
const useElectronTransport = (enabled: boolean): void => {
  useEffect(() => {
    if (!enabled) return
    const bridge = window.studioBridge
    if (!bridge) return

    const store = useStudioStore.getState
    let cancelled = false

    // Optimistically show "connecting" until the snapshot resolves.
    store().setConnectionStatus('connecting')

    bridge
      .requestState()
      .then((snapshot) => {
        if (cancelled) return
        store().hydrateFromSnapshot(snapshot)
        // requestState() succeeding proves the bridge is live — set
        // 'connected' here because the onConnection IPC listener only
        // fires on FUTURE status changes and may miss the initial one.
        store().setConnectionStatus('connected')
      })
      .catch((err: unknown) => {
        store().setConnectionStatus('error', err instanceof Error ? err.message : String(err))
      })

    // Detect whether the main process is in real Ruflo mode so the UI
    // can show "LIVE" vs "MOCK MODE" before the first launch.
    bridge
      .checkRuflo()
      .then((available) => {
        if (cancelled) return
        // Real mode is active when both RUFLO_REAL_MODE=1 AND ruflo is installed.
        // The checkRuflo result tells us if ruflo was found; the env var is
        // already baked into the orchestrator's realMode flag. If ruflo is
        // found, we optimistically set mockMode to false (the launch result
        // will confirm or flip it back).
        if (available) store().setMockMode(false)
      })
      .catch(() => {
        // Non-fatal — leave as mock mode.
      })

    // Pull the persisted project list so the Workspace panel's Recent
    // dropdown is populated before the user interacts with it.
    bridge
      .listProjects()
      .then((projects) => {
        if (cancelled) return
        store().hydrateProjects(projects)
      })
      .catch(() => {
        // Non-fatal — the UI just won't show recents until the next call.
      })

    const offEvent = bridge.onEvent((event) => {
      store().applyEvent(event)
    })
    const offConnection = bridge.onConnection((status) => {
      store().setConnectionStatus(status)
    })
    const offProducer = bridge.onProducer((origin) => {
      store().setActiveProducer(origin)
    })
    const offFocus = bridge.onAgentFocused((agentId) => {
      store().selectAgent(agentId)
    })

    return () => {
      cancelled = true
      offEvent()
      offConnection()
      offProducer()
      offFocus()
    }
  }, [enabled])
}

/** Single hook the App component calls. */
export const useStudioTransport = (): void => {
  useElectronTransport(inElectron)
  useWebSocket({ enabled: !inElectron })
}

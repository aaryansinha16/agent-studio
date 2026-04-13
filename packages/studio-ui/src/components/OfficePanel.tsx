import { useEffect, useRef } from 'react'

import { IsometricOffice } from '../canvas/IsometricOffice'
import { selectAgents, useStudioStore } from '../store/studioStore'

/**
 * React wrapper around the Pixi.js IsometricOffice scene.
 *
 * Responsibilities:
 *   - Mount a host div for Pixi
 *   - Construct the scene once on mount, tear it down on unmount
 *   - Subscribe to the Zustand store for agent data and forward to scene
 *   - Subscribe to `applyEvent`-style events so the scene can handle the
 *     `message:sent` choreography (the store doesn't replay past events,
 *     so we grab the last logged event whenever the log grows and pass
 *     it to the scene)
 *   - Route clicks on agents/floor back to the store's selectAgent action
 *
 * Two visual variants:
 *   - 'panel'      (default, used on the Dashboard page) — wrapped in the
 *                  standard panel chrome with a header strip
 *   - 'fullscreen' (used on the Office page) — chromeless; the Pixi
 *                  canvas fills the available area and only a tiny
 *                  "pan · zoom" hint floats in the corner
 */
interface OfficePanelProps {
  variant?: 'panel' | 'fullscreen'
}

const OfficePanel = ({ variant = 'panel' }: OfficePanelProps) => {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const sceneRef = useRef<IsometricOffice | null>(null)

  const selectAgent = useStudioStore((s) => s.selectAgent)
  const selectedAgentId = useStudioStore((s) => s.selectedAgentId)

  // Mount / unmount the scene.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const scene = new IsometricOffice({
      onSelectAgent: (id) => selectAgent(id),
      onDeselect: () => selectAgent(null),
    })
    sceneRef.current = scene
    void scene.attach(host).catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('[OfficePanel] attach failed', err)
    })

    // Hydrate with whatever agents are already in the store.
    scene.setAgents(selectAgents(useStudioStore.getState()))
    scene.setSelectedAgent(useStudioStore.getState().selectedAgentId)

    return () => {
      sceneRef.current = null
      scene.detach()
    }
    // Intentionally run only once — the store subscriptions below keep
    // the scene in sync without re-mounting it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Push agent list changes into the scene.
  useEffect(() => {
    const unsubscribe = useStudioStore.subscribe((state, prev) => {
      if (state.agents !== prev.agents) {
        sceneRef.current?.setAgents(Array.from(state.agents.values()))
      }
    })
    return unsubscribe
  }, [])

  // Push new events into the scene (used for message:sent choreography).
  useEffect(() => {
    const unsubscribe = useStudioStore.subscribe((state, prev) => {
      if (state.log === prev.log) return
      // The log array is prepended — the newest entry is index 0.
      const latest = state.log[0]
      if (!latest) return
      // Only forward event types the scene cares about. It's a no-op
      // for everything else so this is safe to overfire.
      sceneRef.current?.applyEvent(latest.event)
    })
    return unsubscribe
  }, [])

  // Push selected-agent changes into the scene.
  useEffect(() => {
    sceneRef.current?.setSelectedAgent(selectedAgentId)
  }, [selectedAgentId])

  if (variant === 'fullscreen') {
    return (
      <div className="relative h-full min-h-0 w-full overflow-hidden bg-ink-950">
        <div ref={hostRef} className="absolute inset-0" />
      </div>
    )
  }

  return (
    <section className="panel flex h-full min-h-0 flex-col overflow-hidden">
      <header className="panel-header">
        <h2 className="panel-title">Office</h2>
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-slate-500">
          <span>fixed view</span>
        </div>
      </header>
      <div ref={hostRef} className="relative flex-1 overflow-hidden" />
    </section>
  )
}

export default OfficePanel

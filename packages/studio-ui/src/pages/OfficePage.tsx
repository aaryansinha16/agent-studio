import AgentInspector from '../components/AgentInspector'
import FloatingLauncher from '../components/FloatingLauncher'
import OfficePanel from '../components/OfficePanel'
import { useStudioStore } from '../store/studioStore'

/**
 * Office page — the hero view.
 *
 * The isometric Pixi canvas fills the entire page. A floating launcher
 * hugs the bottom-center; when an agent is selected, the inspector
 * slides in from the right as an overlay drawer instead of pushing the
 * canvas aside. This keeps the characters on screen at all times.
 *
 * The display-mode toggle (in the shared header) can still hide the
 * canvas and replace it with a "Desktop mode" placeholder — same logic
 * as the Dashboard page.
 */
const OfficePage = () => {
  const displayMode = useStudioStore((s) => s.displayMode)
  const selectedAgentId = useStudioStore((s) => s.selectedAgentId)
  const showCanvas = displayMode !== 'desktop'

  return (
    <div className="relative flex h-full min-h-0 w-full flex-1 overflow-hidden bg-ink-950">
      {showCanvas ? (
        <OfficePanel variant="fullscreen" />
      ) : (
        <div className="flex h-full w-full items-center justify-center px-8 text-center">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.2em] text-slate-500">
              desktop mode
            </p>
            <p className="mt-2 max-w-sm text-sm text-slate-400">
              Agents are showing on your desktop. Switch to <strong>Studio</strong> or
              <strong> Both</strong> in the header to bring them back into this window.
            </p>
          </div>
        </div>
      )}

      {/* Inspector drawer — slides in over the canvas. */}
      {selectedAgentId ? (
        <div className="absolute bottom-6 right-6 top-6 w-full max-w-sm shadow-2xl">
          <AgentInspector />
        </div>
      ) : null}

      {/* Floating launcher — always available, even in desktop mode. */}
      <FloatingLauncher />
    </div>
  )
}

export default OfficePage

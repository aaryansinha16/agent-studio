import AgentInspector from '../components/AgentInspector'
import ChatLauncher from '../components/ChatLauncher'
import OfficePanel from '../components/OfficePanel'
import WorkspacePanel from '../components/WorkspacePanel'
import EventLog from '../panels/EventLog'
import SwarmOverview from '../panels/SwarmOverview'
import { useStudioStore } from '../store/studioStore'

/**
 * Dashboard page — the control room.
 *
 * Stacked layout: swarm overview → workspace → full ChatLauncher →
 * two/three-column bottom row (office | event log | optional inspector).
 *
 * When the display mode is 'desktop', the office canvas is replaced
 * with a "Desktop mode" placeholder — same behavior as before.
 */
const DashboardPage = () => {
  const displayMode = useStudioStore((s) => s.displayMode)
  const selectedAgentId = useStudioStore((s) => s.selectedAgentId)
  const showCanvas = displayMode !== 'desktop'

  return (
    <main className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
      <SwarmOverview />
      <WorkspacePanel />
      <ChatLauncher />

      <div
        className={[
          'grid min-h-[420px] flex-1 grid-cols-1 gap-4 transition',
          selectedAgentId
            ? 'lg:grid-cols-[minmax(0,3fr)_minmax(0,1.4fr)_minmax(0,1.2fr)]'
            : 'lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]',
        ].join(' ')}
      >
        {showCanvas ? (
          <OfficePanel />
        ) : (
          <section className="panel flex h-full min-h-0 flex-col items-center justify-center px-8 py-12 text-center">
            <p className="font-mono text-xs uppercase tracking-[0.2em] text-slate-500">
              desktop mode
            </p>
            <p className="mt-2 max-w-xs text-sm text-slate-400">
              Agents are showing on your desktop. Switch to <strong>Studio</strong> or
              <strong> Both</strong> to bring them back into this window.
            </p>
          </section>
        )}
        <EventLog />
        {selectedAgentId ? <AgentInspector /> : null}
      </div>
    </main>
  )
}

export default DashboardPage

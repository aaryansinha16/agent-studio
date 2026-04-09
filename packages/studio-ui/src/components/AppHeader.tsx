import DisplayModeToggle from './DisplayModeToggle'
import PageToggle from './PageToggle'
import { useStudioStore } from '../store/studioStore'

/**
 * Shared header rendered by both pages. Owns the product identity, the
 * Page and Display Mode toggles, and the bridge connection indicator.
 *
 * The header is intentionally slim so the OfficePage can give the
 * isometric canvas as much vertical room as possible.
 */
const AppHeader = () => {
  const connectionStatus = useStudioStore((s) => s.connectionStatus)

  return (
    <header className="flex shrink-0 items-center justify-between gap-6 border-b border-ink-800 bg-ink-900/70 px-6 py-3 backdrop-blur">
      <div className="flex items-center gap-3">
        <div className="h-8 w-8 rounded-md bg-gradient-to-br from-accent to-accent-deep shadow-glow" />
        <div>
          <h1 className="font-sans text-base font-semibold tracking-tight text-slate-100">
            Agent Studio
          </h1>
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500">
            see your AI agents work
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <PageToggle />
        <DisplayModeToggle />
      </div>

      <div className="font-mono text-xs text-slate-500">
        {connectionStatus === 'connected' ? (
          <span className="text-accent">● bridge connected</span>
        ) : connectionStatus === 'connecting' ? (
          <span className="text-amber-300">○ connecting…</span>
        ) : (
          <span className="text-rose-400">○ bridge offline</span>
        )}
      </div>
    </header>
  )
}

export default AppHeader

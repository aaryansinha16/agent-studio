import AppHeader from './components/AppHeader'
import { useStudioTransport } from './hooks/useStudioTransport'
import DashboardPage from './pages/DashboardPage'
import OfficePage from './pages/OfficePage'
import { useStudioStore } from './store/studioStore'

/**
 * Top-level app shell.
 *
 * Boots the transport (IPC in Electron, WebSocket in plain dev), mounts
 * the shared header, and conditionally renders either the Office or the
 * Dashboard page based on `currentPage` in the store.
 *
 * The pages are mutually exclusive — only one is ever mounted at a time
 * so the Pixi scene doesn't run twice.
 */
const App = () => {
  useStudioTransport()
  const lastError = useStudioStore((s) => s.lastError)
  const connectionStatus = useStudioStore((s) => s.connectionStatus)
  const currentPage = useStudioStore((s) => s.currentPage)

  return (
    <div className="flex h-full min-h-screen flex-col bg-ink-950 text-slate-200">
      <AppHeader />

      {lastError && connectionStatus !== 'connected' ? (
        <div className="border-b border-rose-900/40 bg-rose-950/30 px-6 py-2 font-mono text-xs text-rose-300">
          {lastError}
        </div>
      ) : null}

      {currentPage === 'office' ? <OfficePage /> : <DashboardPage />}

      <footer className="border-t border-ink-800 bg-ink-900/40 px-6 py-2 text-center font-mono text-[10px] uppercase tracking-[0.2em] text-slate-600">
        {currentPage === 'office'
          ? 'phase 2 · office · floating launcher · fixed view'
          : 'phase 2 · dashboard · launcher + history + inspector'}
      </footer>
    </div>
  )
}

export default App

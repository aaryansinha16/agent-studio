import type { ProducerOrigin } from '@agent-studio/shared'

import DisplayModeToggle from './DisplayModeToggle'
import PageToggle from './PageToggle'
import { useStudioStore, type ConnectionStatus } from '../store/studioStore'

/**
 * Shared header rendered by both pages. Owns the product identity, the
 * Page and Display Mode toggles, and the bridge connection indicator.
 *
 * The header is intentionally slim so the OfficePage can give the
 * isometric canvas as much vertical room as possible.
 */

interface PillSpec {
  label: string
  dotClass: string
  textClass: string
  title: string
}

const resolvePill = (
  status: ConnectionStatus,
  producer: ProducerOrigin | null,
): PillSpec => {
  if (status === 'connecting') {
    return {
      label: 'connecting…',
      dotClass: 'bg-amber-400 animate-pulse',
      textClass: 'text-amber-300',
      title: 'Attempting to reach the event bridge',
    }
  }
  if (status !== 'connected') {
    return {
      label: 'bridge offline',
      dotClass: 'bg-rose-500',
      textClass: 'text-rose-300',
      title:
        'Bridge unreachable — the UI is running but no events are flowing. ' +
        'Check that the event-bridge process is running.',
    }
  }
  if (producer === 'ruflo') {
    return {
      label: 'live · ruflo',
      dotClass: 'bg-accent shadow-glow',
      textClass: 'text-accent',
      title: 'Connected to bridge; events coming from a real Ruflo daemon',
    }
  }
  if (producer === 'orchestrator') {
    return {
      label: 'live · orchestrator',
      dotClass: 'bg-sky-400 shadow-glow',
      textClass: 'text-sky-300',
      title: 'Connected to bridge; events coming from the launch orchestrator',
    }
  }
  if (producer === 'mock') {
    return {
      label: 'mock',
      dotClass: 'bg-amber-300',
      textClass: 'text-amber-200',
      title:
        'Connected to bridge; events are synthesized by the mock generator. ' +
        'Start Ruflo with the plugin loaded to switch to a live feed.',
    }
  }
  return {
    label: 'idle',
    dotClass: 'bg-slate-500',
    textClass: 'text-slate-400',
    title: 'Connected to bridge; no producer is attached yet',
  }
}

const AppHeader = () => {
  const connectionStatus = useStudioStore((s) => s.connectionStatus)
  const activeProducer = useStudioStore((s) => s.activeProducer)
  const pill = resolvePill(connectionStatus, activeProducer)

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

      <div
        className={`flex items-center gap-2 rounded-full border border-ink-800 bg-ink-900/60 px-3 py-1 font-mono text-xs ${pill.textClass}`}
        title={pill.title}
      >
        <span className={`h-2 w-2 rounded-full ${pill.dotClass}`} />
        <span>{pill.label}</span>
      </div>
    </header>
  )
}

export default AppHeader

import { useEffect, useState } from 'react'

import { selectAgents, useStudioStore } from '../store/studioStore'

const formatUptime = (startedAt: number | null): string => {
  if (!startedAt) return '—'
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

const Stat = ({ label, value, accent = false }: { label: string; value: string | number; accent?: boolean }) => (
  <div className="flex flex-col gap-1">
    <span className="text-[10px] uppercase tracking-[0.18em] text-slate-500">{label}</span>
    <span
      className={`font-mono text-2xl ${accent ? 'text-accent' : 'text-slate-100'}`}
    >
      {value}
    </span>
  </div>
)

const SwarmOverview = () => {
  const swarm = useStudioStore((s) => s.swarm)
  const startedAt = useStudioStore((s) => s.startedAt)
  const connectionStatus = useStudioStore((s) => s.connectionStatus)
  const agents = useStudioStore(selectAgents)

  // Tick once a second so the uptime label refreshes.
  const [, force] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => force((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [])

  const counts = agents.reduce(
    (acc, a) => {
      if (a.state === 'idle') acc.idle += 1
      else if (a.state === 'blocked' || a.state === 'error') acc.blocked += 1
      else acc.active += 1
      return acc
    },
    { active: 0, idle: 0, blocked: 0 },
  )

  const connectionLabel: Record<typeof connectionStatus, string> = {
    idle: 'idle',
    connecting: 'connecting…',
    connected: 'live',
    disconnected: 'offline',
    error: 'error',
  }

  const connectionDot: Record<typeof connectionStatus, string> = {
    idle: 'bg-slate-500',
    connecting: 'bg-amber-400 animate-pulse',
    connected: 'bg-accent shadow-glow',
    disconnected: 'bg-rose-400',
    error: 'bg-rose-500',
  }

  return (
    <section className="panel">
      <header className="panel-header">
        <h2 className="panel-title">Swarm Overview</h2>
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <span className={`status-dot ${connectionDot[connectionStatus]}`} />
          <span className="font-mono">{connectionLabel[connectionStatus]}</span>
        </div>
      </header>
      <div className="grid grid-cols-2 gap-6 px-4 py-5 sm:grid-cols-5">
        <Stat label="Topology" value={swarm?.topology ?? '—'} />
        <Stat label="Total" value={agents.length} accent />
        <Stat label="Active" value={counts.active} />
        <Stat label="Idle" value={counts.idle} />
        <Stat label="Blocked" value={counts.blocked} />
      </div>
      <MetricsRow />
      <div className="border-t border-ink-700 px-4 py-3 text-xs text-slate-500">
        <div className="flex flex-wrap items-center justify-between gap-3 font-mono">
          <span>
            swarm: <span className="text-slate-300">{swarm?.id ?? '—'}</span>
          </span>
          <span>
            uptime: <span className="text-slate-300">{formatUptime(startedAt)}</span>
          </span>
        </div>
      </div>
    </section>
  )
}

const formatTokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

const MetricsRow = () => {
  const inputTokens = useStudioStore((s) => s.swarmInputTokens)
  const outputTokens = useStudioStore((s) => s.swarmOutputTokens)
  const cost = useStudioStore((s) => s.swarmCostUsd)
  const model = useStudioStore((s) => s.swarmModel)
  const hasMetrics = inputTokens > 0 || outputTokens > 0 || cost > 0

  if (!hasMetrics) return null

  return (
    <div className="border-t border-ink-700 px-4 py-3">
      <div className="flex flex-wrap items-center gap-4 font-mono text-xs text-slate-400">
        <span>
          <span className="uppercase tracking-wider text-slate-500">tokens </span>
          <span className="text-slate-200">{formatTokens(inputTokens)}</span>
          <span className="text-slate-600"> in · </span>
          <span className="text-slate-200">{formatTokens(outputTokens)}</span>
          <span className="text-slate-600"> out</span>
        </span>
        <span>
          <span className="uppercase tracking-wider text-slate-500">cost </span>
          <span className="text-accent">~${cost.toFixed(2)}</span>
        </span>
        {model ? (
          <span>
            <span className="uppercase tracking-wider text-slate-500">model </span>
            <span className="text-slate-200">{model}</span>
          </span>
        ) : null}
      </div>
    </div>
  )
}

export default SwarmOverview

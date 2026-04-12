import { useState } from 'react'

import type { StudioEvent } from '@agent-studio/shared'

import { useStudioStore } from '../store/studioStore'

const eventColor: Record<StudioEvent['type'], string> = {
  'swarm:initialized': 'text-accent',
  'swarm:shutdown': 'text-slate-500',
  'agent:spawned': 'text-emerald-300',
  'agent:state-changed': 'text-sky-300',
  'agent:terminated': 'text-rose-300',
  'task:started': 'text-amber-300',
  'task:completed': 'text-emerald-300',
  'task:failed': 'text-rose-400',
  'message:sent': 'text-violet-300',
  'agent:log': 'text-slate-400',
  'file:changed': 'text-cyan-300',
  'metrics:update': 'text-amber-200',
}

const formatTime = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getHours().toString().padStart(2, '0')}:${d
    .getMinutes()
    .toString()
    .padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d
    .getMilliseconds()
    .toString()
    .padStart(3, '0')}`
}

const summarize = (event: StudioEvent): string => {
  switch (event.type) {
    case 'swarm:initialized':
      return `${event.swarm.topology} swarm ${event.swarm.id} started`
    case 'swarm:shutdown':
      return `swarm ${event.swarmId} shut down`
    case 'agent:spawned':
      return `${event.agent.type} ${event.agent.name} spawned`
    case 'agent:state-changed': {
      const base = `${event.agentId}: ${event.previousState} → ${event.newState}`
      return event.reason ? `${base} — ${event.reason}` : base
    }
    case 'agent:terminated':
      return `${event.agentId} terminated${event.reason ? ` (${event.reason})` : ''}`
    case 'task:started':
      return `task ${event.task.id}: ${event.task.description}`
    case 'task:completed':
      return `task ${event.taskId} complete${event.agentId ? ` by ${event.agentId}` : ''}`
    case 'task:failed':
      return `task ${event.taskId} failed: ${event.error}`
    case 'message:sent':
      return `${event.message.fromAgent} → ${event.message.toAgent}: ${event.message.content}`
    case 'agent:log':
      return `${event.agentId ?? 'swarm'}: ${event.line}`
    case 'file:changed':
      return `${event.changeType} ${event.filePath}`
    case 'metrics:update':
      return `${event.agentId ?? 'swarm'}: ${event.inputTokens} in / ${event.outputTokens} out${event.costUsd > 0 ? ` · $${event.costUsd.toFixed(3)}` : ''}`
  }
}

/**
 * Event log panel with a fullscreen toggle.
 *
 * In normal mode, the panel sits inside the dashboard grid at whatever
 * height the layout gives it. When the user clicks the expand button,
 * the panel renders as a fixed overlay covering the entire viewport so
 * the full log is readable.
 */
const EventLog = () => {
  const log = useStudioStore((s) => s.log)
  const [expanded, setExpanded] = useState(false)

  const content = (
    <>
      <header className="panel-header">
        <h2 className="panel-title">Event Log</h2>
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs text-slate-400">{log.length}</span>
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            title={expanded ? 'Collapse event log' : 'Expand event log to fullscreen'}
            className="rounded-md border border-ink-700 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-slate-400 transition hover:bg-ink-800 hover:text-slate-200"
          >
            {expanded ? '✕ Close' : '⤢ Expand'}
          </button>
        </div>
      </header>
      {log.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-6 py-12">
          <p className="text-sm text-slate-500">No events yet.</p>
        </div>
      ) : (
        <ol className="flex-1 overflow-y-auto font-mono text-xs">
          {log.map((entry) => (
            <li
              key={entry.id}
              className="grid grid-cols-[auto_auto_1fr] items-baseline gap-3 border-b border-ink-800 px-4 py-2"
            >
              <span className="text-slate-600">{formatTime(entry.receivedAt)}</span>
              <span className={`shrink-0 ${eventColor[entry.event.type]}`}>{entry.event.type}</span>
              <span className="truncate text-slate-300">{summarize(entry.event)}</span>
            </li>
          ))}
        </ol>
      )}
    </>
  )

  if (expanded) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-ink-950/95 backdrop-blur-sm">
        <section className="panel m-4 flex flex-1 flex-col overflow-hidden">
          {content}
        </section>
      </div>
    )
  }

  return (
    <section className="panel flex h-full min-h-0 flex-col">
      {content}
    </section>
  )
}

export default EventLog

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
  }
}

const EventLog = () => {
  const log = useStudioStore((s) => s.log)

  return (
    <section className="panel flex h-full min-h-0 flex-col">
      <header className="panel-header">
        <h2 className="panel-title">Event Log</h2>
        <span className="font-mono text-xs text-slate-400">{log.length}</span>
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
    </section>
  )
}

export default EventLog

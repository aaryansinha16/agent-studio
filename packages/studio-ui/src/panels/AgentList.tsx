import { useMemo } from 'react'

import type { AgentInfo, AgentState } from '@agent-studio/shared'

import { selectAgents, useStudioStore } from '../store/studioStore'

const stateColor: Record<AgentState, string> = {
  idle: 'bg-agent-idle',
  planning: 'bg-agent-planning',
  coding: 'bg-agent-coding',
  testing: 'bg-agent-testing',
  blocked: 'bg-agent-blocked',
  error: 'bg-agent-error',
  communicating: 'bg-agent-communicating',
}

const stateLabel: Record<AgentState, string> = {
  idle: 'Idle',
  planning: 'Planning',
  coding: 'Coding',
  testing: 'Testing',
  blocked: 'Blocked',
  error: 'Error',
  communicating: 'Talking',
}

const formatUptime = (spawnedAt: number, now: number): string => {
  const seconds = Math.max(0, Math.floor((now - spawnedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

interface AgentRowProps {
  agent: AgentInfo
  taskDescription: string | null
  selected: boolean
  onSelect(): void
}

const AgentRow = ({ agent, taskDescription, selected, onSelect }: AgentRowProps) => {
  const now = Date.now()
  return (
    <li className="border-b border-ink-700/60 last:border-b-0">
      <button
        type="button"
        onClick={onSelect}
        className={[
          'flex w-full items-start gap-3 px-4 py-3 text-left transition',
          selected
            ? 'bg-accent/10 ring-1 ring-inset ring-accent/40'
            : 'hover:bg-ink-800/60',
        ].join(' ')}
      >
        <span className={`status-dot mt-2 ${stateColor[agent.state]} shadow-glow`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <p className="truncate font-mono text-sm text-slate-100">{agent.name}</p>
            <span className="shrink-0 text-[10px] uppercase tracking-widest text-slate-500">
              {agent.type}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-2 text-xs text-slate-400">
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-ink-950 ${stateColor[agent.state]}`}
            >
              {stateLabel[agent.state]}
            </span>
            <span className="font-mono text-slate-500">{formatUptime(agent.spawnedAt, now)}</span>
          </div>
          {taskDescription ? (
            <p className="mt-1 truncate text-xs text-slate-400">{taskDescription}</p>
          ) : (
            <p className="mt-1 text-xs italic text-slate-600">no task</p>
          )}
        </div>
      </button>
    </li>
  )
}

const AgentList = () => {
  const agents = useStudioStore(selectAgents)
  const tasks = useStudioStore((s) => s.tasks)
  const selectedAgentId = useStudioStore((s) => s.selectedAgentId)
  const selectAgent = useStudioStore((s) => s.selectAgent)

  const sorted = useMemo(
    () =>
      [...agents].sort((a, b) => {
        if (a.state === b.state) return a.name.localeCompare(b.name)
        return a.state.localeCompare(b.state)
      }),
    [agents],
  )

  return (
    <section className="panel flex h-full min-h-0 flex-col">
      <header className="panel-header">
        <h2 className="panel-title">Agents</h2>
        <span className="font-mono text-xs text-slate-400">{agents.length}</span>
      </header>
      {sorted.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-6 py-12 text-center">
          <p className="text-sm text-slate-500">
            Waiting for agents…
            <br />
            <span className="font-mono text-xs text-slate-600">
              launch a swarm or run the mock generator
            </span>
          </p>
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto">
          {sorted.map((agent) => {
            const task = agent.currentTask ? tasks.get(agent.currentTask) : null
            return (
              <AgentRow
                key={agent.id}
                agent={agent}
                taskDescription={task?.description ?? null}
                selected={selectedAgentId === agent.id}
                onSelect={() => selectAgent(agent.id === selectedAgentId ? null : agent.id)}
              />
            )
          })}
        </ul>
      )}
    </section>
  )
}

export default AgentList

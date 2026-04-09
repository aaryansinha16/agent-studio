import { useState } from 'react'

import type { AgentInfo, AgentState } from '@agent-studio/shared'

import { selectSelectedAgent, useStudioStore } from '../store/studioStore'

/**
 * Slide-out inspector panel for the currently selected agent.
 *
 * Renders nothing when no agent is selected. When an agent is selected,
 * shows a vertical column with:
 *   - header: name + role + colored state badge
 *   - current task description
 *   - terminal output (synthesized in mock mode)
 *   - files touched (synthesized in mock mode)
 *   - send-instruction input (mock: appends to terminal)
 */

const STATE_LABEL: Record<AgentState, string> = {
  idle: 'Idle',
  planning: 'Planning',
  coding: 'Coding',
  testing: 'Testing',
  blocked: 'Blocked',
  error: 'Error',
  communicating: 'Talking',
}

const STATE_BG: Record<AgentState, string> = {
  idle: 'bg-agent-idle',
  planning: 'bg-agent-planning',
  coding: 'bg-agent-coding',
  testing: 'bg-agent-testing',
  blocked: 'bg-agent-blocked',
  error: 'bg-agent-error',
  communicating: 'bg-agent-communicating',
}

const LEVEL_COLOR = {
  info: 'text-slate-300',
  warn: 'text-amber-300',
  error: 'text-rose-400',
  success: 'text-emerald-300',
} as const

const KIND_GLYPH: Record<'created' | 'modified' | 'deleted', string> = {
  created: '＋',
  modified: '≈',
  deleted: '−',
}

const AgentInspector = () => {
  const selected = useStudioStore(selectSelectedAgent)
  const selectAgent = useStudioStore((s) => s.selectAgent)
  const tasks = useStudioStore((s) => s.tasks)
  const agentLogs = useStudioStore((s) => s.agentLogs)
  const agentFiles = useStudioStore((s) => s.agentFiles)
  const messages = useStudioStore((s) => s.messages)

  if (!selected) return null

  const task = selected.currentTask ? tasks.get(selected.currentTask) : null
  const lines = agentLogs.get(selected.id) ?? []
  const files = agentFiles.get(selected.id) ?? []
  const recentMessages = messages
    .filter((m) => m.fromAgent === selected.id || m.toAgent === selected.id)
    .slice(-5)

  return (
    <aside className="panel flex h-full min-h-0 w-full max-w-md flex-col">
      <InspectorHeader agent={selected} onClose={() => selectAgent(null)} />

      <div className="flex-1 overflow-y-auto">
        <Section label="Current task">
          {task ? (
            <p className="text-sm text-slate-200">{task.description}</p>
          ) : (
            <p className="text-sm italic text-slate-600">no task assigned</p>
          )}
        </Section>

        <Section label="Terminal output">
          {lines.length === 0 ? (
            <p className="font-mono text-xs text-slate-600">— no output yet —</p>
          ) : (
            <ol className="space-y-1 font-mono text-[11px] leading-relaxed">
              {lines.map((line) => (
                <li key={line.id} className={LEVEL_COLOR[line.level]}>
                  <span className="mr-2 text-slate-600">
                    {new Date(line.receivedAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </span>
                  {line.text}
                </li>
              ))}
            </ol>
          )}
        </Section>

        <Section label={`Files touched (${files.length})`}>
          {files.length === 0 ? (
            <p className="font-mono text-xs text-slate-600">— none yet —</p>
          ) : (
            <ul className="space-y-1 font-mono text-[11px]">
              {files.map((file) => (
                <li key={file.id} className="flex items-baseline gap-2 text-slate-300">
                  <span className="w-3 text-accent">{KIND_GLYPH[file.kind]}</span>
                  <span className="truncate">{file.path}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {recentMessages.length > 0 ? (
          <Section label="Recent messages">
            <ul className="space-y-2">
              {recentMessages.map((m) => (
                <li key={m.id} className="text-xs text-slate-300">
                  <p className="font-mono text-[10px] uppercase tracking-wider text-slate-500">
                    {m.fromAgent === selected.id ? `→ ${m.toAgent}` : `← ${m.fromAgent}`}
                  </p>
                  <p>{m.content}</p>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
      </div>

      <SendInstruction agent={selected} />
    </aside>
  )
}

const InspectorHeader = ({
  agent,
  onClose,
}: {
  agent: AgentInfo
  onClose: () => void
}) => (
  <header className="flex items-start justify-between gap-3 border-b border-ink-700 px-4 py-3">
    <div className="min-w-0">
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-slate-500">
        {agent.type}
      </p>
      <h3 className="mt-0.5 truncate font-sans text-base font-semibold text-slate-100">
        {agent.name}
      </h3>
      <span
        className={`mt-2 inline-block rounded-md px-2 py-0.5 text-[10px] uppercase tracking-wider text-ink-950 ${STATE_BG[agent.state]}`}
      >
        {STATE_LABEL[agent.state]}
      </span>
    </div>
    <button
      type="button"
      onClick={onClose}
      aria-label="Close inspector"
      className="rounded-md border border-ink-700 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-slate-500 hover:bg-ink-800 hover:text-slate-200"
    >
      ✕
    </button>
  </header>
)

const Section = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="border-b border-ink-800/70 px-4 py-3">
    <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-slate-500">
      {label}
    </p>
    {children}
  </div>
)

/**
 * Mock send-instruction input — appends the message to the agent's
 * synthesized terminal log via the store. In real mode this would send
 * an instruction back into Ruflo's task system (Phase 4).
 */
const SendInstruction = ({ agent }: { agent: AgentInfo }) => {
  const [draft, setDraft] = useState('')
  // We don't have a generic action for "append a synthetic log line", so we
  // simulate the side effect by dispatching a fake message-sent event into
  // the local store. The store's message:sent handler will tack a line onto
  // the agent's terminal automatically.
  const applyEvent = useStudioStore((s) => s.applyEvent)

  const handleSend = () => {
    const text = draft.trim()
    if (!text) return
    applyEvent({
      type: 'message:sent',
      timestamp: Date.now(),
      message: {
        id: `local-${Date.now()}`,
        fromAgent: 'you',
        toAgent: agent.id,
        content: text,
        timestamp: Date.now(),
      },
    })
    setDraft('')
  }

  return (
    <div className="border-t border-ink-700 p-3">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              handleSend()
            }
          }}
          placeholder="Send a message to this agent…"
          className="flex-1 rounded-md border border-ink-700 bg-ink-950/80 px-2.5 py-1.5 font-sans text-xs text-slate-100 placeholder:text-slate-600 focus:border-accent focus:outline-none"
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={draft.trim().length === 0}
          className={[
            'rounded-md px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider transition',
            draft.trim().length > 0
              ? 'bg-accent text-ink-950 hover:bg-accent-soft'
              : 'cursor-not-allowed bg-ink-800 text-slate-600',
          ].join(' ')}
        >
          Send
        </button>
      </div>
    </div>
  )
}

export default AgentInspector

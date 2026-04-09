import { useEffect, useRef, useState } from 'react'

import type { SwarmStrategy } from '@agent-studio/shared'

import { useStudioStore } from '../store/studioStore'

/**
 * Chat launcher — the command center.
 *
 * Lets the user describe a job in plain English, pick the swarm size and
 * strategy, and click "Launch Swarm". In Electron mode the launch goes
 * through window.studioBridge.launchSwarm which forwards to the main
 * process orchestrator. In plain-browser dev mode the button is disabled.
 *
 * History of past launches is rendered below the input.
 */

const AGENT_COUNTS = [3, 5, 8, 12] as const
const STRATEGIES: SwarmStrategy[] = ['development', 'review', 'testing', 'research']

const formatTime = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getHours().toString().padStart(2, '0')}:${d
    .getMinutes()
    .toString()
    .padStart(2, '0')}`
}

const ChatLauncher = () => {
  const [prompt, setPrompt] = useState('')
  const [agentCount, setAgentCount] = useState<number>(5)
  const [strategy, setStrategy] = useState<SwarmStrategy>('development')
  const [launching, setLaunching] = useState(false)
  const [previewCommand, setPreviewCommand] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const workspace = useStudioStore((s) => s.workspace)
  const chatHistory = useStudioStore((s) => s.chatHistory)
  const addChatEntry = useStudioStore((s) => s.addChatEntry)
  const updateChatEntry = useStudioStore((s) => s.updateChatEntry)
  const mockMode = useStudioStore((s) => s.mockMode)

  const electronAvailable = typeof window !== 'undefined' && window.studioBridge !== undefined
  const canLaunch = electronAvailable && !launching && prompt.trim().length > 0

  // Auto-grow the textarea up to a 6-line ceiling.
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    const max = 6 * 22 // ~22px per line at 14px font
    ta.style.height = `${Math.min(max, ta.scrollHeight)}px`
  }, [prompt])

  const handleLaunch = async () => {
    if (!canLaunch) return
    const trimmed = prompt.trim()
    if (!trimmed) return
    setError(null)
    setLaunching(true)
    setPreviewCommand(null)

    const draftEntry = addChatEntry({
      prompt: trimmed,
      agentCount,
      strategy,
      command: '',
      swarmId: '',
      status: 'running',
    })

    try {
      const result = await window.studioBridge!.launchSwarm({
        prompt: trimmed,
        agentCount,
        strategy,
        workspacePath: workspace?.path ?? null,
      })
      setPreviewCommand(result.command)
      updateChatEntry(draftEntry.id, {
        command: result.command,
        swarmId: result.swarmId,
        status: result.ok ? 'running' : 'failed',
        ...(result.error ? { note: result.error } : {}),
      })
      if (!result.ok && result.error) setError(result.error)
      if (result.ok) setPrompt('')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      updateChatEntry(draftEntry.id, { status: 'failed', note: msg })
    } finally {
      setLaunching(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void handleLaunch()
    }
  }

  return (
    <section className="panel">
      <header className="panel-header">
        <h2 className="panel-title">Launch Swarm</h2>
        <span className="font-mono text-[11px] uppercase tracking-wider text-slate-500">
          {mockMode ? 'mock mode' : 'live'}
        </span>
      </header>

      <div className="space-y-4 px-4 py-4">
        {/* Prompt textarea */}
        <div>
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe what you want the agents to build…"
            rows={3}
            className="w-full resize-none rounded-lg border border-ink-700 bg-ink-950/80 px-3 py-2.5 font-sans text-sm text-slate-100 placeholder:text-slate-600 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40"
            disabled={!electronAvailable}
          />
          <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-slate-600">
            ⌘/Ctrl + Enter to launch
          </p>
        </div>

        {/* Controls row */}
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-slate-400">
            <span className="font-mono uppercase tracking-wider text-slate-500">Agents</span>
            <select
              value={agentCount}
              onChange={(e) => setAgentCount(Number(e.target.value))}
              disabled={!electronAvailable}
              className="rounded-md border border-ink-700 bg-ink-900 px-2 py-1 font-mono text-xs text-slate-100 focus:border-accent focus:outline-none"
            >
              {AGENT_COUNTS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-400">
            <span className="font-mono uppercase tracking-wider text-slate-500">Strategy</span>
            <select
              value={strategy}
              onChange={(e) => setStrategy(e.target.value as SwarmStrategy)}
              disabled={!electronAvailable}
              className="rounded-md border border-ink-700 bg-ink-900 px-2 py-1 font-mono text-xs text-slate-100 focus:border-accent focus:outline-none"
            >
              {STRATEGIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>

          <div className="flex-1" />

          <button
            type="button"
            disabled={!canLaunch}
            onClick={handleLaunch}
            className={[
              'rounded-lg px-4 py-2 font-sans text-sm font-semibold tracking-wide transition',
              canLaunch
                ? 'bg-accent text-ink-950 shadow-glow hover:scale-[1.02] hover:bg-accent-soft active:scale-[0.99]'
                : 'cursor-not-allowed bg-ink-800 text-slate-500',
            ].join(' ')}
          >
            {launching ? 'Launching…' : 'Launch Swarm'}
          </button>
        </div>

        {/* Command preview */}
        {previewCommand ? (
          <pre className="overflow-x-auto rounded-md border border-accent/30 bg-ink-950/80 px-3 py-2 font-mono text-[11px] text-accent-soft">
            {previewCommand}
          </pre>
        ) : null}

        {/* Errors */}
        {error ? (
          <p className="font-mono text-xs text-rose-400">launch error: {error}</p>
        ) : null}
        {!electronAvailable ? (
          <p className="font-mono text-[11px] text-slate-600">
            Launcher is only available inside the Electron shell.
          </p>
        ) : null}
      </div>

      {/* History */}
      {chatHistory.length > 0 ? (
        <div className="border-t border-ink-700">
          <p className="px-4 pt-3 font-mono text-[10px] uppercase tracking-[0.18em] text-slate-500">
            History
          </p>
          <ol className="max-h-44 overflow-y-auto px-2 py-2">
            {chatHistory.map((entry) => (
              <li
                key={entry.id}
                className="rounded-md px-2 py-2 text-xs text-slate-400 hover:bg-ink-800/60"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <p className="truncate text-slate-200">{entry.prompt}</p>
                  <StatusBadge status={entry.status} />
                </div>
                <div className="mt-0.5 flex items-center gap-3 font-mono text-[10px] uppercase tracking-wider text-slate-500">
                  <span>{formatTime(entry.startedAt)}</span>
                  <span>{entry.agentCount} agents</span>
                  <span>{entry.strategy}</span>
                </div>
                {entry.note ? (
                  <p className="mt-1 truncate font-mono text-[10px] text-rose-400">{entry.note}</p>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  )
}

const StatusBadge = ({ status }: { status: 'running' | 'completed' | 'failed' }) => {
  const styles: Record<typeof status, string> = {
    running: 'bg-amber-400/15 text-amber-300',
    completed: 'bg-emerald-400/15 text-emerald-300',
    failed: 'bg-rose-400/15 text-rose-300',
  }
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.16em] ${styles[status]}`}
    >
      {status}
    </span>
  )
}

export default ChatLauncher

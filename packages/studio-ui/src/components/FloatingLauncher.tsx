import { useEffect, useRef, useState } from 'react'

import type { SwarmStrategy } from '@agent-studio/shared'

import { useStudioStore } from '../store/studioStore'

/**
 * FloatingLauncher — the compact chat input used on the Office page.
 *
 * Visually distinct from the full ChatLauncher panel on the Dashboard:
 *   - Anchored bottom-center with a translucent dark background so it
 *     floats over the isometric canvas
 *   - No launch history, no strategy description, no command preview
 *   - Just the prompt textarea, the agent-count pill, the strategy
 *     dropdown, and a prominent "Launch" button
 *   - Shows the currently-scoped workspace inline, and a "Select folder
 *     on Dashboard" hint when none is set
 *
 * Launch history still appears on the Dashboard page via the full
 * ChatLauncher — both read and write to the same store slices.
 */

const AGENT_COUNTS = [3, 5, 8, 12] as const
const STRATEGIES: SwarmStrategy[] = ['development', 'review', 'testing', 'research']

const FloatingLauncher = () => {
  const [prompt, setPrompt] = useState('')
  const [agentCount, setAgentCount] = useState<number>(5)
  const [strategy, setStrategy] = useState<SwarmStrategy>('development')
  const [launching, setLaunching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const workspace = useStudioStore((s) => s.workspace)
  const addChatEntry = useStudioStore((s) => s.addChatEntry)
  const updateChatEntry = useStudioStore((s) => s.updateChatEntry)
  const setCurrentPage = useStudioStore((s) => s.setCurrentPage)

  const electronAvailable = typeof window !== 'undefined' && window.studioBridge !== undefined
  const canLaunch = electronAvailable && !launching && prompt.trim().length > 0

  // Auto-grow textarea up to a 4-line ceiling (more compact than Dashboard).
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    const max = 4 * 22
    ta.style.height = `${Math.min(max, ta.scrollHeight)}px`
  }, [prompt])

  const handleLaunch = async () => {
    if (!canLaunch) return
    const trimmed = prompt.trim()
    if (!trimmed) return
    setError(null)
    setLaunching(true)

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
    <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center px-6">
      <div className="pointer-events-auto w-full max-w-2xl rounded-2xl border border-ink-700/70 bg-ink-900/85 p-4 shadow-2xl backdrop-blur-md">
        {/* Workspace chip */}
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            {workspace ? (
              <div className="flex items-center gap-2 text-[11px] text-slate-400">
                <span className="font-mono uppercase tracking-[0.16em] text-slate-500">
                  scope
                </span>
                <span className="truncate font-mono text-slate-200" title={workspace.path}>
                  {workspace.name}
                </span>
                {workspace.gitBranch ? (
                  <span className="shrink-0 rounded-full bg-ink-800 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-slate-400">
                    ⎇ {workspace.gitBranch}
                  </span>
                ) : null}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setCurrentPage('dashboard')}
                className="text-left text-[11px] text-slate-500 hover:text-accent"
              >
                <span className="font-mono uppercase tracking-[0.16em]">
                  scope: any workspace
                </span>
                <span className="ml-2 text-accent underline decoration-dotted underline-offset-2">
                  pick a folder on Dashboard →
                </span>
              </button>
            )}
          </div>
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-slate-500">
            ⌘/Ctrl + Enter
          </span>
        </div>

        {/* Prompt textarea */}
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Describe what you want the agents to build…"
          rows={2}
          className="w-full resize-none rounded-lg border border-ink-700 bg-ink-950/80 px-3 py-2 font-sans text-sm text-slate-100 placeholder:text-slate-600 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40"
          disabled={!electronAvailable}
        />

        {/* Controls row */}
        <div className="mt-3 flex flex-wrap items-center gap-3">
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
              'rounded-lg px-5 py-2 font-sans text-sm font-semibold tracking-wide transition',
              canLaunch
                ? 'bg-accent text-ink-950 shadow-glow hover:scale-[1.02] hover:bg-accent-soft active:scale-[0.99]'
                : 'cursor-not-allowed bg-ink-800 text-slate-500',
            ].join(' ')}
          >
            {launching ? 'Launching…' : 'Launch Swarm'}
          </button>
        </div>

        {error ? (
          <p className="mt-2 font-mono text-[11px] text-rose-400">launch error: {error}</p>
        ) : null}
        {!electronAvailable ? (
          <p className="mt-2 font-mono text-[10px] text-slate-600">
            Launcher is only available inside the Electron shell.
          </p>
        ) : null}
      </div>
    </div>
  )
}

export default FloatingLauncher

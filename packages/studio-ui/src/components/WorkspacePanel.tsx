import { useMemo, useState } from 'react'

import type { WorkspaceStack } from '@agent-studio/shared'

import { useStudioStore } from '../store/studioStore'

/**
 * Workspace selector panel.
 *
 * Displays the currently picked folder + scanned info, and provides a
 * "Select Folder" button that opens the OS dialog via Electron IPC. When
 * running in plain-browser dev mode (no studioBridge), the button is
 * disabled and a hint explains why.
 */

const STACK_LABEL: Record<WorkspaceStack, string> = {
  node: 'Node.js',
  rust: 'Rust',
  python: 'Python',
  go: 'Go',
  ruby: 'Ruby',
  java: 'Java',
  unknown: 'Unknown',
}

const STACK_DOT_COLOR: Record<WorkspaceStack, string> = {
  node: 'bg-emerald-400',
  rust: 'bg-orange-400',
  python: 'bg-sky-400',
  go: 'bg-cyan-400',
  ruby: 'bg-rose-400',
  java: 'bg-amber-400',
  unknown: 'bg-slate-500',
}

const WorkspacePanel = () => {
  const workspace = useStudioStore((s) => s.workspace)
  const openWorkspace = useStudioStore((s) => s.openWorkspace)
  const projects = useStudioStore((s) => s.projects)
  const activeProjectId = useStudioStore((s) => s.activeProjectId)
  const switchProject = useStudioStore((s) => s.switchProject)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const electronAvailable = typeof window !== 'undefined' && window.studioBridge !== undefined

  /** Most recent 5 projects, newest first, excluding the active one. */
  const recentProjects = useMemo(() => {
    const list = Array.from(projects.values()).sort((a, b) => b.lastOpened - a.lastOpened)
    return list.filter((p) => p.id !== activeProjectId).slice(0, 5)
  }, [projects, activeProjectId])

  const handlePick = async () => {
    if (!electronAvailable) return
    setError(null)
    setPicking(true)
    try {
      const result = await window.studioBridge!.pickWorkspace()
      if (result) openWorkspace(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPicking(false)
    }
  }

  const handleRecent = (id: string) => {
    switchProject(id)
  }

  return (
    <section className="panel">
      <header className="panel-header">
        <h2 className="panel-title">Workspace</h2>
        <button
          type="button"
          disabled={!electronAvailable || picking}
          onClick={handlePick}
          className={[
            'rounded-md border px-3 py-1 font-mono text-[11px] uppercase tracking-[0.16em] transition',
            electronAvailable && !picking
              ? 'border-accent/60 text-accent hover:bg-accent/10'
              : 'cursor-not-allowed border-ink-700 text-slate-600',
          ].join(' ')}
        >
          {picking ? 'Picking…' : workspace ? 'Change folder' : 'Select folder'}
        </button>
      </header>

      <div className="px-4 py-4">
        {workspace ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
            <div className="min-w-0">
              <p className="truncate font-mono text-sm text-slate-100">{workspace.name}</p>
              <p className="mt-1 truncate font-mono text-[11px] text-slate-500" title={workspace.path}>
                {workspace.path}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex items-center gap-1.5 rounded-full bg-ink-800 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-slate-300">
                <span className={`h-1.5 w-1.5 rounded-full ${STACK_DOT_COLOR[workspace.stack]}`} />
                {STACK_LABEL[workspace.stack]}
              </span>
              <span className="rounded-full bg-ink-800 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-slate-300">
                {workspace.fileCount} files
              </span>
              {workspace.gitBranch ? (
                <span className="rounded-full bg-ink-800 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-slate-300">
                  ⎇ {workspace.gitBranch}
                </span>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-3 text-sm text-slate-500">
            <span className="mt-0.5 text-accent">▸</span>
            <p>
              {electronAvailable
                ? 'No folder selected yet. Pick one to scope your swarm to a project.'
                : 'Folder picker is only available inside the Electron shell. Run npm run dev:electron.'}
            </p>
          </div>
        )}

        {error ? (
          <p className="mt-3 font-mono text-xs text-rose-400">workspace error: {error}</p>
        ) : null}

        {recentProjects.length > 0 ? (
          <div className="mt-4 border-t border-ink-800/70 pt-3">
            <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-slate-500">
              Recent projects
            </p>
            <ul className="space-y-1">
              {recentProjects.map((project) => (
                <li key={project.id}>
                  <button
                    type="button"
                    onClick={() => handleRecent(project.id)}
                    className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left transition hover:bg-ink-800/60"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-xs text-slate-200">
                        {project.folderName}
                      </span>
                      <span
                        className="block truncate font-mono text-[10px] text-slate-600"
                        title={project.folderPath}
                      >
                        {project.folderPath}
                      </span>
                    </span>
                    <span className="shrink-0 rounded-full bg-ink-800 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-slate-400">
                      {project.chatHistory.length} launches
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  )
}

export default WorkspacePanel

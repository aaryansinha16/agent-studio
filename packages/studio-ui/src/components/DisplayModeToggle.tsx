import { useEffect } from 'react'

import { type DisplayMode, useStudioStore } from '../store/studioStore'

/**
 * Three-state segmented control for the display mode.
 *
 * State lives in the Zustand store. Whenever the value changes (and a
 * studioBridge is present), we send the corresponding overlay-visibility
 * IPC to the main process. The Studio Window itself reads `displayMode`
 * directly from the store and hides its agent list when 'desktop' is
 * active — that wiring lives in App.tsx.
 */

const OPTIONS: ReadonlyArray<{ value: DisplayMode; label: string; hint: string }> = [
  { value: 'studio', label: 'Studio', hint: 'Agents only in this window' },
  { value: 'desktop', label: 'Desktop', hint: 'Agents only on the desktop overlay' },
  { value: 'both', label: 'Both', hint: 'Agents in both places' },
]

const DisplayModeToggle = () => {
  const displayMode = useStudioStore((s) => s.displayMode)
  const setDisplayMode = useStudioStore((s) => s.setDisplayMode)

  // Whenever the mode changes, sync overlay visibility through the bridge.
  useEffect(() => {
    const bridge = window.studioBridge
    if (!bridge) return
    const visible = displayMode === 'desktop' || displayMode === 'both'
    bridge.setOverlayVisible(visible)
  }, [displayMode])

  return (
    <div
      role="radiogroup"
      aria-label="Agent display mode"
      className="inline-flex items-center rounded-lg border border-ink-700 bg-ink-900/80 p-1 shadow-inner"
    >
      {OPTIONS.map((option) => {
        const active = option.value === displayMode
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={option.hint}
            onClick={() => setDisplayMode(option.value)}
            className={[
              'rounded-md px-3 py-1 font-mono text-[11px] uppercase tracking-[0.18em] transition',
              active
                ? 'bg-accent text-ink-950 shadow-glow'
                : 'text-slate-400 hover:bg-ink-800 hover:text-slate-200',
            ].join(' ')}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

export default DisplayModeToggle

import { type StudioPage, useStudioStore } from '../store/studioStore'

/**
 * Top-level page switcher — identical visual language to DisplayModeToggle
 * so the two controls feel related. "Office" is the hero / home;
 * "Dashboard" is the detailed control room.
 */

const OPTIONS: ReadonlyArray<{ value: StudioPage; label: string; hint: string }> = [
  { value: 'office', label: 'Office', hint: 'Full-screen workspace with floating launcher' },
  { value: 'dashboard', label: 'Dashboard', hint: 'Swarm overview, history, and inspector' },
]

const PageToggle = () => {
  const currentPage = useStudioStore((s) => s.currentPage)
  const setCurrentPage = useStudioStore((s) => s.setCurrentPage)

  return (
    <div
      role="radiogroup"
      aria-label="Page"
      className="inline-flex items-center rounded-lg border border-ink-700 bg-ink-900/80 p-1 shadow-inner"
    >
      {OPTIONS.map((option) => {
        const active = option.value === currentPage
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={option.hint}
            onClick={() => setCurrentPage(option.value)}
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

export default PageToggle

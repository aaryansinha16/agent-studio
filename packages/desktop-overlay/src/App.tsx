import { useEffect, useRef, useState } from 'react'

import { OverlayRenderer } from './canvas/OverlayRenderer'

/**
 * Root React component for the desktop overlay.
 *
 * The overlay is intentionally chrome-free: there is no UI, no panels, no
 * background — just a single full-viewport div that hosts the Pixi.js
 * canvas. The OverlayRenderer takes over from there.
 *
 * If `window.studioBridge` is missing (e.g. someone opens the dev URL in a
 * browser instead of through Electron), we render a tiny diagnostic block
 * in the top-left so the developer knows what went wrong instead of
 * staring at a blank page.
 */
const App = () => {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [bridgeMissing, setBridgeMissing] = useState(false)

  useEffect(() => {
    const bridge = window.studioBridge
    if (!bridge) {
      setBridgeMissing(true)
      return
    }
    if (!hostRef.current) return

    const renderer = new OverlayRenderer({ bridge })
    let cancelled = false
    void renderer.attach(hostRef.current).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[overlay] attach failed', err)
    })

    return () => {
      cancelled = true
      renderer.detach()
      void cancelled
    }
  }, [])

  return (
    <>
      <div
        ref={hostRef}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'transparent',
          pointerEvents: 'auto',
        }}
      />
      {bridgeMissing ? (
        <div
          style={{
            position: 'fixed',
            top: 24,
            left: 24,
            padding: '12px 16px',
            background: 'rgba(20, 26, 35, 0.92)',
            color: '#fff',
            fontFamily: 'JetBrains Mono, ui-monospace, Menlo, monospace',
            fontSize: 12,
            border: '1px solid #4ECDC4',
            borderRadius: 8,
            maxWidth: 360,
            pointerEvents: 'auto',
          }}
        >
          <strong style={{ color: '#4ECDC4' }}>desktop-overlay</strong>
          <div style={{ marginTop: 6, opacity: 0.85 }}>
            window.studioBridge is missing — this overlay must be loaded by the Electron shell, not
            by a plain browser. Run <code>npm run dev:electron</code>.
          </div>
        </div>
      ) : null}
    </>
  )
}

export default App

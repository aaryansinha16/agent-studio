import { resolve } from 'node:path'

import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

/**
 * electron-vite config — builds the main process and the preload script.
 *
 * The two renderer windows (Studio Window and Desktop Overlay) live in
 * their own packages with their own Vite configs, so this file
 * intentionally omits a `renderer` block. The main process loads renderer
 * URLs from environment variables in dev (`STUDIO_URL`, `OVERLAY_URL`)
 * and from disk in production.
 *
 * IMPORTANT: `@agent-studio/shared` is excluded from `externalizeDepsPlugin`
 * so it gets bundled INTO main.js / preload.js. The shared package's `main`
 * field points at TypeScript source (so dev tooling like tsx and Vite read
 * src directly), and Node's CommonJS loader can't parse `.ts` files at
 * runtime. Bundling sidesteps the problem entirely — every other workspace
 * dep we add later should be excluded the same way.
 */
const WORKSPACE_DEPS_TO_BUNDLE = ['@agent-studio/shared']

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: WORKSPACE_DEPS_TO_BUNDLE })],
    build: {
      outDir: 'out/main',
      lib: {
        entry: resolve(__dirname, 'src/main.ts'),
        formats: ['cjs'],
        fileName: () => 'main.js',
      },
      rollupOptions: {
        external: ['electron'],
      },
      sourcemap: true,
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: WORKSPACE_DEPS_TO_BUNDLE })],
    build: {
      outDir: 'out/preload',
      lib: {
        entry: resolve(__dirname, 'src/preload.ts'),
        formats: ['cjs'],
        fileName: () => 'preload.js',
      },
      rollupOptions: {
        external: ['electron'],
      },
      sourcemap: true,
    },
  },
})

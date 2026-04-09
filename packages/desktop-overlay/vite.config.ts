import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    // Strict so a stale process holding 5174 fails loudly instead of letting
    // Vite silently move to a different port that the Electron shell isn't
    // pointed at.
    strictPort: true,
    host: '127.0.0.1',
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    outDir: 'dist',
  },
})

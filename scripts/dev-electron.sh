#!/usr/bin/env bash
# Full Electron dev stack — bridge + mock events + both Vite renderers + Electron.
#
# This is the primary command for desktop-overlay development. It starts:
#   1. event bridge       (port 6747)
#   2. mock event generator
#   3. studio-ui Vite     (port 5173) — content for the Studio Window
#   4. desktop-overlay Vite (port 5174) — content for the Overlay Window
#   5. electron-vite dev  — runs the Electron main process and reloads it on edit
#
# Renderer URLs are passed to Electron via env vars so the main process
# knows where to load them.
set -euo pipefail

cd "$(dirname "$0")/.."

export STUDIO_URL="${STUDIO_URL:-http://localhost:5173}"
export OVERLAY_URL="${OVERLAY_URL:-http://localhost:5174}"

# CRITICAL: ELECTRON_RUN_AS_NODE=1 in the user's shell environment makes the
# electron binary behave as plain Node.js, which causes `require('electron')`
# inside the main process to return the binary path string instead of the
# Electron API. Unset it here so electron starts in main-process mode no
# matter what the developer's shell is configured to.
unset ELECTRON_RUN_AS_NODE

exec npx --yes concurrently \
  --names "bridge,mock,studio,overlay,electron" \
  --prefix-colors "cyan,yellow,magenta,blue,green" \
  --kill-others-on-fail \
  "npx tsx packages/event-bridge/src/server.ts" \
  "sleep 1 && npx tsx scripts/mock-events.ts" \
  "npm run dev -w @agent-studio/studio-ui" \
  "npm run dev -w @agent-studio/desktop-overlay" \
  "sleep 3 && npm run dev -w @agent-studio/electron-shell"

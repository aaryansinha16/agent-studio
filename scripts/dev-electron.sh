#!/usr/bin/env bash
# Full Electron dev stack — bridge + renderers + Electron.
#
# When RUFLO_REAL_MODE=1, the mock generator is SKIPPED so the UI starts
# clean and only shows events from real Ruflo swarms launched by the user.
# Otherwise (default) the mock generator runs alongside everything else.
set -euo pipefail

cd "$(dirname "$0")/.."

export STUDIO_URL="${STUDIO_URL:-http://localhost:5173}"
export OVERLAY_URL="${OVERLAY_URL:-http://localhost:5174}"
# Make sure RUFLO_REAL_MODE is exported so electron-vite → electron → main.ts
# all see it even if the user set it as a prefix (e.g. RUFLO_REAL_MODE=1 npm run ...).
export RUFLO_REAL_MODE="${RUFLO_REAL_MODE:-0}"

# CRITICAL: ELECTRON_RUN_AS_NODE=1 in the user's shell environment makes the
# electron binary behave as plain Node.js, which causes `require('electron')`
# inside the main process to return the binary path string instead of the
# Electron API. Unset it here so electron starts in main-process mode no
# matter what the developer's shell is configured to.
unset ELECTRON_RUN_AS_NODE

# This dev script already supervises the bridge under `concurrently`, so
# tell Electron main to skip its own supervision path and just connect.
export RUFLO_EXTERNAL_BRIDGE=1

if [ "${RUFLO_REAL_MODE:-0}" = "1" ]; then
  echo "[dev-electron] RUFLO_REAL_MODE=1 — skipping mock generator, waiting for real swarms"
  exec npx --yes concurrently \
    --names "bridge,studio,overlay,electron" \
    --prefix-colors "cyan,magenta,blue,green" \
    --kill-others-on-fail \
    "npx tsx packages/event-bridge/src/server.ts" \
    "npm run dev -w @agent-studio/studio-ui" \
    "npm run dev -w @agent-studio/desktop-overlay" \
    "sleep 3 && npm run dev -w @agent-studio/electron-shell"
else
  exec npx --yes concurrently \
    --names "bridge,mock,studio,overlay,electron" \
    --prefix-colors "cyan,yellow,magenta,blue,green" \
    --kill-others-on-fail \
    "npx tsx packages/event-bridge/src/server.ts" \
    "sleep 1 && npx tsx scripts/mock-events.ts" \
    "npm run dev -w @agent-studio/studio-ui" \
    "npm run dev -w @agent-studio/desktop-overlay" \
    "sleep 3 && npm run dev -w @agent-studio/electron-shell"
fi

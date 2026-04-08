#!/usr/bin/env bash
# Start the Studio UI against the mock event generator — no Ruflo required.
#
# Use this for UI work: it boots the bridge, fires synthetic StudioEvents at
# it from scripts/mock-events.ts, and serves the React app via Vite.
set -euo pipefail

cd "$(dirname "$0")/.."

exec npx --yes concurrently \
  --names "bridge,mock,ui" \
  --prefix-colors "cyan,yellow,magenta" \
  --kill-others-on-fail \
  "npx tsx packages/event-bridge/src/server.ts" \
  "sleep 1 && npx tsx scripts/mock-events.ts" \
  "npm run dev -w @agent-studio/studio-ui"

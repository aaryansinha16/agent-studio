#!/usr/bin/env bash
# Start everything needed for a real Ruflo development session.
#
# 1. Ruflo daemon (orchestration engine)
# 2. Agent Studio event bridge
# 3. Studio UI Vite dev server
#
# Stops everything on Ctrl-C via the concurrently --kill-others-on-fail flag.
set -euo pipefail

cd "$(dirname "$0")/.."

exec npx --yes concurrently \
  --names "ruflo,bridge,ui" \
  --prefix-colors "yellow,cyan,magenta" \
  --kill-others-on-fail \
  "npx ruflo daemon start" \
  "npx tsx packages/event-bridge/src/server.ts" \
  "npm run dev -w @agent-studio/studio-ui"

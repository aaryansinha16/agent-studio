#!/usr/bin/env bash
# Production build — typecheck + build all packages, then bundle the UI.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "[build] cleaning previous artifacts"
npm run clean --silent || true

echo "[build] type-checking and compiling shared/event-bridge/ruflo-plugin"
npx tsc --build

echo "[build] bundling studio-ui"
npm run build -w @agent-studio/studio-ui

echo "[build] done"

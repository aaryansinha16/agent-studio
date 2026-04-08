# Agent Studio — CLAUDE.md

## Project Identity

**Agent Studio** is a hybrid desktop application built on top of Ruflo (formerly Claude Flow) — the open-source multi-agent orchestration platform for Claude. It has two modes:

1. **Studio Window** — A full dashboard with an isometric workspace, task board, terminal views, and agent inspector. This is the power-user control room for managing multi-agent swarms.

2. **Desktop Overlay** — Transparent, frameless window where agent avatars roam freely on the user's macOS desktop, dock, and menubar. Agents appear as animated characters walking around, coding, collaborating — visible on top of all other apps. Click an agent on the desktop to open the Studio Window focused on that agent.

The Studio Window is the utility. The Desktop Overlay is the magic. Together they make AI agent orchestration visible, interactive, and delightful.

This is NOT a fork that modifies Ruflo internals. This is an **additive layer** — a separate Electron application that connects to Ruflo via its plugin/hook system, reads agent state in real-time, and renders it visually. Ruflo runs underneath as the orchestration engine; Agent Studio is the eyes and hands.

## Relationship to Ruflo

Agent Studio is a **completely separate repository and project** from Ruflo. Ruflo is an npm dependency, not a codebase we edit.

```
~/projects/
├── ruflo/              # Cloned/forked Ruflo — NEVER edited by us
│   ├── CLAUDE.md       # Ruflo's own context file — irrelevant to us
│   ├── AGENTS.md       # Ruflo's Codex integration — irrelevant to us
│   └── v3/             # Ruflo source
│
└── agent-studio/       # THIS project — our repo, our code
    ├── CLAUDE.md       # This file
    └── packages/       # All our code lives here
```

- We open Claude Code ONLY in `agent-studio/`. Never in `ruflo/`.
- Ruflo runs as a separate process (daemon). We connect to it via WebSocket.
- Our `ruflo-plugin` package uses `@claude-flow/cli` as an npm dependency (installed via npm, not imported from the sibling directory).
- If Ruflo updates, we `npm update` — no merge conflicts, no file-level coupling.

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│                  Agent Studio                     │
│  ┌─────────────┐  ┌──────────────────────────┐  │
│  │  State Store │  │   Visual Frontend (React) │  │
│  │  (SQLite +   │◄─┤   - Isometric workspace   │  │
│  │   in-memory) │  │   - Agent avatars          │  │
│  │              │  │   - Task panels             │  │
│  └──────▲───────┘  │   - Communication viz      │  │
│         │          └──────────────────────────┘  │
│  ┌──────┴───────┐                                │
│  │ Event Bridge  │  ← Ruflo Plugin (hook listener)│
│  │ (WebSocket)   │                                │
│  └──────▲───────┘                                │
└─────────┼───────────────────────────────────────┘
          │ WebSocket (port 6747)
┌─────────┴───────────────────────────────────────┐
│     Ruflo daemon (separate process)               │
│     Started via: npx ruflo daemon start           │
│     CLI / MCP Server → Router → Swarm → Agents    │
│     Hook events: agent:spawn, task:execute,        │
│     task:complete, swarm:init, memory:store, etc.  │
└─────────────────────────────────────────────────┘
```

## Development Workflow

One terminal, one IDE, one project:

```bash
# From agent-studio/ root:
npm run dev
# This runs concurrently:
#   1. npx ruflo daemon start     (starts Ruflo in background)
#   2. npx ts-node packages/event-bridge/src/server.ts  (WS bridge)
#   3. npx vite packages/studio-ui  (React dev server)
```

You work ONLY in agent-studio/. Ruflo is started as a background process by our dev script, just like you'd start a database.

## Tech Stack

- **Ruflo v3.5.x** — Orchestration engine (npm dependency, not modified)
- **TypeScript** — All new code is TypeScript, strict mode
- **Electron** — Desktop shell with two windows (Studio + Overlay). Chosen over Tauri because we need transparent frameless overlay windows with click-through support, which Electron handles natively on macOS.
- **React 18** — UI for Studio Window panels (task board, inspector, logs)
- **Pixi.js** — 2D rendering for both the isometric workspace (Studio Window) and the desktop agents (Overlay Window). Same sprite/animation system, two render targets.
- **Rive/Lottie** — Agent avatar animations (idle, coding, walking, blocked, etc.)
- **WebSocket (ws)** — Real-time event bridge between Ruflo hooks and frontend
- **SQLite (better-sqlite3)** — Persistent state store for session history
- **Vite** — Build tooling (with electron-vite for Electron integration)

## Dual-Window Architecture

```
Electron Main Process
├── Studio Window (BrowserWindow)
│   ├── Normal bordered window, resizable
│   ├── React app with Pixi.js isometric canvas
│   ├── Dashboard panels: task board, terminal, inspector, logs
│   └── "Release to Desktop" toggle button
│
├── Overlay Window (BrowserWindow)
│   ├── transparent: true, frame: false, alwaysOnTop: true
│   ├── Fullscreen, click-through (setIgnoreMouseEvents)
│   ├── Only renders agent sprites — rest is transparent
│   ├── Agents walk freely across screen, dock, menubar
│   ├── Click an agent → captures mouse → opens inspector
│   └── Right-click agent → context menu (kill, reassign, inspect)
│
└── Shared State (IPC)
    ├── Both windows read from the same Zustand store
    ├── Main process manages WebSocket connection to event bridge
    └── State changes broadcast to both renderers via IPC
```

The overlay uses `setIgnoreMouseEvents(true, { forward: true })` so mouse events pass through to the desktop except where agent sprites are rendered. Electron's `will-mouse-event` callback on macOS lets us selectively capture clicks only on agent hit areas.

## Monorepo Structure

```
agent-studio/
├── CLAUDE.md                    # This file — primary AI context
├── AGENTS.md                    # Agent behavior patterns for AI coding
├── DECISIONS.md                 # Architectural decision log
├── PRODUCT_VISION.md            # Product vision and roadmap
├── package.json                 # Root workspace config
├── packages/
│   ├── ruflo-plugin/            # Ruflo hook listener plugin
│   │   ├── src/
│   │   │   ├── index.ts         # Plugin entry — registers all hooks
│   │   │   ├── event-emitter.ts # Transforms hook data → typed events
│   │   │   └── types.ts         # Shared event type definitions
│   │   ├── package.json         # depends on @claude-flow/cli (npm)
│   │   └── tsconfig.json
│   │
│   ├── event-bridge/            # WebSocket server + state management
│   │   ├── src/
│   │   │   ├── server.ts        # WS server — receives plugin events, broadcasts to UI
│   │   │   ├── state-store.ts   # In-memory + SQLite world state
│   │   │   ├── types.ts         # Shared types (re-exported from plugin)
│   │   │   └── session.ts       # Session recording/replay
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── studio-ui/               # React + Pixi.js — Studio Window content
│   │   ├── src/
│   │   │   ├── App.tsx          # Root component
│   │   │   ├── canvas/          # Pixi.js isometric workspace (Phase 2)
│   │   │   ├── panels/          # React UI panels (inspector, terminal, chat)
│   │   │   ├── hooks/           # React hooks for WS data
│   │   │   └── store/           # Zustand state management
│   │   ├── public/
│   │   │   └── assets/          # Sprites, animations, sounds
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── desktop-overlay/         # Pixi.js — Overlay Window content (Phase 3)
│   │   ├── src/
│   │   │   ├── App.tsx          # Minimal React shell for Pixi canvas
│   │   │   ├── OverlayRenderer.ts  # Pixi.js fullscreen transparent canvas
│   │   │   ├── DesktopAgent.ts  # Agent sprite with desktop roaming behavior
│   │   │   ├── DockDetector.ts  # macOS dock position/size detection
│   │   │   └── HitDetector.ts   # Per-pixel hit detection for click-through
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── electron-shell/          # Electron main process
│   │   ├── src/
│   │   │   ├── main.ts          # Entry — creates both windows, manages IPC
│   │   │   ├── studio-window.ts # Studio Window creation and config
│   │   │   ├── overlay-window.ts# Overlay Window creation and config
│   │   │   ├── ipc-bridge.ts    # IPC handlers for state sync between windows
│   │   │   └── tray.ts          # System tray with quick status and controls
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── shared/                  # Shared types and utilities
│       ├── src/
│       │   ├── types.ts         # All shared TypeScript interfaces
│       │   ├── constants.ts     # Event names, status enums
│       │   └── schemas.ts       # Zod validation schemas
│       ├── package.json
│       └── tsconfig.json
│
└── scripts/
    ├── dev.sh                   # Start Ruflo daemon + bridge + UI
    ├── dev-mock.sh              # Start bridge + mock events + UI (no Ruflo)
    ├── mock-events.ts           # Simulated agent events for UI development
    └── build.sh                 # Production build
```

Note: There is NO `ruflo/` directory inside this project. Ruflo is an npm dependency (`@claude-flow/cli`) and runs as a separate daemon process.

## Code Conventions

- **TypeScript strict mode** everywhere — `"strict": true` in all tsconfig
- **No `any` types** — use `unknown` and narrow, or define proper interfaces
- **Zod** for runtime validation of WebSocket messages and plugin events
- **Named exports only** — no default exports except React components
- **Barrel files** (`index.ts`) at package level only, not in subdirectories
- **Error handling** — all async functions wrapped in try/catch, errors logged with context
- **Formatting** — Prettier with defaults, 2-space indent, single quotes, no semicolons in UI code
- **Testing** — Vitest for unit tests, Playwright for UI integration tests
- **Commits** — Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`

## Key Design Decisions

1. **Pixi.js over Three.js** — This is a 2D isometric view, not 3D. Pixi.js gives us 60fps with hundreds of sprites, better text rendering, and simpler hit detection. Three.js would be overkill and harder to maintain.

2. **WebSocket over polling** — Agents can spawn and complete in milliseconds. Polling at any reasonable interval misses events. WebSocket ensures every state change is captured.

3. **Ruflo as upstream, not modified** — We never edit Ruflo source. Our plugin uses the official hook/plugin API. This means we can pull upstream updates without merge conflicts.

4. **SQLite for state persistence** — Enables session replay (rewind agent activity), cross-session analytics, and crash recovery. In-memory cache sits in front for real-time reads.

5. **Zustand over Redux** — Lighter, less boilerplate, perfect for our scale. The store is the single source of truth for the UI — fed exclusively by WebSocket events.

## Agent State Machine

Every agent in the visual workspace follows this state machine:

```
                    ┌──────────┐
          ┌────────►│  IDLE    │◄────────┐
          │         └────┬─────┘         │
          │              │ task assigned  │ task complete
          │              ▼               │
          │         ┌──────────┐         │
          │    ┌───►│ PLANNING │────┐    │
          │    │    └──────────┘    │    │
          │    │                    ▼    │
          │    │    ┌──────────┐        │
          │    │    │ CODING   │────────┤
          │    │    └──────────┘        │
          │    │                        │
          │    │    ┌──────────┐        │
          │    └────│ TESTING  │────────┤
          │         └──────────┘        │
          │                             │
          │         ┌──────────┐        │
          └─────────│ BLOCKED  │────────┘
                    └──────────┘
                         │
                    ┌──────────┐
                    │  ERROR   │
                    └──────────┘
```

Each state maps to a visual animation:
- IDLE → sitting at desk, subtle breathing animation
- PLANNING → whiteboard/sketching animation
- CODING → typing rapidly, screens active
- TESTING → pacing, checking clipboards
- BLOCKED → head down, warning icon
- ERROR → red glow, alert animation
- COMMUNICATING (overlay) → walking to another agent, speech bubble

## Performance Budgets

- **Frontend frame rate**: 60fps minimum with up to 20 agents visible
- **Event latency**: < 50ms from Ruflo hook fire to UI update
- **Memory**: < 200MB for the desktop app with active session
- **State store writes**: Batched every 100ms to SQLite, not per-event
- **Sprite budget**: Max 50 animated sprites simultaneously (agents + effects)

## What NOT to Do

- NEVER install, edit, or reference Ruflo source files directly — use `@claude-flow/cli` from npm
- NEVER open Claude Code in the ruflo/ directory for Agent Studio work
- NEVER create REST endpoints — everything is WebSocket
- NEVER use `localStorage` or `sessionStorage` — use Zustand + SQLite
- NEVER poll for state — all updates are push-based via WebSocket
- NEVER render agent terminal output in the canvas — use React panels
- NEVER block the Pixi.js render loop with synchronous operations
- NEVER store secrets or API keys in the state store
- NEVER import anything from a relative path outside `packages/` (like `../../ruflo/`)
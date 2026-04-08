# Agent Studio — Initial Bootstrap Prompt

> **Usage**: Open Claude Code in the `agent-studio/` directory where CLAUDE.md, AGENTS.md, PRODUCT_VISION.md, and DECISIONS.md already exist. Paste this prompt to scaffold the project.

---

## Prompt

```
Read CLAUDE.md, AGENTS.md, PRODUCT_VISION.md, and DECISIONS.md before doing anything.

Bootstrap the Agent Studio monorepo. Follow the architecture in CLAUDE.md exactly. Here's what I need:

## 1. Root package.json with npm workspaces

Set up the monorepo with workspaces pointing to packages/*. Add shared dev dependencies:
- typescript 5.5+
- vitest
- prettier
- eslint with @typescript-eslint

Root scripts: "dev" (runs all packages concurrently), "build", "test", "lint"

## 2. packages/shared

Create the shared types package with:

**types.ts** — Define all TypeScript interfaces:
- AgentState enum: IDLE, PLANNING, CODING, TESTING, BLOCKED, ERROR, COMMUNICATING
- AgentInfo: id, name, type (coder/architect/tester/researcher/coordinator), state, currentTask, spawnedAt, position (x,y for isometric grid)
- TaskInfo: id, description, assignedAgent, status (pending/active/complete/failed), startedAt, completedAt
- AgentMessage: fromAgent, toAgent, content, timestamp
- SwarmInfo: id, topology, agentCount, status
- StudioEvent: discriminated union of all event types (agent:spawned, agent:state-changed, agent:terminated, task:started, task:completed, task:failed, swarm:initialized, swarm:shutdown, message:sent)

**constants.ts** — Event name constants, WebSocket port (default 6747), default config

**schemas.ts** — Zod schemas for every type in types.ts for runtime validation

## 3. packages/ruflo-plugin

A Ruflo plugin that listens to hook events and forwards them as typed StudioEvents. This package has `@claude-flow/cli` as an npm dependency — it does NOT import from a local Ruflo directory.

**package.json** should include:
```json
{
  "dependencies": {
    "@claude-flow/cli": "^3.5.0",
    "ws": "^8.0.0",
    "zod": "^3.0.0"
  }
}
```

**index.ts** — The plugin entry point that:
- Uses Ruflo's PluginBuilder API to register hooks for all lifecycle events (reference the hook events from Ruflo's plugin system: agent:pre-spawn, agent:post-spawn, agent:pre-terminate, agent:post-terminate, task:pre-execute, task:post-complete, task:error, swarm:initialized, swarm:shutdown)
- For each hook, transforms the raw Ruflo event data into our StudioEvent types
- Sends each StudioEvent to the event bridge via WebSocket client connection
- Includes reconnection logic with exponential backoff if bridge is not running

**event-emitter.ts** — WebSocket client that connects to the event bridge and sends typed events with Zod validation before sending

## 4. packages/event-bridge

WebSocket server that receives events from the plugin and broadcasts to UI clients.

**server.ts** — WebSocket server on port 6747 that:
- Accepts connections from the Ruflo plugin (producer) and UI clients (consumers)
- Validates all incoming messages with Zod
- Maintains a connection registry
- Broadcasts events to all connected UI clients
- Supports a "replay" message type that sends the current full state to newly connected clients

**state-store.ts** — In-memory state with SQLite persistence:
- Maintains current world state: Map of agents (by ID), Map of tasks, message history, swarm info
- Updates state on each incoming event
- Writes to SQLite in batched 100ms intervals (not per-event)
- Exposes getFullState() for client sync on connect
- Exposes getAgentHistory(agentId) for session replay

**session.ts** — Session manager:
- Records all events with timestamps for replay
- Supports export/import of sessions as JSON

## 5. packages/studio-ui

React frontend with Vite. For Phase 1, NO Pixi.js yet — just React components showing real-time data.

**App.tsx** — Root component with WebSocket connection to event bridge

**hooks/useWebSocket.ts** — Custom hook that connects to ws://localhost:6747, handles reconnection, parses messages with Zod, and pushes to Zustand store

**store/studioStore.ts** — Zustand store with slices for: agents (Map<string, AgentInfo>), tasks (Map<string, TaskInfo>), messages (AgentMessage[]), swarm (SwarmInfo | null), connectionStatus

**panels/AgentList.tsx** — Renders all agents with their current state, colored status indicator, assigned task. Updates in real-time.

**panels/EventLog.tsx** — Scrolling log of all events received, newest at top. Each event shows timestamp, type, and relevant details.

**panels/SwarmOverview.tsx** — Shows swarm topology, total agents, active/idle/blocked counts, uptime.

Use Vite for the dev server. Tailwind CSS for styling. Dark theme matching the color palette in PRODUCT_VISION.md (dark bg, cyan accent #4ECDC4).

## 6. Development scripts

Create a `scripts/dev.sh` that runs concurrently (use `concurrently` npm package):
1. Start Ruflo daemon: `npx ruflo daemon start` (runs in background)
2. Event bridge server: `npx tsx packages/event-bridge/src/server.ts`
3. Studio UI dev server: `cd packages/studio-ui && npx vite`

Also create a `scripts/dev-mock.sh` for UI development WITHOUT Ruflo running:
1. Event bridge server
2. Mock event generator: `npx tsx scripts/mock-events.ts`
3. Studio UI dev server

The mock mode is critical — it lets us develop the UI independently of Ruflo.

## 7. tsconfig

Root tsconfig.json with project references to each package. Each package has its own tsconfig extending the root. Strict mode everywhere.

---

After scaffolding, verify:
1. `npm install` works from root
2. `npm run build` compiles all packages
3. The event bridge starts and listens on port 6747
4. The studio UI dev server starts and shows the dark-themed dashboard
5. Types are shared correctly across packages

Do NOT create any placeholder "TODO" comments. Every file should be functional, even if minimal. If a feature needs more work, note it in a comment referencing the Phase number from PRODUCT_VISION.md.
```

---

## After the Bootstrap — Next Steps

Once the scaffold is built and running, your next prompt should be:

```
Now let's create a mock event generator for development. I need a script in scripts/mock-events.ts that:

1. Connects to the event bridge WebSocket
2. Simulates a realistic Ruflo session:
   - Emits swarm:initialized with hierarchical topology
   - Spawns 6 agents over 2 seconds (architect, 2 coders, tester, researcher, coordinator)
   - Assigns tasks to each agent with realistic descriptions
   - Cycles agent states through the state machine (IDLE → PLANNING → CODING → TESTING)
   - Simulates inter-agent messages ("Need the API schema" / "Here's the schema: ...")
   - Simulates one agent getting BLOCKED, then unblocked after 5 seconds
   - Simulates one task failing and being reassigned
   - Runs on a loop with realistic timing (not instant)

This mock lets us develop the UI without running actual Ruflo swarms.
```

Then after the mock is working and the UI is showing live data:

```
Phase 2: Replace the agent list with a Pixi.js isometric workspace.
Read CLAUDE.md and PRODUCT_VISION.md Phase 2 checklist.
Start with the isometric grid floor, then add agent avatars as colored circles with name labels positioned on the grid. Each agent's position should be deterministic based on their index (arranged in a grid pattern). State changes should update the circle color. This is the foundation before we add sprite animations.
```

# Agent Studio — Architectural Decision Log

Record every non-trivial technical decision here. Format: date, decision, reasoning, alternatives considered.

---

## ADR-001: Additive Layer, Not a Fork
**Date**: 2026-04-08
**Decision**: Agent Studio is a separate project that connects to Ruflo via its plugin/hook API. We do not modify Ruflo source code.
**Reasoning**: Ruflo is actively maintained with frequent releases (v3.5.48 → v3.5.65 in weeks). Forking would create merge hell. The plugin API exposes all lifecycle events we need. Keeping separation means we can pull upstream updates with zero conflicts.
**Alternatives**: (a) Fork and modify — rejected due to maintenance burden. (b) Monkey-patch at runtime — fragile, breaks on updates.

## ADR-002: Pixi.js for 2D Isometric Rendering
**Date**: 2026-04-08
**Decision**: Use Pixi.js v7+ for the visual workspace, not Three.js or pure CSS/SVG.
**Reasoning**: The workspace is 2D isometric, not true 3D. Pixi.js handles hundreds of animated sprites at 60fps with WebGL, has excellent text rendering, built-in hit detection, and sprite sheet support. Three.js would be overkill for a 2D scene and adds complexity (camera management, lighting, shader requirements). Pure CSS/SVG would struggle at 20+ animated agents.
**Alternatives**: (a) Three.js — too heavy for 2D. (b) Canvas 2D API — no sprite batching, poor perf at scale. (c) Phaser — game engine overhead we don't need. (d) React-Pixi — considered, may adopt if integration is smooth.

## ADR-003: WebSocket for Event Transport
**Date**: 2026-04-08
**Decision**: All communication between the Ruflo plugin and the UI uses WebSocket (ws library).
**Reasoning**: Agent events can fire in bursts (10+ agents spawning in <1 second). Polling would miss events or add unacceptable latency. Server-Sent Events are one-directional (we need bidirectional for sending commands back to agents). WebSocket gives us sub-50ms delivery with bidirectional capability.
**Alternatives**: (a) HTTP polling — too slow. (b) SSE — one-directional only. (c) gRPC — overkill, adds protobuf complexity.

## ADR-004: Zustand for Frontend State
**Date**: 2026-04-08
**Decision**: Use Zustand for React state management, not Redux or MobX.
**Reasoning**: Our state is simple — a list of agents, their states, tasks, and messages. Zustand has minimal boilerplate, supports subscriptions (critical for Pixi.js canvas reading state without React re-renders), and is ~1KB. Redux's action/reducer ceremony adds no value at our scale.
**Alternatives**: (a) Redux Toolkit — too much boilerplate. (b) MobX — proxy-based reactivity conflicts with Pixi.js manual reads. (c) Jotai — atom model doesn't fit our centralized state well.

## ADR-005: Monorepo with npm Workspaces
**Date**: 2026-04-08
**Decision**: Structure as a monorepo with 4 packages: shared, ruflo-plugin, event-bridge, studio-ui.
**Reasoning**: The packages have clear boundaries and shared types. A monorepo keeps them in sync without publishing to npm during development. npm workspaces is sufficient — we don't need Turborepo/Nx complexity for 4 packages.
**Alternatives**: (a) Single package — types get messy, no clear boundaries. (b) Separate repos — painful to keep types in sync. (c) Turborepo — unnecessary overhead for our scale.

---

## ADR-006: Separate Repository, Not a Ruflo Subdirectory
**Date**: 2026-04-09
**Decision**: Agent Studio lives in its own GitHub repo (github.com/aaryansinha16/agent-studio), completely separate from the Ruflo clone/fork.
**Reasoning**: Ruflo has its own CLAUDE.md (1050 lines, 37KB) and AGENTS.md (Codex integration) that are designed for developing Ruflo itself. If we put our project inside Ruflo's directory tree, Claude Code would load Ruflo's context files and conflate the two projects. A separate repo means: (a) our CLAUDE.md is the only context loaded, (b) git history is clean and portfolio-ready, (c) no risk of accidentally editing Ruflo source, (d) Ruflo is consumed purely as an npm dependency (`@claude-flow/cli`).
**Alternatives**: (a) Subdirectory inside Ruflo fork (`ruflo/contrib/agent-studio/`) — rejected because Claude Code's CLAUDE.md resolution walks up the directory tree and would load Ruflo's context. (b) Git submodule — adds complexity, still couples the repos.

---

*Add new decisions above this line. Keep them numbered sequentially.*

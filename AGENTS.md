# Agent Studio — AGENTS.md

## Purpose

This file defines patterns for AI coding agents working on this project. It ensures consistent behavior across sessions regardless of which AI model or tool is used.

## Before Any Task

1. Read `CLAUDE.md` for architecture context
2. Read `DECISIONS.md` for recent architectural decisions
3. Check the relevant package's `src/` directory structure before creating new files
4. If modifying an existing file, read it fully first — do not assume contents

## Task Patterns

### When adding a new event type:
1. Define the type in `packages/shared/src/types.ts`
2. Add the Zod schema in the same file
3. Add the event name constant in `packages/shared/src/constants.ts`
4. Add the hook listener in `packages/ruflo-plugin/src/index.ts`
5. Add the handler in `packages/event-bridge/src/state-store.ts`
6. Add the UI consumer in `packages/studio-ui/src/hooks/useAgentState.ts`
7. Always work top-down: types → plugin → bridge → UI

### When adding a new visual element to the canvas:
1. Create the Pixi.js class in `packages/studio-ui/src/canvas/`
2. Animation states must map to the state machine in CLAUDE.md
3. All sprites must be pooled — never create/destroy sprites per frame
4. Test at 20 agents simultaneously before considering it done
5. Use Pixi.js ticker for animation, not requestAnimationFrame directly

### When adding a new UI panel:
1. Create in `packages/studio-ui/src/panels/`
2. Data comes exclusively from Zustand store — no direct WebSocket access in components
3. Panels must handle "no data yet" state gracefully (loading skeleton, not blank)
4. All panels must be resizable and collapsible
5. Use CSS modules or Tailwind — no inline styles except dynamic positioning

### When modifying the event bridge:
1. All WebSocket messages must be validated with Zod on both send and receive
2. Reconnection logic must be automatic with exponential backoff
3. Missed events during disconnection must be recoverable from state store
4. Never broadcast raw Ruflo hook data — always transform to our typed events first

### When writing tests:
1. Unit tests go in `__tests__/` adjacent to the source file
2. Use `vitest` — not jest
3. Mock WebSocket connections with `ws` mock
4. Canvas tests use Pixi.js headless renderer
5. Minimum coverage: 80% for shared/types, 70% for bridge, 60% for UI

## Pre-Commit Checklist

Before marking any task as done:
- [ ] TypeScript compiles with zero errors (`tsc --noEmit`)
- [ ] No `any` types introduced
- [ ] All new functions have JSDoc comments
- [ ] Zod schemas updated if types changed
- [ ] No console.log left (use structured logger)
- [ ] Checked that Ruflo upstream files are untouched
- [ ] Ran relevant tests

## Error Handling Pattern

```typescript
// DO THIS — structured error with context
import { StudioError } from '@agent-studio/shared'

try {
  await bridge.connect()
} catch (err) {
  throw new StudioError('BRIDGE_CONNECTION_FAILED', {
    cause: err,
    context: { host, port, attempt: retryCount }
  })
}

// NOT THIS
try {
  await bridge.connect()
} catch (err) {
  console.log('connection failed')
}
```

## Naming Conventions

- **Events**: `agent:spawned`, `agent:state-changed`, `task:started`, `task:completed`
- **Store slices**: `useAgentStore`, `useTaskStore`, `useSessionStore`
- **Canvas classes**: PascalCase — `AgentAvatar`, `WorkspaceGrid`, `TaskBubble`
- **Hooks**: `useAgentState()`, `useWebSocket()`, `useTaskStream()`
- **Files**: kebab-case — `agent-avatar.ts`, `state-store.ts`, `task-board.tsx`

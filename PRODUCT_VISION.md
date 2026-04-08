# Agent Studio — Product Vision

## One-Liner

AI agents that live on your desktop — watch them build your app while you work.

## Problem

Multi-agent AI orchestration (Ruflo, CrewAI, AutoGen, etc.) is a black box. Developers spawn agents, assign tasks, and stare at terminal logs hoping things work. When something goes wrong — an agent is stuck, two agents conflict, a task fails silently — the developer has no spatial awareness of what's happening. They grep through logs, check status commands, and mentally reconstruct the state of 10+ agents from text output.

This is like managing a software team by reading their git commits in a terminal, with no Jira board, no standup, no Slack, no way to see who's blocked or who's idle.

## Solution

Agent Studio is a hybrid desktop app with two modes:

**Desktop Overlay (the hook)**: Agent avatars roam freely on your macOS desktop — walking across the dock, sitting on the menubar, coding at tiny desks that appear on your screen. You see your AI agents *existing* alongside your other work. This is what makes people say "what the hell is that?" and share screenshots.

**Studio Window (the utility)**: A full dashboard with an isometric workspace, task board, terminal views, and agent inspector. Click any desktop agent to open their detail view. Drag tasks between agents. Monitor costs, replay sessions, detect bottlenecks. This is what makes people keep using it daily.

## Target Users

1. **Primary**: Developers using Ruflo/Claude Code for multi-agent development who want visibility into what their swarm is doing
2. **Secondary**: Teams evaluating multi-agent orchestration who want a demo-friendly visual interface
3. **Tertiary**: AI/ML engineers studying agent behavior patterns who want session replay and analytics

## Core Experiences

### 1. The Desktop Magic (First Impression)
You launch Agent Studio. You say "Build me a REST API with auth." Six tiny animated characters appear on your desktop — walking out from behind your dock. The Architect climbs onto your menubar and starts sketching on a tiny whiteboard. Two Coders set up tiny desks on opposite sides of your screen and start typing. A Tester paces near the dock. You continue working in VS Code while agents visibly work around you. A speech bubble pops up: "JWT middleware ready, passing to integration." You glance at the agents — everyone's busy, no one's blocked. You go back to your own work.

### 2. The Overview (Glance Value)
Open the Studio Window and see: 8 agents in an isometric office. 3 are actively coding (typing animation, green status). 2 are testing (pacing animation, yellow). 1 is blocked (head down, red warning). 2 are idle (sitting, grey). You know the state of your entire swarm in 2 seconds without reading a single log line.

### 2. The Deep Dive (Click to Inspect)
Click the blocked agent. A panel slides open showing: current task description, terminal output stream, the file it's working on, the error message, and which other agent it's waiting on. You type a message: "Try using the cached version instead." The instruction is injected into the agent's context via Ruflo's task system.

### 3. The Collaboration Moment (Agent-to-Agent)
Two agents need to agree on an API contract. You watch Agent A walk over to Agent B's desk. A speech bubble appears showing their negotiation: "I need the /users endpoint to return pagination metadata." "Agreed, I'll add totalCount and hasMore fields." The bubble is clickable — full conversation visible. The API contract is settled, both agents return to their desks and continue.

### 4. The Replay (Post-Session Analysis)
A swarm finished overnight. You open Agent Studio, load the session, and scrub through the timeline. You see when agents spawned, when the architect finished planning (3 minutes in), when the first coding agents started (minute 5), when a merge conflict caused 2 agents to block (minute 22), and when the coordinator resolved it (minute 24). You export the session as a shareable visualization.

## Phased Roadmap

### Phase 1: Foundation (Weeks 1-3)
**Goal**: Data pipeline working end-to-end — Ruflo events appear in a React UI in real-time.

- [ ] Ruflo plugin that hooks into all lifecycle events
- [ ] WebSocket event bridge server
- [ ] State store (in-memory + SQLite)
- [ ] Basic React UI showing agents as colored circles with status text
- [ ] Agent list with state, task, and uptime
- [ ] Real-time event log panel

**Milestone**: Run `npx ruflo swarm init`, see agents appear in UI, assign a task, watch status update live.

### Phase 2: Studio Window Visual Workspace (Weeks 4-6)
**Goal**: Isometric workspace with animated agent avatars inside the Studio Window.

- [ ] Pixi.js isometric grid/office environment
- [ ] Agent avatar sprites with state-driven animations (idle, coding, testing, blocked, error)
- [ ] Desk/workstation assignment — agents sit at assigned desks
- [ ] Walking animations for agent-to-agent communication
- [ ] Speech bubbles showing inter-agent messages
- [ ] Smooth camera controls (pan, zoom)
- [ ] Agent selection with highlight ring
- [ ] Click-to-inspect panel integration

**Milestone**: Animated agents in an isometric office, state visible from body language. Screenshot-worthy.

### Phase 3: Desktop Overlay — Agents on Your Desktop (Weeks 7-9)
**Goal**: Agent avatars escape the window and roam your macOS desktop.

- [ ] Electron shell with two windows: Studio (normal) + Overlay (transparent fullscreen)
- [ ] Overlay window: transparent, frameless, alwaysOnTop, click-through
- [ ] Agent sprites rendered on transparent Pixi.js canvas (same animation system as Studio)
- [ ] Desktop roaming AI: agents walk to random positions, settle at "work spots", move between locations
- [ ] Dock detection: query macOS dock position/size, agents can "sit" on the dock
- [ ] Menubar awareness: agents can climb to the top of the screen
- [ ] Selective click capture: mouse passes through transparent areas, but clicking an agent captures the event
- [ ] Click desktop agent → opens Studio Window inspector for that agent
- [ ] Right-click desktop agent → context menu (kill, reassign, inspect, send to Studio)
- [ ] "Release to Desktop" toggle in Studio Window — agents animate leaving the isometric office and appearing on the desktop
- [ ] System tray icon with agent count badge and quick controls
- [ ] IPC bridge: both windows share the same Zustand state via Electron IPC

**Milestone**: Agents visibly walking around the macOS desktop while building code. The viral demo moment.

### Phase 4: Deep Interaction + Intelligence (Weeks 10-13)
**Goal**: Bidirectional control and analytics.

- [ ] Click agent (desktop or studio) → send instruction via Ruflo task system
- [ ] Drag-and-drop task reassignment between agents
- [ ] Kill/restart/spawn agent from UI
- [ ] Task board panel (Kanban-style: backlog → in progress → done)
- [ ] Terminal view per agent (live stdout stream)
- [ ] File tree view per agent (files touched/created)
- [ ] Session recording and full replay with timeline scrubbing
- [ ] Cost tracking: token usage per agent, model tier used, estimated $$
- [ ] Automatic bottleneck highlighting (agent blocked for >30s gets desktop notification)
- [ ] Desktop notification bubbles: agents show speech bubbles on your desktop for important events

**Milestone**: A developer can run an entire Ruflo session from Agent Studio without touching the terminal.

### Phase 5: Polish + Ship (Weeks 14-16)
**Goal**: Shippable product.

- [ ] macOS dock integration (badge count, progress indicator)
- [ ] Auto-start event bridge when Ruflo daemon starts
- [ ] Onboarding flow for first-time setup with Ruflo
- [ ] Landing page for devovia.com/agent-studio
- [ ] Demo video showing desktop overlay in action
- [ ] Open source release with contribution guide
- [ ] Publish to Homebrew cask for easy installation

## Differentiation

| Feature | Terminal (Ruflo) | Agent Studio (Window) | Agent Studio (Desktop) |
|---|---|---|---|
| Agent state | `agent list --json` | Glance at isometric workspace | See agents on your desktop |
| Task progress | grep logs | Visual progress on desk | Agent body language while you work |
| Communication | log files | Walking + speech bubbles | Bubbles on your actual desktop |
| Blocked agents | status check | Red glow in workspace | Agent sits down on your dock, head down |
| Intervention | CLI command | Click and type | Right-click desktop agent |
| Post-analysis | parse logs | Session replay | — (Studio Window feature) |

## Non-Goals (for now)

- We are NOT building our own orchestration engine — Ruflo handles that
- We are NOT supporting other orchestration frameworks (CrewAI, AutoGen) in v1
- We are NOT building a code editor — agents write code via Ruflo, we just show it
- We are NOT building mobile — desktop only in v1
- We are NOT doing voice/audio interaction with agents in v1

## Success Metrics

- **Portfolio impact**: Screenshot/video-worthy in 4 weeks (Phase 2 complete)
- **Community traction**: 100+ GitHub stars within first month of release
- **Developer adoption**: 50+ weekly active users within 3 months
- **Ruflo ecosystem**: Listed as official community tool in Ruflo docs

## Brand & Naming

- **Product name**: Agent Studio
- **Tagline**: "See your AI agents work"
- **Domain**: devovia.com/agent-studio (sub-path of your existing domain)
- **Repo**: github.com/aaryansinha16/agent-studio (standalone repo, NOT inside Ruflo fork)
- **Color palette**: Dark theme, cyan accent (#4ECDC4), matching Ruflo's terminal aesthetic
- **Font**: JetBrains Mono for code/data, instrument-sans for UI labels
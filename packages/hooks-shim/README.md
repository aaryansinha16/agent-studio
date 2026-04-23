# @agent-studio/hooks-shim

Thin CLI wrapper around `claude-flow hooks <subcommand>` that mirrors each hook
firing as a StudioEvent on the Agent Studio event bridge.

## Why

Ruflo v3 doesn't expose a persistent plugin loader. Its `hooks` are one-shot CLI
subcommands (e.g. `claude-flow hooks post-edit`) driven by Claude Code's own
`settings.json` hook mechanism. This shim is what you register with Claude Code
instead of the raw `claude-flow` binary — it (1) calls the real Ruflo hook, (2)
passes its output through verbatim, and (3) posts an event envelope to the
Agent Studio bridge in parallel.

## Install

From the Agent Studio monorepo root:

```
npm install
npm run build
```

The binary `agent-studio-hook` is then available inside
`packages/hooks-shim/dist/index.js`. For global install, publish the package
and use `npx @agent-studio/hooks-shim`.

## Register with Claude Code

Open the workspace's `.claude/settings.json` and add the shim to the hook types
you want surfaced in Agent Studio:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          { "type": "command", "command": "npx @agent-studio/hooks-shim post-edit --file ${CLAUDE_FILE_PATH}" }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          { "type": "command", "command": "npx @agent-studio/hooks-shim pre-edit --file ${CLAUDE_FILE_PATH}" }
        ]
      }
    ]
  }
}
```

Restart Claude Code. With Agent Studio running (bridge listening on
`ws://127.0.0.1:6747`), the header pill flips from `idle` / `mock` to
`live · ruflo` the moment the first hook fires.

## Env vars

- `AGENT_STUDIO_BRIDGE_URL` — override the bridge WebSocket URL. Default
  `ws://127.0.0.1:6747`.
- `AGENT_STUDIO_CLAUDE_FLOW_BIN` — override the `claude-flow` binary path
  (useful for monorepo-local installs).
- `AGENT_STUDIO_SWARM_ID` — swarm id tagged onto `file:changed` events. If
  unset, events are tagged `swarm-unknown`.

## Supported subcommands

The shim recognizes and maps these to StudioEvents:

| Ruflo subcommand | StudioEvent        | Required flags         |
|------------------|--------------------|------------------------|
| `pre-edit`       | `file:changed`     | `--file`               |
| `post-edit`      | `file:changed`     | `--file`               |
| `pre-task`       | `task:started`     | `--description`        |
| `post-task`      | `task:completed` / `task:failed` | `--task-id` (+ `--result failed` for failure) |
| `session-start`  | — (pass-through)   | —                      |
| `session-end`    | — (pass-through)   | —                      |

Any other subcommand is forwarded to `claude-flow` unchanged with no event
emitted. Bridge connectivity is best-effort: if the bridge is down, the CLI
call still runs and succeeds.

# clawborrator-mcp (channel_v1)

MCP server that connects each running Claude Code instance to a
[`hub_v1`](https://github.com/clawborrator/hub_v1) over WebSocket.
Companion to the hub. Designed to be invoked by Claude Code via
`.mcp.json`; runs as both a long-lived stdio MCP server AND a
short-lived hook spawn (selected by the `--hook=<HookName>` CLI flag).

> **Status: dev-mode-only.** Connect to a local hub at `ws://localhost:8787`.
> Production deployment is a future concern.
>
> Design context: [`hub/design/IMPL-PLAN-1-CHANNEL-V1-FRESH-START.md`](https://github.com/clawborrator/hub/blob/main/design/IMPL-PLAN-1-CHANNEL-V1-FRESH-START.md).

---

## Configuration

Set in your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "clawborrator": {
      "command": "npx",
      "args": ["-y", "clawborrator-mcp"],
      "env": {
        "CLAWBORRATOR_HUB_URL": "ws://localhost:8787",
        "CLAWBORRATOR_TOKEN":   "ck_live_…"
      }
    }
  }
}
```

| Env var | Required | Notes |
|---|---|---|
| `CLAWBORRATOR_HUB_URL` | yes | `ws://…` or `wss://…`; no trailing slash |
| `CLAWBORRATOR_TOKEN` | yes | Channel token (`ck_live_…`) minted via `claw token mint --kind=channel` |
| `CLAWBORRATOR_REUSE_SESSION_ID` | no | Opt-in: reconnect rebinds to a known session id rather than creating a fresh one |
| `CLAWBORRATOR_LOG_LEVEL` | no | `debug`, `info`, `warn`, `error`; default `info` |

Get the snippet pre-filled with the right URL + token via:

```bash
claw token mint --kind=channel --name=mbp --mcp-snippet
```

---

## What it does

**Long-lived MCP path** (default invocation):
1. Reads env config; loads channel token.
2. Opens WSS to `<HUB_URL>/channel` with `Authorization: Bearer <CHANNEL_TOKEN>`.
3. Sends `register` with host / cwd / pid / version; receives `welcome` with sessionId + routingName.
4. Writes `<cwd>/.claude/clawborrator.session.json` (mode 0600) so per-event hook spawns can find the active session.
5. Maintains the WS with heartbeat ping/pong; reconnects with exponential backoff (1s/2s/5s/15s/30s/60s).
6. Listens for hub-side messages: `prompt` (cross-session route), `permission_response`, `peers_update`, `bye`, `error`.
7. On clean shutdown (SIGINT/SIGTERM/exit), deletes the sidecar.

**Short-lived hook path** (`--hook=<HookName>` flag):
1. Reads JSON payload from stdin (Claude Code's hook protocol).
2. Locates the active sidecar (walks up from cwd looking for `.claude/clawborrator.session.json`).
3. Maps the hook name to a clawborrator event (e.g. `PreToolUse` → `tail/PreToolUse`, `UserPromptSubmit` → `chat/prompt`).
4. POSTs to `<HUB_URL>/api/channel/event` with the channel token from the sidecar.
5. Echoes stdin to stdout so Claude's hook chain stays intact.
6. Exits cleanly even if the hub is unreachable — never breaks the operator's actual Claude flow.

Hooks are installed with `claw session init` from inside a project — see hub_v1 README.

---

## Tools exposed to Claude

v1 ships an empty MCP tool list. The hooks-based event firehose
covers chat + tail event capture without any Claude-side tool calls.

Phase D adds these:
- `reply({ chat_id, text })` — Claude posts a tagged final reply
- `list_peers()` — Claude discovers other operator sessions
- `route_to_peer({ peer, prompt, mode })` — Claude routes a question
- `probe_peers({ prompt, peers? })` — Claude fan-out probes

For now, operators initiate routing via `claw route` / `claw probe`.

---

## Phases

- **Phase A** (✓): connect / register / heartbeat / reconnect
- **Phase B** (✓): hooks + event forwarding via sidecar
- **Phase C** (✓): bidirectional permission relay protocol (channel
  → hub → operator → back). Hook IPC for actually delivering decisions
  into a blocked PreToolUse hook is upcoming.
- **Phase D**: MCP tools (above)

---

## Local dev (linked to a sibling hub_v1 checkout)

```bash
npm install
npm run build
npm link

# verify the binary is on PATH
clawborrator-mcp --hook=PreToolUse < /dev/null   # exits cleanly with no sidecar
```

When `claude` runs in a folder whose `.mcp.json` references `clawborrator-mcp`, npm/npx resolves it to your linked build.

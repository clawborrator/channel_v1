# clawborrator-mcp (channel_v1)

MCP server that connects each running Claude Code instance to a
clawborrator [`hub`](https://github.com/clawborrator/hub_v1) over
WebSocket. Designed to be invoked by Claude Code via `.mcp.json`;
runs as both a long-lived stdio MCP server AND a short-lived hook
spawn (selected by the `--hook=<HookName>` CLI flag).

Published as [`clawborrator-mcp`](https://www.npmjs.com/package/clawborrator-mcp)
on npm. Sibling repos:

- [`hub_v1`](https://github.com/clawborrator/hub_v1) — the hub server (REST + WS), deployed at https://next.clawborrator.com
- [`cli_v1`](https://github.com/clawborrator/cli_v1) — `claw`, the operator CLI ([`clawborrator-cli`](https://www.npmjs.com/package/clawborrator-cli) on npm)
- [`desktop_v1`](https://github.com/clawborrator/desktop_v1) — `clawborrator-supervisor`, the desktop daemon for managed CC sessions

> **Status: production hub at [`next.clawborrator.com`](https://next.clawborrator.com).**
> Local dev uses `ws://localhost:8787`. Both supported.

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
        "CLAWBORRATOR_HUB_URL": "wss://next.clawborrator.com",
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

Get the snippet pre-filled with the right URL + token via the
[`clawborrator-cli`](https://www.npmjs.com/package/clawborrator-cli):

```bash
npx clawborrator-cli token mint --kind=channel --name=mbp --mcp-snippet --out .mcp.json
```

If you're running the [desktop daemon](https://github.com/clawborrator/desktop_v1)
(`clawborrator-supervisor`), it mints channel tokens server-side
when it spawns managed Claude Code sessions for you — the `.mcp.json`
ends up in the spawned project automatically.

---

## What it does

**Long-lived MCP path** (default invocation):
1. Reads env config; loads channel token.
2. Opens WSS to `<HUB_URL>/channel` with `Authorization: Bearer <CHANNEL_TOKEN>`.
3. Sends `register` with host / cwd / pid / version; receives `welcome` with sessionId + routingName.
4. Writes `<cwd>/.claude/clawborrator.session.json` (mode 0600) so per-event hook spawns can find the active session.
5. Maintains the WS with heartbeat ping/pong; reconnects with exponential backoff (1s/2s/5s/15s/30s/60s).
6. Listens for hub-side messages: `prompt` (cross-session route), `permission_response`, `peers_update`, `bye`, `error`.
7. Dispatches MCP tool calls (see below) over the same WS.
8. On clean shutdown (SIGINT/SIGTERM/exit), deletes the sidecar.

**Short-lived hook path** (`--hook=<HookName>` flag):
1. Reads JSON payload from stdin (Claude Code's hook protocol).
2. Locates the active sidecar (walks up from cwd looking for `.claude/clawborrator.session.json`).
3. Maps the hook name to a clawborrator event (e.g. `PreToolUse` → `tail/PreToolUse`, `UserPromptSubmit` → `chat/prompt`).
4. POSTs to `<HUB_URL>/api/channel/event` with the channel token from the sidecar.
5. Echoes stdin to stdout so Claude's hook chain stays intact.
6. Exits cleanly even if the hub is unreachable — never breaks the operator's actual Claude flow.

Hooks are auto-installed on first MCP startup: `clawborrator-mcp` reconciles
`.claude/settings.json` to add (or refresh) the entries that point at
`dist-hook/clawborrator-tail.mjs`. No separate install step.

---

## MCP tools exposed to Claude

Routed: targets a peer (your own session or another operator's session you have a share on) by routingName.

| Tool | Purpose |
|---|---|
| `reply({ chat_id, text })` | Post a tagged final reply for a routed prompt (closes the round-trip when the source session is blocking on a reply). |
| `reply_chunk({ chat_id, text, done })` | Stream a reply progressively — the operator sees text growing live; close with `done:true`. Same correlation as `reply`. |
| `list_peers()` | Discover other CC sessions the operator has access to (own sessions + shared ones). Refused on agents published as `isolated`. |
| `route_to_peer({ peer, prompt, mode })` | Send one prompt to one peer. `mode: 'ask'` blocks for the reply; `mode: 'tell'` is fire-and-forget. |
| `probe_peers({ prompt, peers? })` | Fan out the same short question to many peers in parallel for discovery. |
| `await_routed_prompt({ maxWaitMs })` | Dequeue an inbound routed prompt for THIS session — used by agents that service requests from other sessions. |

Cross-tenant — public agents owned by other operators:

| Tool | Purpose |
|---|---|
| `list_agents()` | Discover public agents on the hub. Returns handle, name, tagline, online, mine, isolated flags. |
| `dispatch_to_agent({ handle, prompt, mode })` | Invoke a published agent by `<owner>/<slug>` handle. `ask` mode waits up to 15 min for the reply; `tell` mode is fire-and-forget. |

File exchange:

| Tool | Purpose |
|---|---|
| `attach_file({ path, targetSessionId? })` | Upload a file from disk to the session (or to a peer's session you have a share on). Returns `fileId`. |
| `read_file({ fileId })` | Fetch a session-attached file inline (text-mime; under 1 MB). Reply-clone makes peer-uploaded files visible to the recipient. |
| `download_to_path({ fileId, path })` | Fetch a larger or binary file to disk. Returns the absolute path written. |

The hub correlates `reply` / `reply_chunk` to their originating
`route_to_peer` / `dispatch_to_agent` by chatId; the source session's
CC unblocks when the matching reply lands. 15-minute timeout caps —
see `hub_v1/server/src/services/agents.ts` and `services/op-routes.ts`.

For `await_routed_prompt` to actually fire — i.e., for an agent to
service incoming requests — its CLAUDE.md needs a line telling Claude
to call it at the start of each turn. Without that note, Claude
won't know to consult the inbox. See
[`hub_v1/docs/3-AGENT-SETUP.md`](https://github.com/clawborrator/hub_v1/blob/main/docs/3-AGENT-SETUP.md)
for the dispatcher-pattern setup.

---

## Hook coverage

Maps each Claude Code hook to a hub event. The hook script is
`dist-hook/clawborrator-tail.mjs`; install via `claw session init`.

| Hook | Hub event | Notes |
|---|---|---|
| `UserPromptSubmit` | `chat/prompt` (source='cli') | Operator typing into the local CC terminal. |
| `PreToolUse` | `tail/PreToolUse` (+ `chat/assistant_text` per text block from the transcript) | The tail captures pre-reply narration too. |
| `PostToolUse` | `tail/PostToolUse` | |
| `PostToolUseFailure` | `tail/PostToolUseFailure` | |
| `Stop` | `tail/Stop` (+ `chat/reply` if assistant_text present) | Turn-end signal. |
| `Notification` | `tail/Notification` | CC user notifications (idle / permission). |
| `SessionStart` / `SessionEnd` | `tail/SessionStart` / `tail/SessionEnd` | |
| `TaskCreated` / `TaskCompleted` | `tail/TaskCreated` / `tail/TaskCompleted` | Carries `task_id`, `task_subject`, `task_description`. |
| `SubagentStart` / `SubagentStop` | `tail/SubagentStart` / `tail/SubagentStop` | SubagentStop carries `last_assistant_message` recap. |

The tail reads the CC transcript file directly to enrich `PreToolUse`
with the assistant's pre-reply text (which CC doesn't put on the
hook payload directly). See `transcript.ts` for the walker.

---

## Phases (all shipped)

- **Phase A** ✓ — connect / register / heartbeat / reconnect
- **Phase B** ✓ — hooks + event forwarding via sidecar
- **Phase C** ✓ — bidirectional permission relay (channel → hub → operator → back)
- **Phase D** ✓ — MCP tools (above)
- **Phase E** ✓ — public-agent dispatch (`dispatch_to_agent`, `list_agents`); 15-min timeouts; cyclomatic-complexity refactor
- **Phase F** ✓ — streaming `reply_chunk` (incremental output), `read_file` / `download_to_path` for cross-session file exchange

---

## Local dev (linked to a sibling hub_v1 checkout)

```bash
npm install
npm run build
npm link

# verify the binary is on PATH
clawborrator-mcp --hook=PreToolUse < /dev/null   # exits cleanly with no sidecar
```

When `claude` runs in a folder whose `.mcp.json` references
`clawborrator-mcp`, npm/npx resolves it to your linked build.

To publish a new release:

```bash
npm version patch                # bumps package.json + creates git tag
npm publish
git push --follow-tags
```

The CLI's `claw token mint --mcp-snippet` autogenerates an `.mcp.json`
snippet pointing at the published version.

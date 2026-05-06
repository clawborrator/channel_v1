# clawborrator-mcp (channel_v1)

MCP server that connects a running Claude Code instance to a `hub_v1`
over WebSocket. Companion to [hub_v1](../hub_v1).

See `hub/design/IMPL-PLAN-1-CHANNEL-V1-FRESH-START.md` for the full
design and protocol.

## Configuration

Two environment variables (set in your project's `.mcp.json`):

| Var | Required | Notes |
|---|---|---|
| `CLAWBORRATOR_HUB_URL` | yes | `ws://localhost:8787` for local dev; `wss://…` in production |
| `CLAWBORRATOR_TOKEN` | yes | Channel token (`ck_live_…`) minted via `claw token mint` |
| `CLAWBORRATOR_REUSE_SESSION_ID` | optional | If set, channel reconnects rebind to this session id rather than creating a fresh one |

Example `.mcp.json`:

```json
{
  "mcpServers": {
    "clawborrator": {
      "command": "npx",
      "args": ["-y", "clawborrator-mcp"],
      "env": {
        "CLAWBORRATOR_HUB_URL": "ws://localhost:8787",
        "CLAWBORRATOR_TOKEN":   "ck_live_xxx"
      }
    }
  }
}
```

## Phases

- **Phase A (now)**: connect, register, heartbeat, reconnect with backoff.
- **Phase B**: hooks installed; chat + tail events forwarded.
- **Phase C**: bidirectional permission relay.
- **Phase D**: routing tools (`reply`, `list_peers`, `route_to_peer`, `probe_peers`).

// MCP entrypoint. Phase A: open the WS to hub, register, log every
// inbound message to stderr. Subsequent phases will:
//   - install hooks (Phase B) that turn into chat_event/tail_event sends
//   - wire permission relay (Phase C)
//   - register MCP tools (reply, list_peers, route_to_peer, probe_peers)
//     for Claude to call (Phase D)
//
// In Phase A we still need the MCP transport open so Claude Code's
// MCP-discovery handshake succeeds; otherwise the user sees "MCP
// server failed to start." We register a no-op tool list — Claude
// gets an empty tools/list response and the WS work proceeds in the
// background.

import { hostname } from 'node:os';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config.js';
import { ChannelClient } from './ws-client.js';
import { log } from './log.js';
import { runHook } from './hook.js';
import { writeSidecar, deleteSidecar } from './sidecar.js';

// Dispatch on --hook=<HookName> first; that's the short-lived spawn
// path Claude Code's hook system uses. Without it, fall through to
// the long-lived MCP stdio server.
const hookFlag = process.argv.find((a) => a.startsWith('--hook='));
if (hookFlag) {
  const name = hookFlag.slice('--hook='.length);
  runHook(name).catch((err) => {
    log.error('hook fatal', { error: String(err) });
    process.exit(0);   // never fail the operator's actual Claude flow
  });
} else {
  main().catch((err) => {
    log.error('fatal', { error: String(err), stack: err?.stack });
    process.exit(1);
  });
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    log.error('config invalid', { error: String(e) });
    process.exit(2);
  }

  log.info('clawborrator-mcp starting', { hubUrl: config.hubUrl });

  const cwd = process.cwd();
  const host = hostname();

  // Open the channel-side WS to hub. Phase A: just connect + register
  // + heartbeat + reconnect. Phase B-D will add handlers.
  const client = new ChannelClient(config, {
    onWelcome: (m) => {
      log.info('session ready', {
        sessionId:    m.sessionId,
        routingName:  m.routingName,
        channelToken: m.channelTokenName,
      });
      // Sidecar — Phase B hooks read this. The hub URL on the sidecar
      // is the HTTP form (hooks POST over HTTPS, not WS).
      const httpHubUrl = config.hubUrl.replace(/^ws/i, 'http');
      writeSidecar({
        sessionId:    m.sessionId,
        routingName:  m.routingName,
        hubUrl:       httpHubUrl,
        channelToken: config.token,
        host,
        cwd,
        writtenAt:    new Date().toISOString(),
      });
    },
    onError: (m) => {
      log.error('hub rejected', { code: m.code, message: m.message });
    },
  });
  client.connect();

  // MCP stdio transport. Phase A registers an empty tool list so
  // Claude Code's MCP handshake completes without errors. Tools land
  // in Phase D.
  const server = new Server(
    {
      name:    'clawborrator',
      version: '0.0.1',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [],   // Phase D: list_peers, route_to_peer, probe_peers, reply
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    return {
      isError: true,
      content: [{
        type: 'text',
        text: `clawborrator-mcp Phase A: tool '${req.params.name}' not implemented yet`,
      }],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info('mcp transport connected');

  // Clean shutdown on common signals so the WS goes away cleanly +
  // sidecar gets removed so a stale file doesn't mislead future hooks.
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      log.info('shutting down', { signal: sig });
      client.stop();
      deleteSidecar(cwd);
      transport.close().catch(() => {});
      setTimeout(() => process.exit(0), 200);
    });
  }
  // Last-ditch sidecar cleanup. Even on uncaught exceptions, we'd
  // rather not leave a stale file pointing at a dead WS.
  process.on('exit', () => deleteSidecar(cwd));
}

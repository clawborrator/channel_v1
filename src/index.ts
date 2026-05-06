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
import { TOOL_DEFINITIONS, callTool } from './tools/index.js';

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

  // Open the channel-side WS to hub.
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
    onPrompt: (m) => {
      // Phase 4 — operator routed a prompt at this session. Real
      // injection into Claude Code (so Claude actually sees the
      // prompt) requires Phase D MCP tool wiring; for now we log
      // at info level so operators running clawborrator-mcp directly
      // can see routes land.
      log.info('prompt received', { chatId: m.chatId, text: m.text });
    },
    onPermissionResponse: (m) => {
      // Phase C: the operator (or auto-expire) resolved a permission.
      // We surface it in the log so operators running with
      // CLAWBORRATOR_LOG_LEVEL=info can see decisions land. Real
      // hook integration (where this decision routes back to a
      // pending hook spawn) is a follow-on once we wire IPC between
      // the long-lived MCP and the short-lived hook process.
      log.info('permission resolved', {
        requestId: m.requestId,
        decision:  m.decision,
        message:   m.message ?? null,
      });
    },
    onError: (m) => {
      log.error('hub rejected', { code: m.code, message: m.message });
    },
  });
  client.connect();

  // MCP stdio transport. Phase D ships the four routing tools.
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

  // Track our session id so tools (and future use) can reference it.
  // Set by the onWelcome handler above.
  let toolCtxSessionId: string | null = null;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map((t) => ({
      name:        t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    return await callTool({ client, sessionId: toolCtxSessionId }, req.params.name, args);
  });
  void toolCtxSessionId;

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

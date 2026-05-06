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

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config.js';
import { ChannelClient } from './ws-client.js';
import { log } from './log.js';

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    log.error('config invalid', { error: String(e) });
    process.exit(2);
  }

  log.info('clawborrator-mcp starting', { hubUrl: config.hubUrl });

  // Open the channel-side WS to hub. Phase A: just connect + register
  // + heartbeat + reconnect. Phase B-D will add handlers.
  const client = new ChannelClient(config, {
    onWelcome: (m) => {
      log.info('session ready', {
        sessionId:    m.sessionId,
        routingName:  m.routingName,
        channelToken: m.channelTokenName,
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

  // Clean shutdown on common signals so the WS goes away cleanly.
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      log.info('shutting down', { signal: sig });
      client.stop();
      transport.close().catch(() => {});
      setTimeout(() => process.exit(0), 200);
    });
  }
}

main().catch((err) => {
  log.error('fatal', { error: String(err), stack: err?.stack });
  process.exit(1);
});

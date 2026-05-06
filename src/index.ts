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
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config.js';
import { ChannelClient } from './ws-client.js';
import { log } from './log.js';
import { runHook } from './hook.js';
import { writeSidecar, deleteSidecar } from './sidecar.js';
import { TOOL_DEFINITIONS, callTool } from './tools/index.js';
import { enqueueRoutedPrompt } from './inbox.js';
import { installHooks } from './install-hooks.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Dispatch on top-level flags BEFORE booting the long-lived MCP.
//   --hook=<HookName>     short-lived hook spawn (fast path)
//   --print-hook-file     stream the bundled dist-hook/.mjs to stdout
//   (none)                long-lived stdio MCP server
const hookFlag = process.argv.find((a) => a.startsWith('--hook='));
if (hookFlag) {
  const name = hookFlag.slice('--hook='.length);
  runHook(name).catch((err) => {
    log.error('hook fatal', { error: String(err) });
    process.exit(0);   // never fail the operator's actual Claude flow
  });
} else if (process.argv.includes('--print-hook-file')) {
  // Used by `claw session init` to materialize a local copy of the
  // bundled hook entry into the project's .claude/hooks/ folder.
  // dist-hook/clawborrator-tail.mjs is built by esbuild at publish
  // time and shipped in the package's `files` allow-list.
  // Compiled __dirname is dist/, so the bundle is at ../dist-hook.
  const candidate = resolve(__dirname, '..', 'dist-hook', 'clawborrator-tail.mjs');
  if (!existsSync(candidate)) {
    process.stderr.write(`[clawborrator-mcp] bundled hook file missing at ${candidate}\n`);
    process.exit(2);
  }
  process.stdout.write(readFileSync(candidate, 'utf8'));
  process.exit(0);
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

  // Self-install / refresh project hooks in .claude/. Idempotent —
  // touches files only when the desired state diverges from disk, so
  // re-runs of `claude` cost nothing. Operators no longer need to
  // run a separate `init` command — dropping a .mcp.json with a
  // valid channel token is the only setup step.
  try {
    const r = installHooks(cwd);
    if (r.hookFileWritten || r.settingsWritten) {
      log.info('hooks installed', {
        hookFile:        r.hookFileWritten,
        settings:        r.settingsWritten,
        added:           r.added,
        refreshed:       r.refreshed,
        alreadyOk:       r.alreadyOk,
        path:            r.hookFilePath,
      });
    } else {
      log.debug('hooks already up-to-date', { added: r.added, refreshed: r.refreshed, alreadyOk: r.alreadyOk });
    }
  } catch (e: any) {
    // Don't fail boot — operator can still drive Claude; just log so
    // they see hooks aren't capturing.
    log.warn('install-hooks failed', { error: e?.message ?? String(e) });
  }

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
      // A peer session routed a prompt to us. Push to the inbox so
      // the next `await_routed_prompt` tool call can pick it up.
      log.info('prompt received', { chatId: m.chatId, text: m.text });
      enqueueRoutedPrompt({ chatId: m.chatId, text: m.text });
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

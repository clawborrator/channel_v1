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
import { z } from 'zod';
import { loadConfig } from './config.js';
import { ChannelClient } from './ws-client.js';
import { log } from './log.js';
import { runHook } from './hook.js';
import { writeSidecar, deleteSidecar } from './sidecar.js';
import { TOOL_DEFINITIONS, callTool } from './tools/index.js';
import { installHooks } from './install-hooks.js';
import { loadPersistedSessionId, savePersistedSession } from './persisted-session.js';
import { packageVersion } from './version.js';

const SOURCE_NAME = 'clawborrator';

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

  // Layer the session-id source: explicit env var > on-disk persisted
  // file > null (fresh). Persisting across restarts is what stops a
  // cold `claude` boot in the same project from minting a duplicate
  // session row with a sibling UUID under the same routing name.
  if (!config.reuseSessionId) {
    const persisted = loadPersistedSessionId(cwd);
    if (persisted) {
      log.info('reusing persisted session id', { sessionId: persisted });
      config = { ...config, reuseSessionId: persisted };
    }
  } else {
    log.info('reusing session id from env override', { sessionId: config.reuseSessionId });
  }

  // MCP stdio transport. Built BEFORE the ChannelClient so the WS
  // handlers below can call server.notification() to push channel
  // messages to Claude. We declare experimental capabilities matching
  // the CC channel feature gate (CC's `--dangerously-load-development-
  // channels server:clawborrator` flag opts into these); without
  // them CC drops `notifications/claude/channel` on the floor.
  const server = new Server(
    {
      name:    SOURCE_NAME,
      version: packageVersion(),
    },
    {
      capabilities: {
        experimental: {
          'claude/channel':            {},   // listen for notifications/claude/channel
          'claude/channel/permission': {},   // listen for permission verdicts
        },
        tools: { listChanged: true },
      },
      instructions:
        `Messages from a remote operator arrive as <channel source="${SOURCE_NAME}" chat_id="..."> tags. ` +
        `Treat them as user input from someone working with you remotely. ` +
        `When you reply, use the "reply" tool and pass back the chat_id from the inbound tag so the response routes correctly. ` +
        `Permission prompts may also be relayed for remote approval; the local terminal dialog stays open in parallel. ` +
        `\n\nCross-session routing tools (gated on the operator opting in):` +
        `\n- list_peers: see the operator's other running Claude Code sessions by routingName.` +
        `\n- route_to_peer: send one prompt to one peer; ask mode waits for their reply, tell mode is fire-and-forget.` +
        `\n- probe_peers: fan out the same short question to many peers in parallel for discovery (e.g. "do you have a User model?").` +
        `\nWhen any of these returns "cross-session routing is disabled", tell the operator to enable it in hub Settings; don't retry. ` +
        `Use them when the operator asks something that genuinely lives in a different repo, when you need information another session has in its context, or when handing off a self-contained subtask makes more sense than doing it here.` +
        `\n\nFile attachments:` +
        `\n- attach_file: upload a file from your project as a chat attachment. Use it when the operator should be able to download something you produced (logs, charts, exports). Pass a path inside your cwd; symlinks pointing outside are refused. Returns a fileId — mention it in your reply text so the operator can find the chip on their dashboard.` +
        `\n\nPeer reports: when you dispatched work to a peer with route_to_peer in tell mode, the peer's eventual reply arrives here as a normal channel notification tagged "[peer report from @<peer> via cross-session routing — informational, no reply required]". React by closing the matching task (TaskUpdate), surfacing a one-line status update to the operator, or routing a follow-up — but DO NOT call the reply tool on a peer-report chat_id; the operator already saw the report on their dashboard.`,
    },
  );

  // Track our session id so tools can reference it. Set by the
  // onWelcome handler below — closures referenced this variable
  // before, but the assignment was missing, so attach_file (and
  // any other sessionId-dependent tool) would always see null.
  let toolCtxSessionId: string | null = null;

  // Open the channel-side WS to hub.
  const client = new ChannelClient(config, {
    onWelcome: (m) => {
      log.info('session ready', {
        sessionId:    m.sessionId,
        routingName:  m.routingName,
        channelToken: m.channelTokenName,
      });
      toolCtxSessionId = m.sessionId;
      // Persist the hub-issued session id so the NEXT cold boot of
      // this MCP rebinds the same row instead of minting a sibling
      // (same routing name, different UUID — class of bug we hit
      // before this was wired up).
      savePersistedSession(cwd, {
        sessionId:   m.sessionId,
        routingName: m.routingName,
        hubUrl:      config.hubUrl,
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
      // Push the prompt to Claude as a channel notification — CC's
      // claude/channel handler wraps it in a <channel source="..."
      // chat_id="..." sender="..."> tag and surfaces it as user
      // input. No tool poll required; Claude reacts on receipt.
      log.info('prompt received', { chatId: m.chatId });
      server.notification({
        method: 'notifications/claude/channel',
        params: {
          content: m.text,
          // meta values must be strings + identifier-safe (used as XML
          // attributes on the <channel ...> tag CC builds).
          meta: { chat_id: m.chatId, sender: 'remote' },
        },
      }).catch((e) => log.warn('channel notification failed', { error: String(e) }));
    },
    onPermissionResponse: (m) => {
      // The operator (or auto-expire) resolved a permission. Push the
      // verdict to Claude via the dedicated permission channel so the
      // pending tool flow can resume without CC having to poll.
      log.info('permission resolved', {
        requestId: m.requestId,
        decision:  m.decision,
      });
      const behavior = m.decision === 'allow' ? 'allow' : 'deny';
      server.notification({
        method: 'notifications/claude/channel/permission',
        params: { request_id: m.requestId, behavior },
      }).catch((e) => log.warn('permission notification failed', { error: String(e) }));
    },
    onRouteReply: (m) => {
      // A peer this session routed a prompt to (via either route_to_peer
      // MCP tool OR via a TUI @-redirect anchored on this session) has
      // replied. Forward to Claude as a channel notification with a
      // [peer report] / [operator-route reply] prefix so it's surfaced
      // to context but Claude doesn't reflexively call `reply` on it.
      // origin distinguishes the two paths so the framing matches:
      //   - 'operator' → operator typed `@peer text` in their attach
      //                  TUI; they already saw the answer there. This
      //                  Claude is in the loop only because the route
      //                  was anchored on its session — no task to
      //                  close, no follow-up expected unless the
      //                  operator says so.
      //   - 'mcp' (or unset) → this Claude called route_to_peer; close
      //                       the matching task or route a follow-up.
      log.info('route_reply received', { routeId: m.routeId, from: m.fromName, origin: m.origin ?? 'mcp' });
      const fromTag = m.fromName ? '@' + m.fromName.replace(/^@/, '') : 'peer';
      const sender  = (m.fromName || 'peer').replace(/^@/, '').replace(/[^A-Za-z0-9_]/g, '_');
      const prefix = m.origin === 'operator'
        ? `[operator-route reply from ${fromTag} via cross-session routing — fyi, the operator dispatched this through your session and already saw the answer in their TUI; no action needed unless they ask. Don't call the reply tool on this chat_id.]`
        : `[peer report from ${fromTag} via cross-session routing — informational, no reply required] Use TaskUpdate / TaskGet to close out tracked work, or route_to_peer to follow up. Don't call the reply tool on this chat_id.`;
      server.notification({
        method: 'notifications/claude/channel',
        params: {
          content: `${prefix}\n\n${String(m.text ?? '')}`,
          meta:    { chat_id: `peer_${m.routeId}`, sender, origin: m.origin ?? 'mcp' },
        },
      }).catch((e) => log.warn('route_reply notification failed', { error: String(e) }));
    },
    onError: (m) => {
      log.error('hub rejected', { code: m.code, message: m.message });
    },
  });
  client.connect();

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map((t) => ({
      name:        t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  // Hub URL in http(s):// form — channel WS speaks ws(s)://, but
  // attach_file uses fetch + multipart which need http(s)://.
  const httpHubUrl = config.hubUrl.replace(/^ws/i, 'http');

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    return await callTool({
      client,
      sessionId:    toolCtxSessionId,
      cwd,
      httpHubUrl,
      channelToken: config.token,
    }, req.params.name, args);
  });
  void toolCtxSessionId;

  // CC-side permission relay. When CC needs the local user's
  // permission to call a tool (built-in or MCP) and the
  // claude/channel/permission experimental capability is on, CC
  // sends `notifications/claude/channel/permission_request` to
  // each registered MCP server. Handler forwards it over the
  // channel WS so attached operators see it as a permission_request
  // event they can /y or /n. The verdict comes back via the
  // already-wired onPermissionResponse → notifications/claude/
  // channel/permission path.
  const PermissionRequestSchema = z.object({
    method: z.literal('notifications/claude/channel/permission_request'),
    params: z.object({
      request_id:    z.string(),
      tool_name:     z.string(),
      description:   z.string().optional().default(''),
      input_preview: z.string().optional().default(''),
    }),
  });
  // setNotificationHandler's signature doesn't infer cleanly when the
  // schema literal is built inline (TS2589 "Type instantiation is
  // excessively deep"). Cast to bypass — runtime behavior is correct,
  // we just lose the parameter type-narrowing on the handler arg.
  (server as any).setNotificationHandler(PermissionRequestSchema, async ({ params }: { params: z.infer<typeof PermissionRequestSchema>['params'] }) => {
    log.info('permission_request from CC', { requestId: params.request_id, tool: params.tool_name });
    client.send({
      type:         'permission_request',
      requestId:    params.request_id,
      tool:         params.tool_name,
      inputPreview: params.input_preview || params.description || '',
      ts:           new Date().toISOString(),
    });
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info('mcp transport connected');

  // Clean shutdown — fired by any of:
  //   * SIGINT / SIGTERM             (POSIX, also emulated on Windows
  //                                    when CC sends a graceful kill)
  //   * stdin close ('end' / 'close') (CC's typical exit path on Windows
  //                                    where SIGTERM is unreliable —
  //                                    parent just closes our stdio)
  //
  // The big difference vs the prior implementation: we await the WS
  // close-frame flush before exiting. Without that wait, exit() ran
  // before the FIN reached the hub, so the hub had to fall back to
  // TCP-level timeout to notice — sessions stayed "online" minutes
  // after a clean CC exit. ChannelClient.stop() now returns a
  // Promise that resolves on close-frame ack (or 1.5s hard cap).
  let shuttingDown = false;
  async function shutdown(reason: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { reason });
    try { await client.stop(); } catch { /* ignore */ }
    deleteSidecar(cwd);
    try { await transport.close(); } catch { /* ignore */ }
    process.exit(0);
  }
  process.on('SIGINT',  () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // CC closes our stdin pipe on graceful exit. Both events fire
  // depending on platform / how the parent unhooks; listen for
  // either so we don't miss it.
  process.stdin.on('end',   () => void shutdown('stdin-end'));
  process.stdin.on('close', () => void shutdown('stdin-close'));
  // Last-ditch sidecar cleanup. Even on uncaught exceptions, we'd
  // rather not leave a stale file pointing at a dead WS.
  process.on('exit', () => deleteSidecar(cwd));
}

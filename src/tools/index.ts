// MCP tool registry. Each tool wraps a request-response round-trip
// against the hub via the channel WS.
//
// Tools exposed:
//   reply           — Claude posts a tagged final reply (resolves
//                     pending route_to_peer asks on the originator)
//   list_peers      — discover the operator's other online sessions
//   route_to_peer   — send a prompt to one peer; ask blocks for reply,
//                     tell is fire-and-forget
//   probe_peers     — fan-out a short question across many peers
//   attach_file     — upload a file from the local cwd as a chat
//                     attachment; returns a fileId for chat refs
//
// Inbound prompts (operator-driven or peer-routed) arrive directly to
// Claude via `notifications/claude/channel` — see index.ts onPrompt.
// No queue, no polling tool.

import { randomUUID } from 'node:crypto';
import { resolve, relative, basename } from 'node:path';
import { realpath, readFile, stat } from 'node:fs/promises';
import type { ChannelClient } from '../ws-client.js';

const ASK_TIMEOUT_MS   = 60_000;
const PROBE_TIMEOUT_MS = 30_000;
const LIST_TIMEOUT_MS  = 5_000;
const MAX_ATTACH_BYTES = 10 * 1024 * 1024;

interface CallContext {
  client: ChannelClient;
  /** Hub's chosen sessionId for this channel (filled by `welcome`). */
  sessionId: string | null;
  /** Filesystem root used by attach_file's path resolution. */
  cwd: string;
  /** http(s):// form of the hub URL — attach_file POSTs multipart here. */
  httpHubUrl: string;
  /** Channel token (ck_live_...) — Bearer auth for /api/channel/files. */
  channelToken: string;
}

export const TOOL_DEFINITIONS = [
  {
    name: 'reply',
    description: 'Post a tagged final reply to a chat. Use this whenever you finish replying to a routed prompt — pass back the chat_id you received from `await_routed_prompt`.',
    inputSchema: {
      type:        'object',
      additionalProperties: false,
      required:    ['chat_id', 'text'],
      properties: {
        chat_id: { type: 'string', description: 'The chat id of the prompt you are replying to' },
        text:    { type: 'string', description: 'Your reply text' },
      },
    },
  },
  {
    name: 'list_peers',
    description: 'List your peer Claude Code sessions reachable for routing. Use this to discover what other projects you can route questions to.',
    inputSchema: {
      type: 'object', additionalProperties: false, properties: {},
    },
  },
  {
    name: 'route_to_peer',
    description: 'Send a prompt to a peer Claude Code session. Use this when a question genuinely belongs to another project. mode=ask blocks for the reply (up to 60s); mode=tell is fire-and-forget.',
    inputSchema: {
      type:        'object',
      additionalProperties: false,
      required:    ['peer', 'prompt', 'mode'],
      properties: {
        peer:   { type: 'string', description: 'Peer routing name (e.g. "@reddit-scout")' },
        prompt: { type: 'string', description: 'What to ask' },
        mode:   { type: 'string', enum: ['ask', 'tell'], description: 'ask: wait for reply; tell: fire-and-forget' },
      },
    },
  },
  {
    name: 'probe_peers',
    description: 'Fan-out the same short question to many peers in parallel. Use for discovery (e.g. "do you have a User model?"). Returns a list of (peer, answer) pairs collected within 30s.',
    inputSchema: {
      type:        'object',
      additionalProperties: false,
      required:    ['prompt'],
      properties: {
        prompt: { type: 'string', description: 'The question to fan out' },
        peers:  { type: 'array',  items: { type: 'string' }, description: 'Peer routing names to ask; null = all online peers' },
      },
    },
  },
  {
    name: 'attach_file',
    description: 'Upload a file from your project as a chat attachment. The path must be inside your current working directory (relative paths are resolved against cwd; symlinks pointing outside are refused). Use this when the operator should be able to download a file you produced. Returns a fileId; mention it in your reply text so the operator can find the chip in the dashboard. Optional `targetSessionId` lets you upload directly into a different session (e.g. when delivering a file to a peer the channel-token owner has prompter+ on). Without it, the upload goes to the channel\'s own session — the common case.',
    inputSchema: {
      type:        'object',
      additionalProperties: false,
      required:    ['path'],
      properties: {
        path:            { type: 'string', description: 'Path to the file. Relative is resolved against cwd; absolute must still resolve to a path under cwd.' },
        targetSessionId: { type: 'string', description: 'Optional UUID of a different session to upload to. The channel-token\'s owning user must have prompter+ role on it (owner or shared-as-prompter/approver). Most callers should omit this and let the upload go to the channel\'s own session.' },
      },
    },
  },
] as const;

export async function callTool(
  ctx: CallContext,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; content: { type: 'text'; text: string }[] }> {
  switch (name) {
    case 'reply': {
      const chatId = String(args.chat_id ?? '').trim();
      const text   = String(args.text ?? '');
      if (!chatId) return errorContent('chat_id is required');
      if (!text)   return errorContent('text is required');
      // Reply is a chat_event with chatId in the payload — hub uses
      // it to correlate against any pending route_request waiting on
      // this chatId.
      ctx.client.send({
        type: 'chat_event',
        eventType: 'reply',
        payload: { chatId, text },
        ts: new Date().toISOString(),
      });
      return textContent('reply posted');
    }
    case 'list_peers': {
      const correlationId = randomUUID();
      try {
        const peers = await ctx.client.requestSingle<{ login: string; name: string; online: boolean }[]>(
          { type: 'list_peers_request', correlationId },
          LIST_TIMEOUT_MS,
        );
        if (peers.length === 0) return textContent('no peers online');
        const lines = peers.map((p) => `${p.online ? '●' : '○'} ${p.name} — @${p.login} (${p.online ? 'online' : 'offline'})`);
        return textContent(lines.join('\n'));
      } catch (e: any) {
        return errorContent(e?.message ?? 'list_peers failed');
      }
    }
    case 'route_to_peer': {
      const peer   = String(args.peer ?? '').trim();
      const prompt = String(args.prompt ?? '');
      const mode   = args.mode === 'tell' ? 'tell' : 'ask';
      if (!peer)   return errorContent('peer is required');
      if (!prompt) return errorContent('prompt is required');
      const correlationId = randomUUID();
      if (mode === 'tell') {
        ctx.client.send({ type: 'route_request', correlationId, peer, prompt, mode });
        return textContent(`routed to ${peer} (tell mode — fire-and-forget)`);
      }
      try {
        const result = await ctx.client.requestSingle<{ peerLogin: string; reply: string }>(
          { type: 'route_request', correlationId, peer, prompt, mode },
          ASK_TIMEOUT_MS,
        );
        return textContent(`@${result.peerLogin} replied:\n${result.reply}`);
      } catch (e: any) {
        return errorContent(e?.message ?? 'route_to_peer failed');
      }
    }
    case 'probe_peers': {
      const prompt = String(args.prompt ?? '');
      if (!prompt) return errorContent('prompt is required');
      const peersArg = Array.isArray(args.peers)
        ? (args.peers as unknown[]).filter((p) => typeof p === 'string') as string[]
        : null;
      const correlationId = randomUUID();
      const results = await ctx.client.requestProbe(
        { type: 'probe_request', correlationId, peers: peersArg, prompt },
        PROBE_TIMEOUT_MS,
      );
      if (results.length === 0) return textContent('no peers responded within 30s');
      const lines = results.map((r) => `@${r.peerLogin}: ${r.answer ?? '(no answer)'}`);
      return textContent(lines.join('\n'));
    }
    case 'attach_file': {
      const inputPath       = String(args.path ?? '').trim();
      const targetSessionId = typeof args.targetSessionId === 'string' && args.targetSessionId.trim()
        ? args.targetSessionId.trim()
        : null;
      if (!inputPath)        return errorContent('path is required');
      if (!ctx.sessionId)    return errorContent('channel not registered yet — try again in a moment');

      // Path safety: refuse anything that resolves outside cwd, even
      // through a symlink chain. realpath dereferences fully; if the
      // real target lives outside cwd we abort. Also realpath cwd
      // itself so the comparison is apples-to-apples (cwd may itself
      // be a symlinked path).
      let absInput: string;
      try { absInput = resolve(ctx.cwd, inputPath); }
      catch { return errorContent(`path could not be resolved: ${inputPath}`); }

      let realInput: string;
      let realCwd:   string;
      try {
        realCwd   = await realpath(ctx.cwd);
        realInput = await realpath(absInput);
      } catch (e: any) {
        return errorContent(`path does not exist or is unreadable: ${inputPath}`);
      }
      const rel = relative(realCwd, realInput);
      if (rel.startsWith('..') || rel === '' || /^([a-zA-Z]:)?[\\/]/.test(rel)) {
        return errorContent(`path is outside cwd (or its symlink target is): ${inputPath}`);
      }

      // Size pre-check before reading the bytes — stops a 10 GB log
      // from being slurped into memory just to be rejected.
      let stats;
      try { stats = await stat(realInput); }
      catch { return errorContent(`path does not exist: ${inputPath}`); }
      if (!stats.isFile())              return errorContent(`path is not a regular file: ${inputPath}`);
      if (stats.size === 0)             return errorContent(`file is empty: ${inputPath}`);
      if (stats.size > MAX_ATTACH_BYTES) {
        return errorContent(`file is ${stats.size} bytes; max is ${MAX_ATTACH_BYTES}`);
      }

      let buf: Buffer;
      try { buf = await readFile(realInput); }
      catch (e: any) { return errorContent(`failed to read file: ${e?.message ?? e}`); }

      // Build multipart manually — Node's fetch + FormData stringifies
      // a Blob just fine for this. Filename comes from the basename of
      // the resolved real path so symlink redirects don't smuggle a
      // weird display name.
      const filename = basename(realInput);
      const mime     = guessMime(filename);
      const fd = new FormData();
      // sessionId routes the upload: ctx.sessionId is the channel's
      // own session (default); targetSessionId overrides it for
      // cross-session writes (the owning user must have prompter+
      // on the target — the hub gates this server-side via
      // /api/channel/files's resolveSessionRole + isPrompter check).
      fd.append('sessionId', targetSessionId ?? ctx.sessionId);
      fd.append('file', new Blob([buf], { type: mime }), filename);

      let res: Response;
      try {
        res = await fetch(`${ctx.httpHubUrl}/api/channel/files`, {
          method:  'POST',
          headers: { 'Authorization': `Bearer ${ctx.channelToken}` },
          body:    fd,
        });
      } catch (e: any) {
        return errorContent(`hub unreachable: ${e?.message ?? e}`);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return errorContent(`hub rejected upload (HTTP ${res.status}): ${text.slice(0, 200)}`);
      }
      const j = await res.json() as {
        id: number; filename: string; mime: string; size: number;
        sha256: string; sessionId: string;
      };
      return textContent(
        `attached ${j.filename} (${j.size} bytes, ${j.mime}); fileId=${j.id}, sha256=${j.sha256.slice(0, 12)}…`,
      );
    }

    default:
      return errorContent(`unknown tool: ${name}`);
  }
}

// Lightweight extension-based mime guess. The hub doesn't trust this
// (its file-store stores whatever we send), but a reasonable mime
// shows up in the operator's dashboard chip.
function guessMime(filename: string): string {
  const m = /\.([a-zA-Z0-9]+)$/.exec(filename);
  if (!m) return 'application/octet-stream';
  const ext = m[1].toLowerCase();
  return ({
    txt:  'text/plain',
    md:   'text/markdown',
    json: 'application/json',
    yaml: 'application/yaml', yml: 'application/yaml',
    html: 'text/html',        css: 'text/css',
    js:   'text/javascript',  mjs: 'text/javascript',
    ts:   'text/typescript',  tsx: 'text/typescript',
    csv:  'text/csv',         tsv: 'text/tab-separated-values',
    pdf:  'application/pdf',
    png:  'image/png',        jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif:  'image/gif',        webp:'image/webp', svg: 'image/svg+xml',
    zip:  'application/zip',  gz:  'application/gzip',
    log:  'text/plain',
  } as Record<string, string>)[ext] ?? 'application/octet-stream';
}

function textContent(text: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text }] };
}
function errorContent(text: string): { isError: true; content: { type: 'text'; text: string }[] } {
  return { isError: true, content: [{ type: 'text', text }] };
}

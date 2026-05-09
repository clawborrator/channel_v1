// MCP tool registry. Each tool wraps a request-response round-trip
// against the hub via the channel WS.
//
// Tools exposed:
//   reply           — Claude posts a tagged final reply (resolves
//                     pending route_to_peer asks on the originator)
//   reply_chunk     — Claude streams reply text progressively; same
//                     chat_id, multiple calls, terminate with
//                     done:true. Operators see text grow live;
//                     route originators still get the consolidated
//                     reply at done:true (Phase 1 — non-streaming
//                     callers).
//   list_peers      — discover the operator's other online sessions
//   route_to_peer   — send a prompt to one peer; ask blocks for reply,
//                     tell is fire-and-forget
//   probe_peers     — fan-out a short question across many peers
//   attach_file     — upload a file from the local cwd as a chat
//                     attachment; returns a fileId for chat refs
//   read_file       — fetch hub-stored file bytes by fileId; used when
//                     a routed prompt mentions fileId=N. Text-mime
//                     content is returned inline (1 MB cap).
//   download_to_path — fetch a hub file to a local path under cwd
//                     (binaries: PDFs, images, archives, anything
//                     read_file refuses inline). Returns the path so
//                     Claude can Read/Bash the bytes natively.
//   list_agents     — discover public agents on the hub. Returns
//                     handle, name, tagline, online, mine flags so
//                     the CC can recommend agents the operator
//                     hasn't named.
//   dispatch_to_agent — invoke a published agent by `<owner>/<slug>`
//                     handle. Use this when the operator references
//                     a public agent that isn't in list_peers (which
//                     only shows the operator's OWN sessions).
//
// Inbound prompts (operator-driven or peer-routed) arrive directly to
// Claude via `notifications/claude/channel` — see index.ts onPrompt.
// No queue, no polling tool.

import { randomUUID } from 'node:crypto';
import { resolve, relative, basename, dirname } from 'node:path';
import { realpath, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import type { ChannelClient } from '../ws-client.js';

const ASK_TIMEOUT_MS   = 900_000;
const PROBE_TIMEOUT_MS = 30_000;
const LIST_TIMEOUT_MS  = 5_000;
const ASK_QUESTION_TIMEOUT_MS = 900_000;  // 15min — same cap as route ask mode
const MAX_ATTACH_BYTES = 10 * 1024 * 1024;
const MAX_READ_INLINE_BYTES = 1 * 1024 * 1024;

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

type ToolResult = { isError?: boolean; content: { type: 'text'; text: string }[] };

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
    name: 'reply_chunk',
    description: 'Stream a reply progressively to the operator instead of sending it all at once. Pass the same chat_id as `reply` and call this multiple times — each call broadcasts a chunk to the operator\'s dashboard live (they see text growing in real time). The FINAL call must set `done: true` to close the turn. Use this whenever your reply is long, when you\'re narrating progress through a multi-step task, or when generating output that builds up over time (file synthesis, code, multi-paragraph explanations). For short atomic replies, use `reply` instead.',
    inputSchema: {
      type:        'object',
      additionalProperties: false,
      required:    ['chat_id', 'text', 'done'],
      properties: {
        chat_id: { type: 'string', description: 'Same chat_id as the inbound prompt — every chunk in a turn shares it.' },
        text:    { type: 'string', description: 'The chunk to append. Empty allowed (e.g. final empty chunk solely to mark done).' },
        done:    { type: 'boolean', description: 'true on the final chunk; closes the turn, persists the consolidated text, dispatches to route originators. false on intermediate chunks.' },
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
    description: 'Send a prompt to one of THE OPERATOR\'S OWN peer Claude Code sessions (use list_peers first to discover them). Do NOT use this for cross-tenant public agents — those need `dispatch_to_agent` with an `<owner>/<slug>` handle. mode=ask blocks for the reply (15 min cap); mode=tell is fire-and-forget.',
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
    name: 'list_agents',
    description: 'List public expert agents on the hub — anything any operator can dispatch to via dispatch_to_agent. Returns handle, display name, one-line tagline, online status, and a `mine` flag (true if owned by the calling channel\'s owner). Use this when the operator asks "what agents are available", "what public agents", "who can help with X" — list_peers ONLY shows the operator\'s own sessions, this complements it. Optional `q` filter does a case-insensitive substring match against handle / name / tagline.',
    inputSchema: {
      type:        'object',
      additionalProperties: false,
      properties: {
        q: { type: 'string', description: 'Optional substring filter (case-insensitive) on handle / name / tagline.' },
      },
    },
  },
  {
    name: 'dispatch_to_agent',
    description: 'Invoke a published agent by handle (e.g. `MRIIOT/orchard-api`) and get its reply. Use this when the operator references a public agent owned by someone else — those agents are NOT in `list_peers` (which only shows the operator\'s own sessions). The agent\'s session must be online; budgets are enforced server-side. ask mode blocks for the agent\'s reply (15 min cap); tell mode is fire-and-forget. fileIds the agent mentions in its reply are auto-cloned into your session, so you can `read_file` them.',
    inputSchema: {
      type:        'object',
      additionalProperties: false,
      required:    ['handle', 'prompt', 'mode'],
      properties: {
        handle: { type: 'string', description: 'Agent handle in `<owner>/<slug>` form (with or without leading `@`).' },
        prompt: { type: 'string', description: 'What to ask the agent.' },
        mode:   { type: 'string', enum: ['ask', 'tell'], description: 'ask: wait for the reply (180s cap); tell: fire-and-forget.' },
      },
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a hub-stored file by fileId. Use this whenever a prompt mentions `fileId=N` and you need to see what the file contains (the operator uploaded it on their side; the bytes live on the hub, not your local FS). Text-mime content is returned inline up to 1 MB; binary or oversized files return an error with metadata — the operator can share those out-of-band. Access is gated by the channel-token owner\'s role on the file\'s session, so cross-tenant fileId guesses are denied.',
    inputSchema: {
      type:        'object',
      additionalProperties: false,
      required:    ['fileId'],
      properties: {
        fileId: { type: 'integer', minimum: 1, description: 'The numeric fileId from the prompt (e.g. 16 for `fileId=16`).' },
      },
    },
  },
  {
    name: 'download_to_path',
    description: 'Download a hub-stored file by fileId to a relative path under your cwd. Use this for BINARY files (PDFs, images, archives, video, etc.) that `read_file` can\'t return inline, or whenever you need the bytes on local disk for processing (e.g. running `Bash pdftoppm`, `Read` on an image, `unzip`). The parent directory is created if missing; the target must NOT already exist (remove it first if you need to refetch). Returns the relative path so you can immediately use Read or Bash on the file. Same ACL as read_file: row must live in this agent\'s session (i.e. the file was forward-cloned here by the hub, or you uploaded it here yourself).',
    inputSchema: {
      type:        'object',
      additionalProperties: false,
      required:    ['fileId', 'path'],
      properties: {
        fileId: { type: 'integer', minimum: 1, description: 'The fileId to download (typically from a routed prompt mentioning fileId=N).' },
        path:   { type: 'string',  description: 'Relative path under cwd, e.g. "tmp/doc.pdf". Parent dirs are auto-created. Target must not already exist.' },
      },
    },
  },
  {
    name: 'ask_question',
    description: 'Ask the REMOTE operator a multiple-choice question through orchard-chat — does NOT block the local TUI. Prefer this over the built-in `AskUserQuestion` tool whenever the session is being driven remotely (operator messages arrive as <channel source="clawborrator"> tags), since `AskUserQuestion` opens a synchronous picker in the local terminal that no one is watching. Same input shape as AskUserQuestion: a `questions[]` array, each with `question`, optional `header`, optional `multiSelect`, and 2-4 `options[]` (each `{label, description?}`). Renders as a clickable card on the operator\'s orchard-chat. Blocks (max 15min) until the operator picks an option; returns the chosen label as the tool result. If the operator types a free-form chat message INSTEAD of clicking, that message returns the user to a normal turn — don\'t treat it as the answer; it\'s a redirect. Picking from a multi-question array fires once per question.',
    inputSchema: {
      type:        'object',
      additionalProperties: false,
      required:    ['questions'],
      properties: {
        questions: {
          type:     'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type:        'object',
            additionalProperties: false,
            required:    ['question', 'options'],
            properties: {
              question:    { type: 'string', description: 'The full question text shown to the operator.' },
              header:      { type: 'string', description: 'Short label (≤ 12 chars) shown as a chip next to the question.' },
              multiSelect: { type: 'boolean', description: 'When true, multiple options can be picked. Default false.' },
              options: {
                type:     'array',
                minItems: 2,
                maxItems: 4,
                items: {
                  type:        'object',
                  additionalProperties: false,
                  required:    ['label'],
                  properties: {
                    label:       { type: 'string', description: 'Button label (1-5 words).' },
                    description: { type: 'string', description: 'One-line context shown under the button.' },
                  },
                },
              },
            },
          },
        },
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

// ---------------------------------------------------------------------------
// Per-tool handlers, extracted from the original mega-switch in callTool.
// Each handler takes the CallContext + raw args object, validates inputs,
// and returns the standard { isError?, content[] } MCP shape via the
// errorContent / textContent helpers at the bottom of the file. Behavior
// is intentionally identical to the inline cases.
// ---------------------------------------------------------------------------

async function callReply(ctx: CallContext, args: Record<string, unknown>): Promise<ToolResult> {
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

async function callReplyChunk(ctx: CallContext, args: Record<string, unknown>): Promise<ToolResult> {
  const chatId = String(args.chat_id ?? '').trim();
  const text   = String(args.text ?? '');
  const done   = args.done === true;
  if (!chatId) return errorContent('chat_id is required');
  // text can be empty (terminal-only chunk); done is the
  // explicit close signal. Hub guards against runaway streams
  // via REPLY_CHUNK_MAX_BYTES / REPLY_CHUNK_MAX_CHUNKS caps.
  ctx.client.send({
    type:      'chat_event',
    eventType: 'reply_chunk',
    payload:   { chatId, text, done },
    ts:        new Date().toISOString(),
  });
  return textContent(done ? 'reply stream closed' : 'chunk streamed');
}

async function callListPeers(ctx: CallContext, _args: Record<string, unknown>): Promise<ToolResult> {
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

async function callRouteToPeer(ctx: CallContext, args: Record<string, unknown>): Promise<ToolResult> {
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

async function callProbePeers(ctx: CallContext, args: Record<string, unknown>): Promise<ToolResult> {
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

async function callListAgents(ctx: CallContext, args: Record<string, unknown>): Promise<ToolResult> {
  const q = typeof args.q === 'string' && args.q.trim() ? args.q.trim() : undefined;
  const correlationId = randomUUID();
  try {
    const result = await ctx.client.requestSingle<{
      callerLogin: string;
      agents: {
        handle: string; ownerLogin: string; name: string; tagline: string;
        online: boolean; mine: boolean; isolated: boolean;
      }[];
    }>(
      q
        ? { type: 'list_agents_request', correlationId, q }
        : { type: 'list_agents_request', correlationId },
      LIST_TIMEOUT_MS,
    );
    if (result.agents.length === 0) {
      return textContent(q ? `no public agents match "${q}"` : 'no published public agents');
    }
    // Lead with explicit caller-context so the CC doesn't infer
    // ownership from handle prefixes — followed by one row per
    // agent with the owner's login spelled out and a yours/not-
    // yours marker.
    const header = `(you are @${result.callerLogin}; ${result.agents.length} public agent${result.agents.length === 1 ? '' : 's'}${q ? ` matching "${q}"` : ''})`;
    const lines = result.agents.map((a) => {
      const dot      = a.online ? '●' : '○';
      const tag      = a.tagline ? ` · ${a.tagline}` : '';
      const ownerTag = a.mine ? '(yours)' : `by @${a.ownerLogin}`;
      const isoTag   = a.isolated ? '[isolated]' : '[composable]';
      return `${dot} @${a.handle} ${ownerTag} ${isoTag} — ${a.name}${tag}`;
    });
    return textContent([header, ...lines].join('\n'));
  } catch (e: any) {
    return errorContent(e?.message ?? 'list_agents failed');
  }
}

async function callDispatchToAgent(ctx: CallContext, args: Record<string, unknown>): Promise<ToolResult> {
  const handle = String(args.handle ?? '').trim().replace(/^@/, '');
  const prompt = String(args.prompt ?? '');
  const mode   = args.mode === 'tell' ? 'tell' : 'ask';
  if (!handle.includes('/')) return errorContent('handle must be in <owner>/<slug> form (e.g. MRIIOT/orchard-api)');
  if (!prompt) return errorContent('prompt is required');
  const correlationId = randomUUID();
  if (mode === 'tell') {
    ctx.client.send({ type: 'dispatch_request', correlationId, handle, prompt, mode });
    return textContent(`dispatched to @${handle} (tell mode — fire-and-forget)`);
  }
  try {
    const result = await ctx.client.requestSingle<{ peerLogin: string; reply: string }>(
      { type: 'dispatch_request', correlationId, handle, prompt, mode },
      ASK_TIMEOUT_MS,
    );
    return textContent(`@${result.peerLogin.replace(/^@/, '')} replied:\n${result.reply}`);
  } catch (e: any) {
    return errorContent(e?.message ?? 'dispatch_to_agent failed');
  }
}

// Fetch GET /api/channel/files/:id with the channel token. Shared by
// read_file and download_to_path. On HTTP error returns an
// errorContent ToolResult; on success returns the raw Response so the
// caller can drive it (read_file slurps + decodes; download_to_path
// streams to disk).
async function fetchHubFile(ctx: CallContext, fileId: number): Promise<{ res: Response } | { error: ToolResult }> {
  const url = `${ctx.httpHubUrl}/api/channel/files/${fileId}?sessionId=${encodeURIComponent(ctx.sessionId!)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method:  'GET',
      headers: { 'Authorization': `Bearer ${ctx.channelToken}` },
    });
  } catch (e: any) {
    return { error: errorContent(`hub unreachable: ${e?.message ?? e}`) };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { error: errorContent(`hub rejected read (HTTP ${res.status}): ${text.slice(0, 200)}`) };
  }
  return { res };
}

// Pull filename / mime / size from the channel-files response headers
// using the same x-clawborrator-* set the hub emits.
function readFileMetaFromResponse(res: Response, fileId: number): { filename: string; mime: string; size: number } {
  const filename = res.headers.get('x-clawborrator-file-name') ?? `fileId-${fileId}`;
  const mime     = res.headers.get('x-clawborrator-file-mime')
                ?? res.headers.get('content-type')
                ?? 'application/octet-stream';
  const sizeHdr  = res.headers.get('x-clawborrator-file-size')
                ?? res.headers.get('content-length');
  const size     = sizeHdr ? Number.parseInt(sizeHdr, 10) : -1;
  return { filename, mime, size };
}

async function callReadFile(ctx: CallContext, args: Record<string, unknown>): Promise<ToolResult> {
  const fileId = Number(args.fileId);
  if (!Number.isInteger(fileId) || fileId < 1) {
    return errorContent('fileId must be a positive integer');
  }
  if (!ctx.sessionId) {
    return errorContent('channel not registered yet — try again in a moment');
  }
  // sessionId pins the read to THIS agent's session (server-side
  // gate is row.sessionId === callerSessionId). Without it the
  // hub would have to fall back on "any role" which lets a
  // malicious caller borrow this agent's read scope to fetch the
  // owner's private files via fileId guessing — see the forward-
  // clone is the ACL frontier discussion in 3-AGENT-TESTS.md.
  const fetched = await fetchHubFile(ctx, fileId);
  if ('error' in fetched) return fetched.error;
  const { res } = fetched;
  const { filename, mime, size } = readFileMetaFromResponse(res, fileId);

  // Size gate FIRST — refuse before slurping into memory.
  if (size > MAX_READ_INLINE_BYTES) {
    return errorContent(
      `file is ${size} bytes; max inlinable is ${MAX_READ_INLINE_BYTES} ` +
      `(${filename}, mime=${mime}). For larger files, ask the operator to share contents directly.`,
    );
  }
  // Mime gate — text-y mimes only. We refuse binary inline because
  // tool result blocks don't carry binary safely. Point the agent
  // at download_to_path, which writes bytes to a local path under
  // cwd so Read/Bash can operate on them natively.
  if (!isTextMime(mime)) {
    return errorContent(
      `file ${filename} is binary (mime=${mime}, size=${size}); read_file only returns text-mime ` +
      `content inline. Use download_to_path({fileId: ${fileId}, path: "<cwd-relative-path>"}) ` +
      `to fetch the bytes to a local path you can then Read or process via Bash.`,
    );
  }

  let buf: ArrayBuffer;
  try { buf = await res.arrayBuffer(); }
  catch (e: any) { return errorContent(`failed to read response body: ${e?.message ?? e}`); }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  return textContent(
    `fileId=${fileId} (${filename}, ${mime}, ${size} bytes):\n\n${text}`,
  );
}

// Path safety — refuse anything that resolves outside cwd. Used by
// download_to_path (target doesn't exist yet, so we realpath the cwd
// only). Returns the absolute resolved path + posix-relative for
// reporting, or an errorContent on failure.
async function resolveCwdRelativeForCreate(
  cwd: string,
  inputPath: string,
): Promise<{ absInput: string; rel: string } | { error: ToolResult }> {
  let absInput: string;
  try { absInput = resolve(cwd, inputPath); }
  catch { return { error: errorContent(`path could not be resolved: ${inputPath}`) }; }

  let realCwd: string;
  try { realCwd = await realpath(cwd); }
  catch (e: any) { return { error: errorContent(`cwd unreadable: ${e?.message ?? e}`) }; }

  const rel = relative(realCwd, absInput);
  if (rel.startsWith('..') || rel === '' || /^([a-zA-Z]:)?[\\/]/.test(rel)) {
    return { error: errorContent(`path is outside cwd: ${inputPath}`) };
  }
  return { absInput, rel };
}

async function callDownloadToPath(ctx: CallContext, args: Record<string, unknown>): Promise<ToolResult> {
  const fileId    = Number(args.fileId);
  const inputPath = String(args.path ?? '').trim();
  if (!Number.isInteger(fileId) || fileId < 1) return errorContent('fileId must be a positive integer');
  if (!inputPath)     return errorContent('path is required');
  if (!ctx.sessionId) return errorContent('channel not registered yet — try again in a moment');

  // Path safety — same containment check as attach_file. The
  // target doesn't exist yet (that's the whole point), so we
  // realpath the cwd and check that the resolved absolute path
  // is under it. We do NOT realpath the input itself (would
  // ENOENT), just the parent on creation.
  const resolved = await resolveCwdRelativeForCreate(ctx.cwd, inputPath);
  if ('error' in resolved) return resolved.error;
  const { absInput, rel } = resolved;

  // Refuse if the target already exists. Forces an explicit
  // remove-and-redownload so we don't accidentally clobber a
  // file Claude is mid-editing.
  try {
    await stat(absInput);
    return errorContent(`path exists: ${inputPath} — remove it first or pick a different path`);
  } catch { /* ENOENT is the success case */ }

  // Create parent dir tree if missing — agents commonly want
  // to drop into out/, tmp/, etc. without a separate mkdir.
  const parent = dirname(absInput);
  try {
    await mkdir(parent, { recursive: true });
  } catch (e: any) {
    return errorContent(`failed to create parent dir: ${e?.message ?? e}`);
  }

  // Fetch from the hub. Same endpoint read_file uses, same
  // ACL gate (row.sessionId === ctx.sessionId enforced server-
  // side). Difference: download_to_path doesn't apply the
  // text-mime/inline-size restrictions read_file has — bytes go
  // straight to disk.
  const fetched = await fetchHubFile(ctx, fileId);
  if ('error' in fetched) return fetched.error;
  const { res } = fetched;
  const { filename, mime, size } = readFileMetaFromResponse(res, fileId);

  let buf: Buffer;
  try { buf = Buffer.from(await res.arrayBuffer()); }
  catch (e: any) { return errorContent(`failed to read response body: ${e?.message ?? e}`); }
  try { await writeFile(absInput, buf); }
  catch (e: any) { return errorContent(`failed to write to ${rel}: ${e?.message ?? e}`); }

  return textContent(
    `downloaded fileId=${fileId} (${filename}, ${mime}, ${size} bytes) to ${rel}`,
  );
}

// Resolve + validate the attach_file input path. Both the input AND
// the cwd are realpath'd so symlink-redirected paths are caught
// (refuses a symlink chain that points outside cwd). Returns the
// realpath-resolved input + posix-relative form, or an errorContent.
async function resolveAttachInput(
  cwd: string,
  inputPath: string,
): Promise<{ realInput: string; rel: string } | { error: ToolResult }> {
  let absInput: string;
  try { absInput = resolve(cwd, inputPath); }
  catch { return { error: errorContent(`path could not be resolved: ${inputPath}`) }; }

  let realInput: string;
  let realCwd:   string;
  try {
    realCwd   = await realpath(cwd);
    realInput = await realpath(absInput);
  } catch {
    return { error: errorContent(`path does not exist or is unreadable: ${inputPath}`) };
  }
  const rel = relative(realCwd, realInput);
  if (rel.startsWith('..') || rel === '' || /^([a-zA-Z]:)?[\\/]/.test(rel)) {
    return { error: errorContent(`path is outside cwd (or its symlink target is): ${inputPath}`) };
  }
  return { realInput, rel };
}

// Stat + size-gate the input file. Pre-check before we slurp bytes;
// keeps a 10 GB log from being read into memory just to be rejected.
async function statAttachFile(realInput: string, inputPath: string): Promise<
  { sizeOk: true; size: number } | { error: ToolResult }
> {
  let stats;
  try { stats = await stat(realInput); }
  catch { return { error: errorContent(`path does not exist: ${inputPath}`) }; }
  if (!stats.isFile())              return { error: errorContent(`path is not a regular file: ${inputPath}`) };
  if (stats.size === 0)             return { error: errorContent(`file is empty: ${inputPath}`) };
  if (stats.size > MAX_ATTACH_BYTES) {
    return { error: errorContent(`file is ${stats.size} bytes; max is ${MAX_ATTACH_BYTES}`) };
  }
  return { sizeOk: true, size: stats.size };
}

// Build the multipart form body for POST /api/channel/files. We use
// Node's built-in FormData + Blob; filename is the basename of the
// realpath-resolved input (so a symlink can't smuggle a different
// display name into the dashboard chip).
function buildAttachFormData(
  realInput: string,
  buf: Buffer,
  ownSessionId: string,
  targetSessionId: string | null,
): FormData {
  const filename = basename(realInput);
  const mime     = guessMime(filename);
  const fd = new FormData();
  // sessionId routes the upload: ownSessionId is the channel's own
  // session (default); targetSessionId overrides it for cross-session
  // writes (the owning user must have prompter+ on the target — the
  // hub gates this server-side via /api/channel/files's
  // resolveSessionRole + isPrompter check).
  fd.append('sessionId', targetSessionId ?? ownSessionId);
  fd.append('file', new Blob([buf], { type: mime }), filename);
  return fd;
}

// POST the multipart form to the hub. Returns the JSON metadata or an
// errorContent.
async function postAttachUpload(
  ctx: CallContext,
  fd: FormData,
): Promise<{ json: { id: number; filename: string; mime: string; size: number; sha256: string; sessionId: string } } | { error: ToolResult }> {
  let res: Response;
  try {
    res = await fetch(`${ctx.httpHubUrl}/api/channel/files`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${ctx.channelToken}` },
      body:    fd,
    });
  } catch (e: any) {
    return { error: errorContent(`hub unreachable: ${e?.message ?? e}`) };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { error: errorContent(`hub rejected upload (HTTP ${res.status}): ${text.slice(0, 200)}`) };
  }
  const json = await res.json() as {
    id: number; filename: string; mime: string; size: number;
    sha256: string; sessionId: string;
  };
  return { json };
}

async function callAttachFile(ctx: CallContext, args: Record<string, unknown>): Promise<ToolResult> {
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
  const resolved = await resolveAttachInput(ctx.cwd, inputPath);
  if ('error' in resolved) return resolved.error;
  const { realInput } = resolved;

  // Size pre-check before reading the bytes — stops a 10 GB log
  // from being slurped into memory just to be rejected.
  const sized = await statAttachFile(realInput, inputPath);
  if ('error' in sized) return sized.error;

  let buf: Buffer;
  try { buf = await readFile(realInput); }
  catch (e: any) { return errorContent(`failed to read file: ${e?.message ?? e}`); }

  // Build multipart manually — Node's fetch + FormData stringifies
  // a Blob just fine for this. Filename comes from the basename of
  // the resolved real path so symlink redirects don't smuggle a
  // weird display name.
  const fd = buildAttachFormData(realInput, buf, ctx.sessionId, targetSessionId);
  const posted = await postAttachUpload(ctx, fd);
  if ('error' in posted) return posted.error;
  const { json: j } = posted;
  return textContent(
    `attached ${j.filename} (${j.size} bytes, ${j.mime}); fileId=${j.id}, sha256=${j.sha256.slice(0, 12)}…`,
  );
}

export async function callTool(
  ctx: CallContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  switch (name) {
    case 'reply':             return callReply(ctx, args);
    case 'reply_chunk':       return callReplyChunk(ctx, args);
    case 'list_peers':        return callListPeers(ctx, args);
    case 'route_to_peer':     return callRouteToPeer(ctx, args);
    case 'probe_peers':       return callProbePeers(ctx, args);
    case 'list_agents':       return callListAgents(ctx, args);
    case 'dispatch_to_agent': return callDispatchToAgent(ctx, args);
    case 'read_file':         return callReadFile(ctx, args);
    case 'download_to_path':  return callDownloadToPath(ctx, args);
    case 'attach_file':       return callAttachFile(ctx, args);
    case 'ask_question':      return callAskQuestion(ctx, args);
    default:                  return errorContent(`unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// ask_question — non-blocking remote multiple-choice replacement for the
// built-in AskUserQuestion tool. Emits a tail event with eventType
// 'AskUserQuestion' so orchard-chat renders the same question card; then
// subscribes for the next inbound chat-prompt whose text matches one of
// the option labels (the operator clicks → orchard-chat sends the chosen
// label as a chat/prompt). On match: emit a follow-up tail event with the
// `answers` field populated (so the card flips to answered state across
// all viewers, including page reloads), and return the chosen label as
// the tool result. Local CC TUI is NOT blocked by any of this.
// ---------------------------------------------------------------------------
async function callAskQuestion(ctx: CallContext, args: Record<string, unknown>): Promise<ToolResult> {
  const questions = Array.isArray(args.questions) ? args.questions as any[] : [];
  if (questions.length === 0) return errorContent('questions[] is required and must be non-empty');

  // Collect every label across every question. The first inbound prompt
  // whose trimmed text matches one of these wins. (Multi-question call
  // returns only the first matched answer in this v1; expand later if
  // needed.)
  const labelByQuestion = new Map<string, Set<string>>();
  for (const q of questions) {
    const set = new Set<string>();
    for (const opt of (Array.isArray(q?.options) ? q.options : [])) {
      const lbl = String(opt?.label ?? '').trim();
      if (lbl) set.add(lbl);
    }
    labelByQuestion.set(String(q?.question ?? ''), set);
  }
  const allLabels = new Set<string>();
  for (const set of labelByQuestion.values()) for (const l of set) allLabels.add(l);
  if (allLabels.size === 0) return errorContent('no option labels found across the questions');

  const questionId = randomUUID();
  const ts = () => new Date().toISOString();

  // Emit the question card. Mirrors a PreToolUse-AskUserQuestion shape so
  // orchard-chat's existing tail-question coalescer picks it up unchanged.
  ctx.client.send({
    type:      'tail_event',
    eventType: 'AskUserQuestion',
    payload: {
      tool_name:   'AskUserQuestion',
      tool_use_id: questionId,
      tool_input:  { questions },
      // Marks this as a clawborrator-initiated question rather than a
      // CC built-in — useful for orchard-chat / debugging filters.
      source:      'mcp_ask_question',
    },
    ts: ts(),
  });

  // Wait for a matching click. The matcher trims for tolerance against
  // any leading/trailing whitespace orchard-chat may add.
  let answer;
  try {
    answer = await ctx.client.subscribePrompt(
      (text) => allLabels.has(text.trim()),
      ASK_QUESTION_TIMEOUT_MS,
    );
  } catch (e: any) {
    return errorContent(`ask_question timed out after ${Math.round(ASK_QUESTION_TIMEOUT_MS / 1000)}s waiting for an option click`);
  }

  // Emit the answered tail event so the card flips state for every
  // viewer (and survives page reloads, since the row is upgraded on
  // re-coalesce from the events log).
  const chosen = answer.text.trim();
  const answers: Record<string, string> = {};
  for (const [qText, labels] of labelByQuestion.entries()) {
    if (labels.has(chosen)) answers[qText] = chosen;
  }
  ctx.client.send({
    type:      'tail_event',
    eventType: 'AskUserQuestion',
    payload: {
      tool_name:   'AskUserQuestion',
      tool_use_id: questionId,
      tool_input:  { questions },
      answers,
      source:      'mcp_ask_question',
    },
    ts: ts(),
  });

  return textContent(`Operator answered: ${chosen}`);
}

function isTextMime(mime: string): boolean {
  if (mime.startsWith('text/')) return true;
  // The application/* mimes that are reliably UTF-8 text. Excludes
  // application/octet-stream, pdf, zip, etc.
  return /^application\/(json|x-?json|x?ml|yaml|x-yaml|x-toml|x-shellscript|javascript|sql|x-sh)/i.test(mime);
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

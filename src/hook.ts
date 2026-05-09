// Hook entry point. Spawned by Claude Code per `.claude/settings.json`
// like:
//
//   { "type": "command", "command": "npx clawborrator-mcp --hook=PreToolUse" }
//
// The hook receives the JSON payload on stdin. We:
//   1. Read stdin to EOF
//   2. Locate the sidecar in the cwd (or walk up parents)
//   3. Map the hook name to a clawborrator event kind+type
//   4. Enrich Stop / SubagentStop with assistant_text (final answer)
//      from the transcript JSONL
//   5. For PreToolUse, ship 0..N chat/assistant_text events for any
//      "let me check X" running commentary Claude wrote in the same
//      assistant message before this tool_use, plus a placeholder
//      when extended thinking happened but the plaintext was stripped
//      from disk
//   6. POST /api/channel/event with the channel token from the sidecar
//   7. Echo stdin to stdout so Claude's hook chain stays intact

import { findSidecar, type SidecarPayload } from './sidecar.js';
import { log } from './log.js';
import {
  readTranscriptMessages,
  messageContainsToolUse,
  extractTextBlocksBeforeToolUse,
  hasThinkingBlocksBeforeToolUse,
  extractFromLastAssistantMessage,
  extractFinalAnswerFromTranscript,
  DEFAULT_TAIL_BYTES,
} from './transcript.js';

// Mirrors the install-hooks set from the old clawborrator-channel
// package so the remote viewer has the same coverage of Claude Code's
// hook surface.
// SessionStart / SessionEnd are deliberately ABSENT here — they're
// emitted server-side by hub_v1/server/src/ws/channel.ts on the
// channel-WS welcome/close transitions instead. The hook-side
// equivalents had a fundamental race (sidecar didn't exist yet on
// startup; sidecar already deleted on shutdown) plus duplication
// against the channel-emitted ones on every claude --resume. Channel-
// emitted is the single source of truth for "session is alive."
const HOOK_TO_EVENT: Record<string, { kind: 'chat' | 'tail'; type: string }> = {
  UserPromptSubmit:    { kind: 'chat', type: 'prompt' },
  PreToolUse:          { kind: 'tail', type: 'PreToolUse' },
  PostToolUse:         { kind: 'tail', type: 'PostToolUse' },
  PostToolUseFailure:  { kind: 'tail', type: 'PostToolUseFailure' },
  Stop:                { kind: 'tail', type: 'Stop' },
  Notification:        { kind: 'tail', type: 'Notification' },
  TaskCreated:         { kind: 'tail', type: 'TaskCreated' },
  SubagentStart:       { kind: 'tail', type: 'SubagentStart' },
  SubagentStop:        { kind: 'tail', type: 'SubagentStop' },
  TaskCompleted:       { kind: 'tail', type: 'TaskCompleted' },
};

// Tools whose pre-text we DON'T ship as AssistantText. The clawborrator
// reply tool already routes the user-facing answer over the WS — pre-
// reply text from the model is nearly identical and would render as a
// duplicate row in chat.
const TOOLS_SKIPPED_FOR_PRE_TEXT = new Set([
  'mcp__clawborrator__reply',
]);

async function readStdin(): Promise<string> {
  return new Promise((res) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { buf += chunk; });
    process.stdin.on('end',  () => res(buf));
    process.stdin.on('close', () => res(buf));
  });
}

interface PostBody {
  sessionId: string;
  kind:      'chat' | 'tail';
  type:      string;
  payload:   Record<string, unknown>;
  ts:        string;
}

async function postEvent(sidecar: SidecarPayload, body: PostBody, timeoutMs: number): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${sidecar.hubUrl}/api/channel/event`, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${sidecar.channelToken}`,
        'Content-Type':  'application/json',
      },
      body:   JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.warn('hub rejected event', { kind: body.kind, type: body.type, status: res.status, body: text.slice(0, 240) });
      return false;
    }
    return true;
  } catch (e: any) {
    log.warn('event POST failed', { kind: body.kind, type: body.type, error: e?.message ?? String(e) });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Returns true if payload already has a populated string-shaped
// alternative (`text` / `response`) — caller should bail out and let
// downstream use it instead of overwriting with assistant_text.
function hasStringShapedReply(payload: Record<string, unknown>): boolean {
  if (typeof payload.text === 'string' && (payload.text as string).trim()) return true;
  if (typeof payload.response === 'string' && (payload.response as string).trim()) return true;
  return false;
}

// Stop / SubagentStop: try to populate payload.assistant_text from
// (in order) last_assistant_message → existing payload fields →
// transcript tail. Mutates payload in place.
async function enrichStopAssistantText(payload: Record<string, unknown>, hookName: string): Promise<void> {
  if (typeof payload.assistant_text === 'string' && payload.assistant_text.trim()) return;

  const fromLAM = extractFromLastAssistantMessage(payload.last_assistant_message);
  if (fromLAM) {
    payload.assistant_text = fromLAM;
    log.debug('stop: assistant_text from last_assistant_message', { chars: fromLAM.length });
    return;
  }

  if (hasStringShapedReply(payload)) return;

  const transcriptPath = typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
  if (!transcriptPath) {
    log.debug('stop: no transcript_path on payload, no assistant_text recoverable', { hookName });
    return;
  }

  // Sleep so CC has time to flush the just-finished assistant message
  // to disk before we tail-read. Without this, on some CC versions the
  // read returns the PRIOR turn's text, which would render the wrong
  // reply on attached operators' TUI.
  await new Promise((r) => setTimeout(r, 500));

  const text = extractFinalAnswerFromTranscript(transcriptPath, DEFAULT_TAIL_BYTES);
  if (text) {
    payload.assistant_text = text;
    log.info('stop: assistant_text extracted from transcript', { chars: text.length });
  } else {
    log.debug('stop: transcript had no assistant-text block in tail window', { hookName, path: transcriptPath });
  }
}

// Pull + normalize the PreToolUse-relevant fields off the hook
// payload. Returns null when essential identifiers are missing or
// the tool is on the skip-list (e.g. mcp__clawborrator__reply, where
// the WS path already routes the user-facing answer).
function parsePreToolPayload(payload: Record<string, unknown>): {
  transcriptPath: string;
  toolUseId:      string;
} | null {
  const transcriptPath = typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
  const toolUseId      = String(payload.tool_use_id ?? payload.toolUseId ?? '');
  const toolName       = String(payload.tool_name   ?? payload.toolName  ?? '');
  if (!transcriptPath || !toolUseId) return null;
  if (TOOLS_SKIPPED_FOR_PRE_TEXT.has(toolName)) return null;
  return { transcriptPath, toolUseId };
}

// Race-retry: CC writes the assistant message that DECIDED the
// tool_use to the transcript ASYNC, so a fresh read right after the
// hook fires can miss it. Retry up to 4 times with 80ms delays.
// Returns the latest messages array + whether the target was ever
// found + retry count.
async function readTranscriptWithRetry(
  transcriptPath: string,
  toolUseId: string,
): Promise<{ messages: ReturnType<typeof readTranscriptMessages>; foundTarget: boolean; retries: number }> {
  let messages = readTranscriptMessages(transcriptPath, DEFAULT_TAIL_BYTES);
  let foundTarget = messageContainsToolUse(messages, toolUseId);
  let retries = 0;
  while (!foundTarget && retries < 4) {
    await new Promise((r) => setTimeout(r, 80));
    messages = readTranscriptMessages(transcriptPath, DEFAULT_TAIL_BYTES);
    foundTarget = messageContainsToolUse(messages, toolUseId);
    retries++;
  }
  return { messages, foundTarget, retries };
}

// Build + dispatch the per-block AssistantText POSTs (or a single
// placeholder when only extended-thinking happened). Monotonic
// timestamps so events sort chronologically on the hub (chat_events
// orders by ts; ties broken by id, but ts ordering is the human
// signal).
async function postPreToolAssistantBlocks(
  sidecar: SidecarPayload,
  blocks: string[],
  hasThinking: boolean,
  toolUseId: string,
): Promise<void> {
  const baseMs = Date.now();
  const tsAt = (i: number) => new Date(baseMs + i).toISOString();

  if (blocks.length > 0) {
    // Fire all AssistantText POSTs in parallel — sequential with 600ms
    // each could exceed CC's hook timeout on multi-block turns.
    await Promise.all(blocks.map((text, i) =>
      postEvent(sidecar, {
        sessionId: sidecar.sessionId,
        kind:      'chat',
        type:      'assistant_text',
        payload:   { text, toolUseId },
        ts:        tsAt(i),
      }, 800),
    ));
    return;
  }
  if (hasThinking) {
    await postEvent(sidecar, {
      sessionId: sidecar.sessionId,
      kind:      'chat',
      type:      'assistant_text',
      payload:   {
        text:        '(extended thinking — content not in transcript)',
        toolUseId,
        placeholder: true,
      },
      ts:        tsAt(0),
    }, 800);
  }
}

// PreToolUse: ship every text block Claude wrote in the same
// assistant message BEFORE this tool_use as its own chat/assistant_text
// event. If no text blocks but extended-thinking blocks were present
// (CC strips thinking plaintext on disk; only the signature survives),
// ship a single placeholder so the operator sees a "claude was
// thinking here" marker.
async function shipPreToolAssistantText(
  sidecar: SidecarPayload,
  payload: Record<string, unknown>,
): Promise<void> {
  const parsed = parsePreToolPayload(payload);
  if (!parsed) return;
  const { transcriptPath, toolUseId } = parsed;

  const { messages, foundTarget, retries } = await readTranscriptWithRetry(transcriptPath, toolUseId);
  const blocks = extractTextBlocksBeforeToolUse(messages, toolUseId);
  const hasThinking = blocks.length === 0 ? hasThinkingBlocksBeforeToolUse(messages, toolUseId) : false;

  log.debug('PreToolUse extract', {
    toolUseId:    toolUseId.slice(0, 24),
    messages:     messages.length,
    targetFound:  foundTarget,
    retries,
    blocks:       blocks.length,
    placeholder:  hasThinking,
  });

  await postPreToolAssistantBlocks(sidecar, blocks, hasThinking, toolUseId);
}

// Read stdin → echo to stdout (preserve CC hook chain) → parse JSON.
// Falls back to a {rawStdin} record if the payload doesn't parse so
// the operator still sees something on the wire.
async function readAndEchoHookPayload(): Promise<Record<string, unknown>> {
  const stdinRaw = await readStdin();
  // Always echo stdin so Claude's hook chain sees the original payload.
  if (stdinRaw) process.stdout.write(stdinRaw);

  let payload: Record<string, unknown> = {};
  try {
    if (stdinRaw.trim()) payload = JSON.parse(stdinRaw);
  } catch {
    payload = { rawStdin: stdinRaw.slice(0, 2000) };
  }
  return payload;
}

// Stop-specific pre-event handler: enrich + ship chat/reply if a real
// final-answer text was recovered. The tail Stop event posted by the
// caller marks the turn boundary independently.
async function runStop(sidecar: SidecarPayload, payload: Record<string, unknown>): Promise<void> {
  await enrichStopAssistantText(payload, 'Stop');
  const reply = typeof payload.assistant_text === 'string' ? payload.assistant_text.trim() : '';
  if (!reply) return;
  await postEvent(sidecar, {
    sessionId: sidecar.sessionId,
    kind:      'chat',
    type:      'reply',
    payload:   { text: reply },
    ts:        new Date().toISOString(),
  }, 2000);
}

// Per-hook pre-enrichment dispatch. Mutates payload in place where
// the variant needs to (Stop's assistant_text path) and may emit
// chat-lane events. SubagentStop intentionally does NOTHING here —
// see comment below; we only record the tail event.
async function dispatchHookEnrichment(
  hookName: string,
  sidecar: SidecarPayload,
  payload: Record<string, unknown>,
): Promise<void> {
  if (hookName === 'Stop') {
    // Real turn end — extract final answer + ship chat/reply so
    // attached operators see Claude's response in the chat lane.
    // The tail Stop event below marks the boundary.
    await runStop(sidecar, payload);
    return;
  }
  if (hookName === 'SubagentStop') {
    // A Task-tool subagent finished. NOT a final-answer event — the
    // parent agent is still running and will fire its own Stop later.
    // Some CC versions populate `last_assistant_message` with the
    // subagent's INPUT prompt rather than its reply, which previously
    // surfaced as a misleading chat/reply row. We still record the
    // tail event below for activity-lane visibility, but skip the
    // chat/reply ship entirely.
    return;
  }
  if (hookName === 'PreToolUse') {
    await shipPreToolAssistantText(sidecar, payload);
  }
}

export async function runHook(hookName: string): Promise<void> {
  const map = HOOK_TO_EVENT[hookName];
  if (!map) {
    log.warn('unknown hook name; skipping', { hookName });
    process.exit(0);
  }

  const payload = await readAndEchoHookPayload();

  const sidecar: SidecarPayload | null = findSidecar(process.cwd());
  if (!sidecar) {
    log.warn('hook fired but no sidecar found — channel must not be running', { cwd: process.cwd() });
    process.exit(0);
  }

  try {
    await dispatchHookEnrichment(hookName, sidecar, payload);
  } catch (e: any) {
    log.warn('pre-event enrichment threw', { error: e?.message ?? String(e), hookName });
  }

  // Main hook event POST.
  await postEvent(sidecar, {
    sessionId: sidecar.sessionId,
    kind:      map.kind,
    type:      map.type,
    payload,
    ts:        new Date().toISOString(),
  }, 5000);

  process.exit(0);
}

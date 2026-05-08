// Tail-read and parse Claude Code's per-project JSONL transcript.
// Used by the hook subprocess to recover assistant text + extended-
// thinking presence at hook-fire time, since CC's hook payload alone
// doesn't carry that.
//
// Ported (with light edits for TS) from the original
// clawborrator-channel package's hook-template.mjs. Battle-tested
// against multi-MB transcripts; tail size is 256 KB by default which
// is enough to cover several recent turns even on tool-heavy sessions.

import { openSync, readSync, closeSync, statSync } from 'node:fs';

export interface TranscriptMessage {
  type?: 'assistant' | 'user' | string;
  message?: { content?: ContentBlock[] };
  [k: string]: unknown;
}

export interface ContentBlock {
  type?: 'text' | 'thinking' | 'tool_use' | 'tool_result' | string;
  text?: string;
  id?:   string;
  [k: string]: unknown;
}

export const DEFAULT_TAIL_BYTES = 256 * 1024;

// Read the trailing portion of a Claude Code transcript JSONL and
// return parsed messages oldest-first. A partial first line (the tail
// boundary cuts mid-record) is dropped.
export function readTranscriptMessages(path: string, tailBytes: number = DEFAULT_TAIL_BYTES): TranscriptMessage[] {
  try {
    const stat = statSync(path);
    const start = Math.max(0, stat.size - tailBytes);
    const fd = openSync(path, 'r');
    let raw: string;
    try {
      const buf = Buffer.alloc(stat.size - start);
      readSync(fd, buf, 0, buf.length, start);
      raw = buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
    if (!raw) return [];
    const lines = raw.split('\n').filter(Boolean);
    if (start > 0 && lines.length > 0) lines.shift(); // partial first line
    return lines
      .map((l) => { try { return JSON.parse(l) as TranscriptMessage; } catch { return null; } })
      .filter((m): m is TranscriptMessage => m !== null);
  } catch {
    return [];
  }
}

// Find the index of the assistant message whose content[] holds the
// tool_use with the given id. Returns -1 if not present (e.g. CC
// hasn't flushed the deciding assistant message to disk yet).
function findToolUseIndex(messages: TranscriptMessage[], toolUseId: string): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.type !== 'assistant') continue;
    const content = m.message?.content;
    if (!Array.isArray(content)) continue;
    if (content.some((c) => c?.type === 'tool_use' && c.id === toolUseId)) return i;
  }
  return -1;
}

// Walk backward from `startIdx-1` through preceding assistant
// messages, stopping at the first `user` boundary. For each
// assistant message, invoke `visit(content)` — visit returns true to
// short-circuit (used by the thinking-presence check). Returns
// whether visit ever returned true.
function walkAssistantBlocksBefore(
  messages: TranscriptMessage[],
  startIdx: number,
  visit: (content: ContentBlock[]) => boolean,
): boolean {
  for (let i = startIdx - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.type === 'user') break;
    if (m?.type !== 'assistant') continue;
    const content = m.message?.content;
    if (!Array.isArray(content)) continue;
    if (visit(content)) return true;
  }
  return false;
}

// Pull text blocks Claude wrote between the prior tool turn and the
// tool_use about to fire. CC stores each content-block kind in its
// own assistant message in the transcript JSONL — even though the
// API allows mixed content arrays, CC's recording splits them:
// assistant→text, assistant→thinking, assistant→tool_use,
// user→tool_result, assistant→text, ...
//
// Algorithm: find the assistant message that contains this tool_use,
// then walk BACKWARD through preceding assistant messages collecting
// text blocks. Stop at the first `user` message. Returns text blocks
// in chronological order (oldest first).
export function extractTextBlocksBeforeToolUse(
  messages: TranscriptMessage[],
  toolUseId: string,
): string[] {
  if (!toolUseId || !Array.isArray(messages)) return [];
  const targetIdx = findToolUseIndex(messages, toolUseId);
  if (targetIdx < 0) return [];

  const out: string[] = [];
  walkAssistantBlocksBefore(messages, targetIdx, (content) => {
    // Walk THIS message's content array backward; unshift to keep the
    // final list in chronological order.
    for (let j = content.length - 1; j >= 0; j--) {
      const c = content[j];
      if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
        out.unshift(c.text);
      }
    }
    return false;
  });
  return out;
}

// Quick presence check used by the PreToolUse race-retry loop.
// CC emits PreToolUse before fully flushing the assistant message
// that decided the tool_use to disk; we retry until we see it (or
// give up).
export function messageContainsToolUse(messages: TranscriptMessage[], toolUseId: string): boolean {
  if (!toolUseId || !Array.isArray(messages)) return false;
  return findToolUseIndex(messages, toolUseId) >= 0;
}

// Same walk-back as extractTextBlocksBeforeToolUse, but returns true
// iff any thinking block exists between the prior user-message
// boundary and the target tool_use. Used to emit a placeholder
// "claude was thinking here" event when extended thinking happened
// but the plaintext wasn't persisted (CC strips it on disk; only the
// signature survives).
export function hasThinkingBlocksBeforeToolUse(
  messages: TranscriptMessage[],
  toolUseId: string,
): boolean {
  if (!toolUseId || !Array.isArray(messages)) return false;
  const targetIdx = findToolUseIndex(messages, toolUseId);
  if (targetIdx < 0) return false;
  return walkAssistantBlocksBefore(messages, targetIdx, (content) =>
    content.some((c) => c?.type === 'thinking'),
  );
}

// Walk a content array and return joined text from blocks AFTER the
// last tool_use. If no tool_use in the array, returns all text blocks
// joined. Used by Stop hook extraction to avoid double-shipping text
// that PreToolUse already shipped as intermediate AssistantText.
export function joinTextAfterLastToolUse(content: ContentBlock[] | unknown): string {
  if (!Array.isArray(content)) return '';
  let lastToolIdx = -1;
  for (let j = content.length - 1; j >= 0; j--) {
    if (content[j]?.type === 'tool_use') { lastToolIdx = j; break; }
  }
  const parts = content.slice(lastToolIdx + 1)
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string);
  return parts.join('\n').trim();
}

// Pull the FINAL-ANSWER text out of whatever shape CC hands us as
// `last_assistant_message` on Stop / SubagentStop. Documented as
// missing from the official input schema (CC issue #26710) so the
// shape drifts across versions.
export function extractFromLastAssistantMessage(v: unknown): string {
  if (!v) return '';
  if (typeof v === 'string') return v.trim();
  const obj = v as Record<string, unknown>;
  const content = Array.isArray(obj.content)                                        ? obj.content
                : (obj.message && Array.isArray((obj.message as { content?: unknown }).content)) ? (obj.message as { content: ContentBlock[] }).content
                : null;
  if (content) return joinTextAfterLastToolUse(content);
  if (typeof obj.text === 'string') return obj.text.trim();
  return '';
}

// Extract the final-answer assistant text from a transcript, given
// only the path. Walks backward to the LAST assistant message,
// returns trailing text blocks (after the last tool_use). Used by
// the Stop hook fallback when payload.last_assistant_message is
// absent or empty.
export function extractFinalAnswerFromTranscript(path: string, tailBytes: number = DEFAULT_TAIL_BYTES): string {
  const messages = readTranscriptMessages(path, tailBytes);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.type !== 'assistant') continue;
    const content = m.message?.content;
    if (!Array.isArray(content)) continue;
    const joined = joinTextAfterLastToolUse(content);
    if (joined) return joined;
  }
  return '';
}

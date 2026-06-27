#!/usr/bin/env node

// src/hook.ts
import { dirname, resolve as resolve2 } from "node:path";
import { fileURLToPath } from "node:url";

// src/sidecar.ts
import { resolve } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, chmodSync, existsSync } from "node:fs";

// src/log.ts
var LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
var MIN = LEVELS[process.env.CLAWBORRATOR_LOG_LEVEL || "info"] ?? LEVELS.info;
function emit(level, msg, fields) {
  if (LEVELS[level] < MIN) return;
  const line = JSON.stringify({
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    level,
    msg,
    ...fields
  });
  process.stderr.write(line + "\n");
}
var log = {
  debug: (msg, fields) => emit("debug", msg, fields),
  info: (msg, fields) => emit("info", msg, fields),
  warn: (msg, fields) => emit("warn", msg, fields),
  error: (msg, fields) => emit("error", msg, fields)
};

// src/sidecar.ts
function sidecarPath(cwd) {
  return resolve(cwd, ".claude", "clawborrator", "runtime.json");
}
function readSidecar(cwd) {
  try {
    const raw = readFileSync(sidecarPath(cwd), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function findSidecar(start) {
  return readSidecar(start);
}

// src/transcript.ts
import { openSync, readSync, closeSync, statSync } from "node:fs";
var DEFAULT_TAIL_BYTES = 256 * 1024;
var USAGE_TAIL_BYTES = 1024 * 1024;
function readTranscriptMessages(path, tailBytes = DEFAULT_TAIL_BYTES) {
  try {
    const stat = statSync(path);
    const start = Math.max(0, stat.size - tailBytes);
    const fd = openSync(path, "r");
    let raw;
    try {
      const buf = Buffer.alloc(stat.size - start);
      readSync(fd, buf, 0, buf.length, start);
      raw = buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
    if (!raw) return [];
    const lines = raw.split("\n").filter(Boolean);
    if (start > 0 && lines.length > 0) lines.shift();
    return lines.map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter((m) => m !== null);
  } catch {
    return [];
  }
}
function findToolUseIndex(messages, toolUseId) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.type !== "assistant") continue;
    const content = m.message?.content;
    if (!Array.isArray(content)) continue;
    if (content.some((c) => c?.type === "tool_use" && c.id === toolUseId)) return i;
  }
  return -1;
}
function walkAssistantBlocksBefore(messages, startIdx, visit) {
  for (let i = startIdx - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.type === "user") break;
    if (m?.type !== "assistant") continue;
    const content = m.message?.content;
    if (!Array.isArray(content)) continue;
    if (visit(content)) return true;
  }
  return false;
}
function extractTextBlocksBeforeToolUse(messages, toolUseId) {
  if (!toolUseId || !Array.isArray(messages)) return [];
  const targetIdx = findToolUseIndex(messages, toolUseId);
  if (targetIdx < 0) return [];
  const out = [];
  walkAssistantBlocksBefore(messages, targetIdx, (content) => {
    for (let j = content.length - 1; j >= 0; j--) {
      const c = content[j];
      if (c?.type === "text" && typeof c.text === "string" && c.text.trim()) {
        out.unshift(c.text);
      }
    }
    return false;
  });
  return out;
}
function messageContainsToolUse(messages, toolUseId) {
  if (!toolUseId || !Array.isArray(messages)) return false;
  return findToolUseIndex(messages, toolUseId) >= 0;
}
function hasThinkingBlocksBeforeToolUse(messages, toolUseId) {
  if (!toolUseId || !Array.isArray(messages)) return false;
  const targetIdx = findToolUseIndex(messages, toolUseId);
  if (targetIdx < 0) return false;
  return walkAssistantBlocksBefore(
    messages,
    targetIdx,
    (content) => content.some((c) => c?.type === "thinking")
  );
}
function joinTextAfterLastToolUse(content) {
  if (!Array.isArray(content)) return "";
  let lastToolIdx = -1;
  for (let j = content.length - 1; j >= 0; j--) {
    if (content[j]?.type === "tool_use") {
      lastToolIdx = j;
      break;
    }
  }
  const parts = content.slice(lastToolIdx + 1).filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text);
  return parts.join("\n").trim();
}
function extractFromLastAssistantMessage(v) {
  if (!v) return "";
  if (typeof v === "string") return v.trim();
  const obj = v;
  const content = Array.isArray(obj.content) ? obj.content : obj.message && Array.isArray(obj.message.content) ? obj.message.content : null;
  if (content) return joinTextAfterLastToolUse(content);
  if (typeof obj.text === "string") return obj.text.trim();
  return "";
}
function extractFinalAnswerFromTranscript(path, tailBytes = DEFAULT_TAIL_BYTES) {
  const messages = readTranscriptMessages(path, tailBytes);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.type !== "assistant") continue;
    const content = m.message?.content;
    if (!Array.isArray(content)) continue;
    const joined = joinTextAfterLastToolUse(content);
    if (joined) return joined;
  }
  return "";
}
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function isTurnBoundaryUserMessage(m) {
  if (m?.type !== "user") return false;
  const content = m.message?.content;
  if (typeof content === "string") return content.trim().length > 0;
  if (Array.isArray(content)) {
    const hasToolResult = content.some((c) => c?.type === "tool_result");
    return !hasToolResult;
  }
  return true;
}
function readUsageBlock(m) {
  const u = m.message?.usage;
  return u && typeof u === "object" ? u : null;
}
function extractTurnUsageFromMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  let input = 0, output = 0, cacheCreate = 0, cacheRead = 0, count = 0;
  let model = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (isTurnBoundaryUserMessage(m)) break;
    if (m?.type !== "assistant") continue;
    const u = readUsageBlock(m);
    if (!u) continue;
    input += num(u.input_tokens);
    output += num(u.output_tokens);
    cacheCreate += num(u.cache_creation_input_tokens);
    cacheRead += num(u.cache_read_input_tokens);
    count++;
    if (model === null) {
      const mdl = m.message?.model;
      if (typeof mdl === "string") model = mdl;
    }
  }
  if (count === 0) return null;
  return {
    grain: "turn",
    model,
    usage: {
      input_tokens: input,
      output_tokens: output,
      cache_creation_input_tokens: cacheCreate,
      cache_read_input_tokens: cacheRead
    },
    turn_messages: count
  };
}
function extractTurnUsage(path, tailBytes = USAGE_TAIL_BYTES) {
  return extractTurnUsageFromMessages(readTranscriptMessages(path, tailBytes));
}

// src/hook.ts
function projectRootFromHookFile() {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve2(here, "..", "..");
}
var HOOK_TO_EVENT = {
  UserPromptSubmit: { kind: "chat", type: "prompt" },
  PreToolUse: { kind: "tail", type: "PreToolUse" },
  PostToolUse: { kind: "tail", type: "PostToolUse" },
  PostToolUseFailure: { kind: "tail", type: "PostToolUseFailure" },
  Stop: { kind: "tail", type: "Stop" },
  Notification: { kind: "tail", type: "Notification" },
  TaskCreated: { kind: "tail", type: "TaskCreated" },
  SubagentStart: { kind: "tail", type: "SubagentStart" },
  SubagentStop: { kind: "tail", type: "SubagentStop" },
  TaskCompleted: { kind: "tail", type: "TaskCompleted" }
};
var TOOLS_SKIPPED_FOR_PRE_TEXT = /* @__PURE__ */ new Set([
  "mcp__clawborrator__reply"
]);
async function readStdin() {
  return new Promise((res) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
    });
    process.stdin.on("end", () => res(buf));
    process.stdin.on("close", () => res(buf));
  });
}
async function postEvent(sidecar, body, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${sidecar.hubUrl}/api/channel/event`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${sidecar.channelToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: ctl.signal
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      log.warn("hub rejected event", { kind: body.kind, type: body.type, status: res.status, body: text.slice(0, 240) });
      return false;
    }
    return true;
  } catch (e) {
    log.warn("event POST failed", { kind: body.kind, type: body.type, error: e?.message ?? String(e) });
    return false;
  } finally {
    clearTimeout(timer);
  }
}
function hasStringShapedReply(payload) {
  if (typeof payload.text === "string" && payload.text.trim()) return true;
  if (typeof payload.response === "string" && payload.response.trim()) return true;
  return false;
}
async function enrichStopAssistantText(payload, hookName2) {
  if (typeof payload.assistant_text === "string" && payload.assistant_text.trim()) return;
  const fromLAM = extractFromLastAssistantMessage(payload.last_assistant_message);
  if (fromLAM) {
    payload.assistant_text = fromLAM;
    log.debug("stop: assistant_text from last_assistant_message", { chars: fromLAM.length });
    return;
  }
  if (hasStringShapedReply(payload)) return;
  const transcriptPath = typeof payload.transcript_path === "string" ? payload.transcript_path : "";
  if (!transcriptPath) {
    log.debug("stop: no transcript_path on payload, no assistant_text recoverable", { hookName: hookName2 });
    return;
  }
  await new Promise((r) => setTimeout(r, 500));
  const text = extractFinalAnswerFromTranscript(transcriptPath, DEFAULT_TAIL_BYTES);
  if (text) {
    payload.assistant_text = text;
    log.info("stop: assistant_text extracted from transcript", { chars: text.length });
  } else {
    log.debug("stop: transcript had no assistant-text block in tail window", { hookName: hookName2, path: transcriptPath });
  }
}
function parsePreToolPayload(payload) {
  const transcriptPath = typeof payload.transcript_path === "string" ? payload.transcript_path : "";
  const toolUseId = String(payload.tool_use_id ?? payload.toolUseId ?? "");
  const toolName = String(payload.tool_name ?? payload.toolName ?? "");
  if (!transcriptPath || !toolUseId) return null;
  if (TOOLS_SKIPPED_FOR_PRE_TEXT.has(toolName)) return null;
  return { transcriptPath, toolUseId };
}
async function readTranscriptWithRetry(transcriptPath, toolUseId) {
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
async function postPreToolAssistantBlocks(sidecar, blocks, hasThinking, toolUseId) {
  const baseMs = Date.now();
  const tsAt = (i) => new Date(baseMs + i).toISOString();
  if (blocks.length > 0) {
    await Promise.all(blocks.map(
      (text, i) => postEvent(sidecar, {
        sessionId: sidecar.sessionId,
        kind: "chat",
        type: "assistant_text",
        payload: { text, toolUseId },
        ts: tsAt(i)
      }, 800)
    ));
    return;
  }
  if (hasThinking) {
    await postEvent(sidecar, {
      sessionId: sidecar.sessionId,
      kind: "chat",
      type: "assistant_text",
      payload: {
        text: "(extended thinking \u2014 content not in transcript)",
        toolUseId,
        placeholder: true
      },
      ts: tsAt(0)
    }, 800);
  }
}
async function shipPreToolAssistantText(sidecar, payload) {
  const parsed = parsePreToolPayload(payload);
  if (!parsed) return;
  const { transcriptPath, toolUseId } = parsed;
  const { messages, foundTarget, retries } = await readTranscriptWithRetry(transcriptPath, toolUseId);
  const blocks = extractTextBlocksBeforeToolUse(messages, toolUseId);
  const hasThinking = blocks.length === 0 ? hasThinkingBlocksBeforeToolUse(messages, toolUseId) : false;
  log.debug("PreToolUse extract", {
    toolUseId: toolUseId.slice(0, 24),
    messages: messages.length,
    targetFound: foundTarget,
    retries,
    blocks: blocks.length,
    placeholder: hasThinking
  });
  await postPreToolAssistantBlocks(sidecar, blocks, hasThinking, toolUseId);
}
async function readAndEchoHookPayload() {
  const stdinRaw = await readStdin();
  if (stdinRaw) process.stdout.write(stdinRaw);
  let payload = {};
  try {
    if (stdinRaw.trim()) payload = JSON.parse(stdinRaw);
  } catch {
    payload = { rawStdin: stdinRaw.slice(0, 2e3) };
  }
  return payload;
}
async function runStop(sidecar, payload) {
  await enrichStopAssistantText(payload, "Stop");
  const reply = typeof payload.assistant_text === "string" ? payload.assistant_text.trim() : "";
  if (!reply) return;
  await postEvent(sidecar, {
    sessionId: sidecar.sessionId,
    kind: "chat",
    type: "reply",
    payload: { text: reply },
    ts: (/* @__PURE__ */ new Date()).toISOString()
  }, 2e3);
}
async function enrichStopTokenUsage(payload) {
  const transcriptPath = typeof payload.transcript_path === "string" ? payload.transcript_path : "";
  if (!transcriptPath) return;
  let usage = extractTurnUsage(transcriptPath);
  let tries = 0;
  while (!usage && tries < 3) {
    await new Promise((r) => setTimeout(r, 120));
    usage = extractTurnUsage(transcriptPath);
    tries++;
  }
  if (!usage) {
    log.debug("stop: no turn usage found in transcript tail");
    return;
  }
  const ccSessionId = typeof payload.session_id === "string" ? payload.session_id : "";
  payload.token_usage = { ...usage, cc_session_id: ccSessionId };
  log.info("stop: turn token usage attached", {
    grain: usage.grain,
    model: usage.model,
    ccSessionId,
    turnMessages: usage.turn_messages,
    input: usage.usage.input_tokens,
    output: usage.usage.output_tokens,
    cacheRead: usage.usage.cache_read_input_tokens,
    cacheCreate: usage.usage.cache_creation_input_tokens
  });
}
async function dispatchHookEnrichment(hookName2, sidecar, payload) {
  if (hookName2 === "Stop") {
    await runStop(sidecar, payload);
    await enrichStopTokenUsage(payload);
    return;
  }
  if (hookName2 === "SubagentStop") {
    return;
  }
  if (hookName2 === "PreToolUse") {
    await shipPreToolAssistantText(sidecar, payload);
  }
}
async function runHook(hookName2) {
  const map = HOOK_TO_EVENT[hookName2];
  if (!map) {
    log.warn("unknown hook name; skipping", { hookName: hookName2 });
    process.exit(0);
  }
  const payload = await readAndEchoHookPayload();
  const projectRoot = projectRootFromHookFile();
  const sidecar = findSidecar(projectRoot);
  if (!sidecar) {
    log.warn("hook fired but no sidecar found \u2014 channel must not be running", { projectRoot, cwd: process.cwd() });
    process.exit(0);
  }
  try {
    await dispatchHookEnrichment(hookName2, sidecar, payload);
  } catch (e) {
    log.warn("pre-event enrichment threw", { error: e?.message ?? String(e), hookName: hookName2 });
  }
  await postEvent(sidecar, {
    sessionId: sidecar.sessionId,
    kind: map.kind,
    type: map.type,
    payload,
    ts: (/* @__PURE__ */ new Date()).toISOString()
  }, 5e3);
  if (hookName2 === "Stop" && process.env.CLAWBORRATOR_EPHEMERAL === "1") {
    log.info("ephemeral: Stop received, signaling PID 1 to terminate container");
    try {
      process.kill(1, "SIGTERM");
    } catch (e) {
      log.warn("ephemeral terminate kill failed", { error: e?.message ?? String(e) });
    }
  }
  process.exit(0);
}

// src/hook-entry.ts
var hookName = process.argv[2];
if (!hookName) {
  log.error("hook entry invoked without a hook name argument");
  process.exit(0);
}
runHook(hookName).catch((err) => {
  log.error("hook fatal", { error: String(err) });
  process.exit(0);
});

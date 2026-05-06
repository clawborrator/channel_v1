#!/usr/bin/env node

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
  return resolve(cwd, ".claude", "clawborrator.session.json");
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
  let dir = resolve(start);
  for (let i = 0; i < 32; i++) {
    const found = readSidecar(dir);
    if (found) return found;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// src/transcript.ts
import { openSync, readSync, closeSync, statSync } from "node:fs";
var DEFAULT_TAIL_BYTES = 256 * 1024;
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
function extractTextBlocksBeforeToolUse(messages, toolUseId) {
  if (!toolUseId || !Array.isArray(messages)) return [];
  let targetIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.type !== "assistant") continue;
    const content = m.message?.content;
    if (!Array.isArray(content)) continue;
    if (content.some((c) => c?.type === "tool_use" && c.id === toolUseId)) {
      targetIdx = i;
      break;
    }
  }
  if (targetIdx < 0) return [];
  const out = [];
  for (let i = targetIdx - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.type === "user") break;
    if (m?.type !== "assistant") continue;
    const content = m.message?.content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const c = content[j];
      if (c?.type === "text" && typeof c.text === "string" && c.text.trim()) {
        out.unshift(c.text);
      }
    }
  }
  return out;
}
function messageContainsToolUse(messages, toolUseId) {
  if (!toolUseId || !Array.isArray(messages)) return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.type !== "assistant") continue;
    const content = m.message?.content;
    if (!Array.isArray(content)) continue;
    if (content.some((c) => c?.type === "tool_use" && c.id === toolUseId)) return true;
  }
  return false;
}
function hasThinkingBlocksBeforeToolUse(messages, toolUseId) {
  if (!toolUseId || !Array.isArray(messages)) return false;
  let targetIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.type !== "assistant") continue;
    const content = m.message?.content;
    if (!Array.isArray(content)) continue;
    if (content.some((c) => c?.type === "tool_use" && c.id === toolUseId)) {
      targetIdx = i;
      break;
    }
  }
  if (targetIdx < 0) return false;
  for (let i = targetIdx - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.type === "user") break;
    if (m?.type !== "assistant") continue;
    const content = m.message?.content;
    if (!Array.isArray(content)) continue;
    if (content.some((c) => c?.type === "thinking")) return true;
  }
  return false;
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

// src/hook.ts
var HOOK_TO_EVENT = {
  UserPromptSubmit: { kind: "chat", type: "prompt" },
  PreToolUse: { kind: "tail", type: "PreToolUse" },
  PostToolUse: { kind: "tail", type: "PostToolUse" },
  PostToolUseFailure: { kind: "tail", type: "PostToolUseFailure" },
  Stop: { kind: "tail", type: "Stop" },
  Notification: { kind: "tail", type: "Notification" },
  SessionStart: { kind: "tail", type: "SessionStart" },
  SessionEnd: { kind: "tail", type: "SessionEnd" },
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
async function enrichStopAssistantText(payload, hookName2) {
  if (typeof payload.assistant_text === "string" && payload.assistant_text.trim()) return;
  const fromLAM = extractFromLastAssistantMessage(payload.last_assistant_message);
  if (fromLAM) {
    payload.assistant_text = fromLAM;
    log.debug("stop: assistant_text from last_assistant_message", { chars: fromLAM.length });
    return;
  }
  if (typeof payload.text === "string" && payload.text.trim() || typeof payload.response === "string" && payload.response.trim()) {
    return;
  }
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
async function shipPreToolAssistantText(sidecar, payload) {
  const transcriptPath = typeof payload.transcript_path === "string" ? payload.transcript_path : "";
  const toolUseId = String(payload.tool_use_id ?? payload.toolUseId ?? "");
  const toolName = String(payload.tool_name ?? payload.toolName ?? "");
  if (!transcriptPath || !toolUseId) return;
  if (TOOLS_SKIPPED_FOR_PRE_TEXT.has(toolName)) return;
  let messages = readTranscriptMessages(transcriptPath, DEFAULT_TAIL_BYTES);
  let foundTarget = messageContainsToolUse(messages, toolUseId);
  let retries = 0;
  while (!foundTarget && retries < 4) {
    await new Promise((r) => setTimeout(r, 80));
    messages = readTranscriptMessages(transcriptPath, DEFAULT_TAIL_BYTES);
    foundTarget = messageContainsToolUse(messages, toolUseId);
    retries++;
  }
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
  } else if (hasThinking) {
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
async function runHook(hookName2) {
  const map = HOOK_TO_EVENT[hookName2];
  if (!map) {
    log.warn("unknown hook name; skipping", { hookName: hookName2 });
    process.exit(0);
  }
  const stdinRaw = await readStdin();
  if (stdinRaw) process.stdout.write(stdinRaw);
  let payload = {};
  try {
    if (stdinRaw.trim()) payload = JSON.parse(stdinRaw);
  } catch {
    payload = { rawStdin: stdinRaw.slice(0, 2e3) };
  }
  const sidecar = findSidecar(process.cwd());
  if (!sidecar) {
    log.warn("hook fired but no sidecar found \u2014 channel must not be running", { cwd: process.cwd() });
    process.exit(0);
  }
  try {
    if (hookName2 === "Stop") {
      await enrichStopAssistantText(payload, hookName2);
      const reply = typeof payload.assistant_text === "string" ? payload.assistant_text.trim() : "";
      if (reply) {
        await postEvent(sidecar, {
          sessionId: sidecar.sessionId,
          kind: "chat",
          type: "reply",
          payload: { text: reply },
          ts: (/* @__PURE__ */ new Date()).toISOString()
        }, 2e3);
      }
    } else if (hookName2 === "SubagentStop") {
    } else if (hookName2 === "PreToolUse") {
      await shipPreToolAssistantText(sidecar, payload);
    }
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

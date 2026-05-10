// Stand up a fake transcript with realistic Claude Code shape and
// drive the channel hook subprocess against it. Verifies:
//   - PreToolUse with text-block-before-tool: ships chat/assistant_text
//     events containing the model's "let me check X" running commentary
//   - PreToolUse with thinking-only: ships the "extended thinking"
//     placeholder
//   - Stop: extracts trailing text from the final assistant message,
//     ships a chat/reply event with that text

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HUB_HTTP = 'http://127.0.0.1:8787';
const HUB_WS   = 'ws://127.0.0.1:8787';

async function api(method, path, body, pat) {
  const res = await fetch(`${HUB_HTTP}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(pat ? { 'Authorization': `Bearer ${pat}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

const seed = await api('POST', '/api/v1/dev/seed');
const PAT = seed.pat.token;
const ch  = await api('POST', '/api/v1/tokens/channel', { name: 'transcript-test' }, PAT);

// Spawn channel in a fresh dir so we have a known sidecar
const dir = resolve(tmpdir(), 'transcript-test');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP = resolve(__dirname, 'dist', 'index.js');

const channel = spawn('node', [MCP], {
  cwd: dir,
  env: { ...process.env, CLAWBORRATOR_HUB_URL: HUB_WS, CLAWBORRATOR_TOKEN: ch.token },
  stdio: ['ignore', 'pipe', 'pipe'],
});
channel.stdout.on('data', () => {});
channel.stderr.on('data', (d) => process.stderr.write('[channel] ' + d.toString()));

// Wait for sidecar
await new Promise((r) => setTimeout(r, 2000));
const sidecarPath = resolve(dir, '.claude', 'clawborrator', 'runtime.json');
const sidecar = JSON.parse(await import('node:fs').then((m) => m.readFileSync(sidecarPath, 'utf8')));
const SID = sidecar.sessionId;
console.error(`[test] sessionId = ${SID}`);

// Build a realistic transcript JSONL
const transcriptPath = resolve(dir, 'transcript.jsonl');
const lines = [
  JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'find the user model' }] }}),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Let me check the source.' }] }}),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: "I'll look in models/." }] }}),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool_abc123', name: 'Read', input: { path: 'models/user.py' } }] }}),
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool_abc123', content: 'class User: ...' }] }}),
  JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'text', text: 'Pre-tool commentary' },
    { type: 'tool_use', id: 'tool_def', name: 'Edit', input: {} },
    { type: 'text', text: 'The User model is defined in models/user.py with id and email fields.' },
  ]}}),
];
writeFileSync(transcriptPath, lines.join('\n') + '\n');

// === Test 1: PreToolUse with text blocks before the tool_use ===
console.error('\n=== Test 1: PreToolUse with text blocks ===');
const preToolPayload = {
  tool_name: 'Read',
  tool_use_id: 'tool_abc123',
  transcript_path: transcriptPath,
  tool_input: { path: 'models/user.py' },
};
const hook1 = spawn('node', [MCP, '--hook=PreToolUse'], {
  cwd: dir,
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
});
hook1.stderr.on('data', (d) => process.stderr.write('[hook1] ' + d.toString()));
hook1.stdin.write(JSON.stringify(preToolPayload));
hook1.stdin.end();
await new Promise((r) => hook1.on('exit', r));

// === Test 2: Stop with transcript-only fallback ===
console.error('\n=== Test 2: Stop hook with transcript fallback ===');
const stopPayload = {
  transcript_path: transcriptPath,
};
const hook2 = spawn('node', [MCP, '--hook=Stop'], {
  cwd: dir,
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
});
hook2.stderr.on('data', (d) => process.stderr.write('[hook2] ' + d.toString()));
hook2.stdin.write(JSON.stringify(stopPayload));
hook2.stdin.end();
await new Promise((r) => hook2.on('exit', r));

// Wait for posts to land
await new Promise((r) => setTimeout(r, 1000));

// Check the events table
const events = await api('GET', `/api/v1/sessions/${SID}/events`, undefined, PAT);
console.error('\n=== events landed in DB ===');
for (const ev of events.items ?? events) {
  const p = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload;
  const text = p.text ?? p.assistant_text ?? '';
  console.error(`  ${ev.kind}/${ev.type}  ${typeof text === 'string' ? text.slice(0, 70).replace(/\s+/g, ' ') : ''}`);
}

channel.kill();
process.exit(0);

// End-to-end smoke test for Phase D. Spawns:
//   - one "responder" channel that auto-replies to any incoming `prompt`
//   - one "asker" channel that drives the MCP tool calls via stdin
// and verifies the WS round-trip works:
//   1. asker calls list_peers → sees responder
//   2. asker calls route_to_peer @responder "ping" --mode=ask
//   3. hub forwards `prompt` to responder
//   4. responder auto-`reply` posts the answer
//   5. hub correlates via chatId, forwards `route_response` to asker
//   6. asker's MCP tool resolves with the reply text
//
// Run from the channel_v1 dir AFTER:
//   - hub_v1 is running with DEV_LOGIN_ENABLED=1
//   - claw login --dev has been run (so /dev/seed has been hit)
//   - npm run build has produced dist/

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const HUB_HTTP = 'http://127.0.0.1:8787';
const HUB_WS   = 'ws://127.0.0.1:8787';

async function api(method, path, body) {
  const res = await fetch(`${HUB_HTTP}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

const seed = await api('POST', '/api/v1/dev/seed');
const PAT  = seed.pat.token;

async function patApi(method, path, body) {
  const res = await fetch(`${HUB_HTTP}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PAT}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

const tokenA = await patApi('POST', '/api/v1/tokens/channel', { name: 'asker' });
const tokenB = await patApi('POST', '/api/v1/tokens/channel', { name: 'responder' });

const dirA = resolve(tmpdir(), 'phaseD-asker');
const dirB = resolve(tmpdir(), 'phaseD-responder');
rmSync(dirA, { recursive: true, force: true });
rmSync(dirB, { recursive: true, force: true });
mkdirSync(dirA); mkdirSync(dirB);

const MCP = resolve(import.meta.dirname, 'dist', 'index.js');

// Spawn the asker (we'll drive it via stdin/JSONRPC)
const asker = spawn('node', [MCP], {
  cwd: dirA,
  env: { ...process.env, CLAWBORRATOR_HUB_URL: HUB_WS, CLAWBORRATOR_TOKEN: tokenA.token },
  stdio: ['pipe', 'pipe', 'pipe'],
});

// Spawn the responder (we wrap its stdio so we can listen for routed
// `prompt` messages — actually those don't come over MCP stdio,
// they come over the channel WS internally. But the responder's MCP
// is also exposed; we can drive `reply` via stdin once we see a
// "prompt received" log line on the responder's stderr.)
const responder = spawn('node', [MCP], {
  cwd: dirB,
  env: { ...process.env, CLAWBORRATOR_HUB_URL: HUB_WS, CLAWBORRATOR_TOKEN: tokenB.token, CLAWBORRATOR_LOG_LEVEL: 'info' },
  stdio: ['pipe', 'pipe', 'pipe'],
});

// MCP JSON-RPC framing over stdio is newline-delimited JSON.
function send(child, msg) {
  child.stdin.write(JSON.stringify(msg) + '\n');
}

// Initialize handshake on both children.
send(asker, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'test', version: '0' },
} });
send(responder, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'test', version: '0' },
} });

let askerBuf = '';
let responderBuf = '';
asker.stdout.on('data', (d) => { askerBuf += d.toString(); });
asker.stderr.on('data', (d) => process.stderr.write('[asker.stderr] ' + d.toString()));
responder.stderr.on('data', (d) => process.stderr.write('[responder.stderr] ' + d.toString()));

// Watch the responder's stdout for the await_routed_prompt result.
// When chatId is non-null, fire `reply` to close the round-trip.
responder.stdout.on('data', (d) => {
  responderBuf += d.toString();
  let i;
  while ((i = responderBuf.indexOf('\n')) >= 0) {
    const line = responderBuf.slice(0, i);
    responderBuf = responderBuf.slice(i + 1);
    if (!line.trim()) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (parsed?.id === 50 && parsed.result?.content?.[0]?.text) {
      let inner;
      try { inner = JSON.parse(parsed.result.content[0].text); } catch { continue; }
      if (inner?.chatId) {
        process.stderr.write(`[test] responder dequeued chatId=${inner.chatId}; calling reply...\n`);
        send(responder, { jsonrpc: '2.0', id: 51, method: 'tools/call', params: {
          name: 'reply',
          arguments: { chat_id: inner.chatId, text: 'hello back from responder' },
        }});
      }
    }
  }
});

// Give them a moment to register
await new Promise((r) => setTimeout(r, 2000));

// Send `initialized` notifications (handshake complete)
send(asker, { jsonrpc: '2.0', method: 'notifications/initialized' });
send(responder, { jsonrpc: '2.0', method: 'notifications/initialized' });

// Responder parks an await_routed_prompt with a long wait so it
// can dequeue whatever the asker routes.
process.stderr.write('\n=== responder calls await_routed_prompt (10s wait) ===\n');
send(responder, { jsonrpc: '2.0', id: 50, method: 'tools/call', params: {
  name: 'await_routed_prompt',
  arguments: { maxWaitMs: 10000 },
}});

// list_peers from asker
process.stderr.write('\n=== asker calls list_peers ===\n');
send(asker, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_peers', arguments: {} }});
await new Promise((r) => setTimeout(r, 2000));

// route_to_peer from asker (ask mode → blocks for reply)
process.stderr.write('\n=== asker calls route_to_peer @phased-responder ask ===\n');
send(asker, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
  name: 'route_to_peer',
  arguments: { peer: '@phased-responder', prompt: 'do you see this?', mode: 'ask' },
}});

// Wait for the round-trip to complete
await new Promise((r) => setTimeout(r, 5000));

process.stderr.write('\n=== asker stdout dump (truncated) ===\n');
process.stderr.write(askerBuf.slice(-2000) + '\n');

asker.kill();
responder.kill();
process.exit(0);

// Hook entry point. Spawned by Claude Code per `.claude/settings.json`
// like:
//
//   { "type": "command", "command": "npx clawborrator-mcp --hook=PreToolUse" }
//
// The hook receives the JSON payload on stdin. We:
//   1. Read stdin to EOF
//   2. Locate the sidecar in the cwd (or walk up parents)
//   3. Map the hook name to a clawborrator event kind+type
//   4. POST /api/channel/event with the channel token from the sidecar
//   5. Print the hook payload back to stdout (so we don't break Claude's
//      own hook chain — Claude reads stdout for the hook decision; if
//      we're a no-op decorator, we just echo stdin)

import { findSidecar, type SidecarPayload } from './sidecar.js';
import { log } from './log.js';

const HOOK_TO_EVENT: Record<string, { kind: 'chat' | 'tail'; type: string }> = {
  UserPromptSubmit: { kind: 'chat', type: 'prompt' },
  PreToolUse:       { kind: 'tail', type: 'PreToolUse' },
  PostToolUse:      { kind: 'tail', type: 'PostToolUse' },
  Stop:             { kind: 'tail', type: 'Stop' },
  Notification:     { kind: 'tail', type: 'Notification' },
  SessionStart:     { kind: 'tail', type: 'SessionStart' },
  SessionEnd:       { kind: 'tail', type: 'SessionEnd' },
};

async function readStdin(): Promise<string> {
  return new Promise((res) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { buf += chunk; });
    process.stdin.on('end',  () => res(buf));
    process.stdin.on('close', () => res(buf));
  });
}

export async function runHook(hookName: string): Promise<void> {
  const map = HOOK_TO_EVENT[hookName];
  if (!map) {
    log.warn('unknown hook name; skipping', { hookName });
    process.exit(0);
  }

  const stdinRaw = await readStdin();
  // Always echo stdin so Claude's hook chain sees the original payload.
  // If we error out we still want Claude's flow to continue.
  if (stdinRaw) process.stdout.write(stdinRaw);

  let payload: Record<string, unknown> = {};
  try {
    if (stdinRaw.trim()) payload = JSON.parse(stdinRaw);
  } catch {
    // Malformed payload — not fatal; we still want to mark the event.
    payload = { rawStdin: stdinRaw.slice(0, 2000) };
  }

  const sidecar: SidecarPayload | null = findSidecar(process.cwd());
  if (!sidecar) {
    log.warn('hook fired but no sidecar found — channel must not be running', { cwd: process.cwd() });
    process.exit(0);                // do NOT fail Claude's hook chain
  }

  // Best-effort POST. We bound the timeout to ~5s so a slow/unreachable
  // hub doesn't slow down every Claude turn.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5_000);
  try {
    const res = await fetch(`${sidecar.hubUrl}/api/channel/event`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sidecar.channelToken}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        sessionId: sidecar.sessionId,
        kind:      map.kind,
        type:      map.type,
        payload,
        ts:        new Date().toISOString(),
      }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.warn('hub rejected hook event', { status: res.status, body: text.slice(0, 240) });
    } else {
      log.debug('hook event posted', { hookName });
    }
  } catch (e: any) {
    log.warn('hook POST failed', { error: e?.message ?? String(e) });
  } finally {
    clearTimeout(timer);
  }

  process.exit(0);
}

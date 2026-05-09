// Self-installer for Claude Code hook config + the bundled hook
// entry. Called once per long-lived MCP startup. Idempotent —
// touches files only when the desired state differs from what's on
// disk, so re-launches don't churn mtimes or git diffs.
//
// Two artifacts maintained:
//   1. <cwd>/.claude/hooks/clawborrator-tail.mjs — bytewise copy of
//      this package's bundled dist-hook/clawborrator-tail.mjs. Hooks
//      run `node` against this path so per-hook latency is just
//      Node startup, not an npx + registry round-trip.
//   2. <cwd>/.claude/settings.json — 12 hook entries (one per
//      Claude-Code hook name), each invoking the local .mjs above.
//      We tag every entry with a #clawborrator-hook sentinel so we
//      can detect + refresh our own entries without disturbing
//      anything else the operator added.

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './log.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// SessionStart / SessionEnd intentionally NOT here — channel_v1's
// hook had a fundamental race (sidecar not yet written on startup,
// sidecar already deleted on shutdown). Lifecycle is now emitted
// server-side from the /channel WS welcome/close transitions in
// hub_v1/server/src/ws/channel.ts, which is reliable and captures
// the channel's actual liveness without depending on hook timing.
const HOOK_NAMES = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'TaskCreated',
  'SubagentStart',
  'SubagentStop',
  'TaskCompleted',
  'Stop',
  'Notification',
] as const;

const TAG = 'clawborrator-hook';

interface ClaudeHook {
  matcher?: string;
  hooks: { type: 'command'; command: string }[];
}
interface SettingsShape {
  hooks?: Record<string, ClaudeHook[]>;
  [k: string]: unknown;
}

function isOurHook(h: { type: 'command'; command: string }): boolean {
  return h.type === 'command' && h.command.includes(`#${TAG}`);
}

function hookCommand(name: string, hookFilePath: string): string {
  // Use the absolute path of the installed hook file. CC resolves
  // relative paths in hook commands against ITS OWN cwd — not against
  // the directory that owns the settings.json. So a relative path
  // like ".claude/hooks/clawborrator-tail.mjs" works only when CC is
  // launched in the exact same dir where the MCP installed the
  // hooks. The moment the user runs CC in a subdir or unrelated
  // sibling (and CC walks up to find a parent .claude/settings.json),
  // the relative path resolves wrong and the hook crashes with
  // MODULE_NOT_FOUND. v0 used absolute paths for this reason.
  // Forward slashes for cross-platform consistency (Windows accepts
  // them in CLI invocations).
  const absPath = hookFilePath.replace(/\\/g, '/');
  return `node "${absPath}" ${name} #${TAG}`;
}

// Find the bundled dist-hook/clawborrator-tail.mjs that ships next
// to this compiled module. Compiled __dirname is .../dist or
// .../dist-bundled depending on the build flavor; the bundle lives
// alongside at .../dist-hook/.
function findBundledHookFile(): string | null {
  const candidates = [
    resolve(__dirname, '..', 'dist-hook', 'clawborrator-tail.mjs'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

// Read settings.json (tolerate missing/empty) and return the parsed
// SettingsShape + the original raw text (used later to skip the
// rewrite when nothing changed). Returns null on JSON parse failure
// — caller should leave the file alone in that case.
function loadOrInitHookSettings(settingsPath: string): { s: SettingsShape; originalText: string } | null {
  if (!existsSync(settingsPath)) return { s: {}, originalText: '' };
  try {
    const originalText = readFileSync(settingsPath, 'utf8');
    if (!originalText.trim()) return { s: {}, originalText };
    return { s: JSON.parse(originalText) as SettingsShape, originalText };
  } catch (e: any) {
    log.warn('install-hooks: settings.json unparseable, leaving alone', { error: e?.message ?? String(e) });
    return null;
  }
}

// Mirror the bundled hook .mjs into `.claude/hooks/clawborrator-
// tail.mjs` if absent or byte-different. Returns whether we touched
// the file. Bundle bytes already in hand from `findBundledHookFile`.
function syncBundledHookFile(hookFile: string, bundleBytes: Buffer): boolean {
  if (!existsSync(hookFile) || !readFileSync(hookFile).equals(bundleBytes)) {
    writeFileSync(hookFile, bundleBytes);
    try { chmodSync(hookFile, 0o755); } catch { /* Windows */ }
    return true;
  }
  return false;
}

// Decide what to do with our hook entry inside one event's `hooks[]`
// list. 'add' means no entry exists yet, 'refresh' means our entry's
// command is stale, 'noop' means it's already exactly right.
function decideHookAction(
  entry: ClaudeHook,
  desiredCmd: string,
): 'add' | 'refresh' | 'noop' {
  const existingIdx = entry.hooks.findIndex(isOurHook);
  if (existingIdx < 0) return 'add';
  if (entry.hooks[existingIdx].command !== desiredCmd) return 'refresh';
  return 'noop';
}

// Apply the chosen action to the entry's hooks[] list, mutating in
// place. Idempotent on 'noop'; replaces for 'refresh'; appends for
// 'add'.
function materializeHookEntry(
  entry: ClaudeHook,
  desiredCmd: string,
  action: 'add' | 'refresh' | 'noop',
): void {
  if (action === 'noop') return;
  if (action === 'refresh') {
    const existingIdx = entry.hooks.findIndex(isOurHook);
    entry.hooks[existingIdx] = { type: 'command', command: desiredCmd };
    return;
  }
  // add
  entry.hooks.push({ type: 'command', command: desiredCmd });
}

// Per-event update: ensures the catch-all `.* matcher` row exists,
// then resolves + applies the action. Returns the action so the
// caller can tally counts.
function reconcileHookEvent(
  s: SettingsShape,
  name: string,
  hookFile: string,
): 'add' | 'refresh' | 'noop' {
  const arr: ClaudeHook[] = (s.hooks![name] ??= []);
  let entry: ClaudeHook | undefined = arr.find((e: ClaudeHook) => (e.matcher ?? '.*') === '.*');
  if (!entry) {
    entry = { matcher: '.*', hooks: [] };
    arr.push(entry);
  }
  const desiredCmd = hookCommand(name, hookFile);
  const action = decideHookAction(entry, desiredCmd);
  materializeHookEntry(entry, desiredCmd, action);
  return action;
}

/**
 * Install/maintain .claude/settings.json + .claude/hooks/clawborrator-
 * tail.mjs for the project at `cwd`. Returns a summary describing what
 * changed; useful for boot-time logging.
 */
export function installHooks(cwd: string): {
  hookFileWritten: boolean;
  settingsWritten: boolean;
  added: number;
  refreshed: number;
  alreadyOk: number;
  hookFilePath: string;
} {
  const claudeDir = resolve(cwd, '.claude');
  const hooksDir  = resolve(claudeDir, 'hooks');
  const hookFile  = resolve(hooksDir, 'clawborrator-tail.mjs');
  const settings  = resolve(claudeDir, 'settings.json');

  const bundleSource = findBundledHookFile();
  if (!bundleSource) {
    log.warn('install-hooks: bundled hook file not found in this package; skipping');
    return { hookFileWritten: false, settingsWritten: false, added: 0, refreshed: 0, alreadyOk: 0, hookFilePath: hookFile };
  }

  if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });
  if (!existsSync(hooksDir))  mkdirSync(hooksDir,  { recursive: true });

  // 1) Copy the bundled .mjs only if its bytes differ from what's
  //    already on disk. Compare exact bytes — cheaper than hashing
  //    and good enough for files this small.
  const bundleBytes = readFileSync(bundleSource);
  const hookFileWritten = syncBundledHookFile(hookFile, bundleBytes);

  // 2) Read existing settings.json (tolerate missing/empty).
  const loaded = loadOrInitHookSettings(settings);
  if (!loaded) {
    return { hookFileWritten, settingsWritten: false, added: 0, refreshed: 0, alreadyOk: 0, hookFilePath: hookFile };
  }
  const { s, originalText } = loaded;
  if (!s.hooks) s.hooks = {};

  let added = 0, refreshed = 0, alreadyOk = 0;
  for (const name of HOOK_NAMES) {
    const action = reconcileHookEvent(s, name, hookFile);
    if (action === 'add') added++;
    else if (action === 'refresh') refreshed++;
    else alreadyOk++;
  }

  // Sweep our (#clawborrator-hook) entries from event names that are
  // NO LONGER in HOOK_NAMES — currently SessionStart / SessionEnd,
  // which we now emit server-side from /channel WS lifecycle. This
  // is what makes earlier installs converge after an upgrade.
  // Don't touch entries that aren't ours (the operator may have
  // their own hooks in those slots).
  let removed = 0;
  const desiredSet = new Set<string>(HOOK_NAMES);
  for (const eventName of Object.keys(s.hooks)) {
    if (desiredSet.has(eventName)) continue;
    const entries = s.hooks[eventName];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const before = entry.hooks.length;
      entry.hooks = entry.hooks.filter((h) => !isOurHook(h));
      if (entry.hooks.length < before) removed += before - entry.hooks.length;
    }
    // Drop now-empty matcher rows so we don't leave hollow shells.
    s.hooks[eventName] = entries.filter((e) => e.hooks.length > 0);
    if (s.hooks[eventName].length === 0) delete s.hooks[eventName];
  }
  if (removed > 0) refreshed += removed;

  // 3) Write only if the serialized form changed.
  const newText = JSON.stringify(s, null, 2) + '\n';
  let settingsWritten = false;
  if (newText !== originalText) {
    writeFileSync(settings, newText);
    settingsWritten = true;
  }

  return { hookFileWritten, settingsWritten, added, refreshed, alreadyOk, hookFilePath: hookFile };
}

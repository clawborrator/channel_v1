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

const HOOK_NAMES = [
  'SessionStart',
  'SessionEnd',
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
  let hookFileWritten = false;
  if (!existsSync(hookFile) || !readFileSync(hookFile).equals(bundleBytes)) {
    writeFileSync(hookFile, bundleBytes);
    try { chmodSync(hookFile, 0o755); } catch { /* Windows */ }
    hookFileWritten = true;
  }

  // 2) Read existing settings.json (tolerate missing/empty).
  let s: SettingsShape = {};
  let originalText = '';
  if (existsSync(settings)) {
    try {
      originalText = readFileSync(settings, 'utf8');
      if (originalText.trim()) s = JSON.parse(originalText);
    } catch (e: any) {
      log.warn('install-hooks: settings.json unparseable, leaving alone', { error: e?.message ?? String(e) });
      return { hookFileWritten, settingsWritten: false, added: 0, refreshed: 0, alreadyOk: 0, hookFilePath: hookFile };
    }
  }
  if (!s.hooks) s.hooks = {};

  let added = 0, refreshed = 0, alreadyOk = 0;
  for (const name of HOOK_NAMES) {
    const arr: ClaudeHook[] = (s.hooks![name] ??= []);
    let entry: ClaudeHook | undefined = arr.find((e: ClaudeHook) => (e.matcher ?? '.*') === '.*');
    if (!entry) {
      entry = { matcher: '.*', hooks: [] };
      arr.push(entry);
    }
    const desiredCmd = hookCommand(name, hookFile);
    const existingIdx = entry.hooks.findIndex(isOurHook);
    if (existingIdx >= 0) {
      if (entry.hooks[existingIdx].command !== desiredCmd) {
        entry.hooks[existingIdx] = { type: 'command', command: desiredCmd };
        refreshed++;
      } else {
        alreadyOk++;
      }
    } else {
      entry.hooks.push({ type: 'command', command: desiredCmd });
      added++;
    }
  }

  // 3) Write only if the serialized form changed.
  const newText = JSON.stringify(s, null, 2) + '\n';
  let settingsWritten = false;
  if (newText !== originalText) {
    writeFileSync(settings, newText);
    settingsWritten = true;
  }

  return { hookFileWritten, settingsWritten, added, refreshed, alreadyOk, hookFilePath: hookFile };
}

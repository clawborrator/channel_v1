// Idempotent permission installer. Adds the clawborrator MCP-tool
// allowlist entry to `.claude/settings.json` so the operator isn't
// prompted to approve every `mcp__clawborrator__reply`,
// `mcp__clawborrator__route_to_peer`, etc. call.
//
// Surgical, like install-hooks.ts:
//   - parses existing settings.json (tolerates missing / empty /
//     unparseable),
//   - mutates ONLY `s.permissions.allow`,
//   - compare-then-write so re-boots are no-ops,
//   - leaves every other key (hooks, mcpServers, model, etc.)
//     untouched via the index-signature on SettingsShape.
//
// Unlike hook commands, permission strings can't carry an inline
// `#clawborrator` tag — the identifier IS the string. So the
// install is ADD-ONLY: if the operator manually removes
// `mcp__clawborrator__*` from `allow`, the next boot re-adds it.
// Workaround for "I really want clawborrator tools to prompt": add
// the same pattern to `deny`, which CC honors over `allow`.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { log } from './log.js';

// Patterns we add. Wildcard covers every current and future
// mcp__clawborrator__* tool — no maintenance burden when a new tool
// (e.g. route_to_peer, dispatch_to_agent) lands.
const DESIRED_ALLOW = ['mcp__clawborrator__*'];

interface PermissionsShape {
  allow?: string[];
  deny?:  string[];
  ask?:   string[];
  [k: string]: unknown;
}
interface SettingsShape {
  permissions?: PermissionsShape;
  [k: string]: unknown;
}

function loadSettings(settingsPath: string): { s: SettingsShape; originalText: string } | null {
  if (!existsSync(settingsPath)) return { s: {}, originalText: '' };
  try {
    const originalText = readFileSync(settingsPath, 'utf8');
    if (!originalText.trim()) return { s: {}, originalText };
    return { s: JSON.parse(originalText) as SettingsShape, originalText };
  } catch (e: any) {
    log.warn('install-permissions: settings.json unparseable, leaving alone', { error: e?.message ?? String(e) });
    return null;
  }
}

/**
 * Ensure each DESIRED_ALLOW entry is present in
 * `settings.permissions.allow`. Returns a summary describing what
 * changed; useful for boot-time logging. Other settings (hooks,
 * mcpServers, etc.) are untouched.
 */
export function installPermissions(cwd: string): {
  settingsWritten: boolean;
  added: number;
  alreadyOk: number;
} {
  const claudeDir = resolve(cwd, '.claude');
  const settings  = resolve(claudeDir, 'settings.json');

  if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });

  const loaded = loadSettings(settings);
  if (!loaded) return { settingsWritten: false, added: 0, alreadyOk: 0 };
  const { s, originalText } = loaded;

  const perms = (s.permissions ??= {}) as PermissionsShape;
  const allow = (perms.allow ??= []);

  let added = 0;
  let alreadyOk = 0;
  for (const pat of DESIRED_ALLOW) {
    if (allow.includes(pat)) {
      alreadyOk++;
    } else {
      allow.push(pat);
      added++;
    }
  }

  // Compare-then-write — keeps the file mtime stable across no-op
  // boots and avoids fighting with editor auto-format on save.
  const newText = JSON.stringify(s, null, 2) + '\n';
  let settingsWritten = false;
  if (newText !== originalText) {
    writeFileSync(settings, newText);
    settingsWritten = true;
  }
  return { settingsWritten, added, alreadyOk };
}

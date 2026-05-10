// Persist the hub-issued session identity across MCP process restarts
// so a fresh `claude` boot in the same project rebinds to the existing
// session row instead of minting a sibling row with the same routing
// name. This is what eliminates the "@driver appears 5 times in
// list_peers / session ls" duplicate-row class of bug.
//
// Forward-only rename in 0.0.33: this file used to live at
// `<cwd>/.claude/clawborrator/session.json` (and a separate hook
// runtime sidecar lived at `<cwd>/.claude/clawborrator.session.json`).
// Both have been moved into the `clawborrator/` subdir and given
// purpose-named filenames so they no longer look like typos of each
// other. The daemon's clean_stale + destroy paths nuke the legacy
// names as well, so existing sessions don't leak cruft when restarted.
//
// Storage shape:
//   <cwd>/.claude/clawborrator/identity.json
//   {
//     "sessionId":  "<uuid>",
//     "routingName": "@<slug>",
//     "hubUrl":      "wss://...",
//     "writtenAt":   "ISO-8601"
//   }
//
// Plus a sibling `.gitignore` ("*\n") inside the same directory so the
// identity file (which contains nothing secret, but is per-machine
// runtime state) never leaks into commits.

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { log } from './log.js';

const REL_DIR  = '.claude/clawborrator';
const REL_FILE = '.claude/clawborrator/identity.json';
const REL_GI   = '.claude/clawborrator/.gitignore';

interface PersistedSession {
  sessionId:    string;
  routingName?: string;
  hubUrl?:      string;
  writtenAt:    string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read the persisted session UUID for `cwd`. Returns null if the file
 * is missing, unreadable, malformed, or contains a non-UUID — i.e.
 * any failure mode we'd rather treat as "no persisted session" than
 * as a fatal error. Worst case we mint a fresh session id; the new
 * session.json on welcome supersedes the bad one.
 */
export function loadPersistedSessionId(cwd: string): string | null {
  const path = resolve(cwd, REL_FILE);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PersistedSession>;
    if (typeof parsed.sessionId === 'string' && UUID_RE.test(parsed.sessionId)) {
      return parsed.sessionId;
    }
    log.warn('persisted-session: invalid sessionId, ignoring', { path });
    return null;
  } catch (e: any) {
    log.warn('persisted-session: read failed', { path, error: e?.message ?? String(e) });
    return null;
  }
}

/**
 * Write identity.json after a successful welcome. Also drops a
 * sibling .gitignore on first creation so the dir as a whole stays
 * out of source control.
 */
export function savePersistedSession(
  cwd: string,
  info: { sessionId: string; routingName?: string; hubUrl?: string },
): void {
  const dir       = resolve(cwd, REL_DIR);
  const path      = resolve(cwd, REL_FILE);
  const gitignore = resolve(cwd, REL_GI);
  try {
    if (!existsSync(dir))       mkdirSync(dir, { recursive: true });
    if (!existsSync(gitignore)) writeFileSync(gitignore, '*\n', 'utf8');
    const body: PersistedSession = {
      sessionId:   info.sessionId,
      routingName: info.routingName,
      hubUrl:      info.hubUrl,
      writtenAt:   new Date().toISOString(),
    };
    writeFileSync(path, JSON.stringify(body, null, 2) + '\n', 'utf8');
  } catch (e: any) {
    log.warn('persisted-session: write failed', { path, error: e?.message ?? String(e) });
  }
}

/**
 * Delete identity.json. Currently unused — kept for symmetry / future
 * operator-driven `claw session reset` flows.
 */
export function deletePersistedSession(cwd: string): void {
  const path = resolve(cwd, REL_FILE);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch (e: any) {
    log.warn('persisted-session: delete failed', { path, error: e?.message ?? String(e) });
  }
}

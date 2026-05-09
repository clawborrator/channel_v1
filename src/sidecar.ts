// Sidecar file — written by the long-lived MCP on `welcome`, deleted
// on clean shutdown. Hook processes (short-lived spawns by Claude
// Code's hook system) read this file to know which session to
// attribute their event to and which hub to POST to.
//
// Path: <cwd>/.claude/clawborrator.session.json. Mode 0600 on POSIX.
//
// Storing the channel-token plaintext here matters: hooks need it to
// authenticate to /api/channel/event. The risk surface is the same
// as the .mcp.json that already lives in the project root with the
// same secret — readers of the dir can already grab the token.

import { resolve } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, chmodSync, existsSync } from 'node:fs';
import { log } from './log.js';

export interface SidecarPayload {
  sessionId:    string;
  routingName:  string | null;
  hubUrl:       string;        // http(s):// — the API host, NOT the ws:// host
  channelToken: string;
  host:         string;
  cwd:          string;
  writtenAt:    string;
}

function sidecarPath(cwd: string): string {
  return resolve(cwd, '.claude', 'clawborrator.session.json');
}

export function writeSidecar(payload: SidecarPayload): void {
  const dir = resolve(payload.cwd, '.claude');
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = sidecarPath(payload.cwd);
    writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* Windows */ }
    log.info('sidecar written', { file });
  } catch (e) {
    log.warn('sidecar write failed', { error: String(e) });
  }
}

export function deleteSidecar(cwd: string): void {
  try {
    const file = sidecarPath(cwd);
    if (existsSync(file)) unlinkSync(file);
  } catch { /* swallow */ }
}

export function readSidecar(cwd: string): SidecarPayload | null {
  try {
    const raw = readFileSync(sidecarPath(cwd), 'utf8');
    return JSON.parse(raw) as SidecarPayload;
  } catch {
    return null;
  }
}

// Read the sidecar at `start` ONLY. The earlier walk-up was a
// misfeature: when a clawborrator-less CC ran inside a parent
// project that DID have a sidecar (e.g. an orchard subagent under
// a clauderemote checkout), its hooks attributed every event to
// the parent's sessionId. The fix: if there's no sidecar at the
// hook's exact cwd, drop the event silently. Hooks fired from
// nested subdirectories of an actual clawborrator project should
// be the rare case; if it surfaces in practice, re-add a bounded
// walk anchored on a clawborrator-specific marker file (NOT a
// generic .claude/ presence).
export function findSidecar(start: string): SidecarPayload | null {
  return readSidecar(start);
}

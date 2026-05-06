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

// Walk upward from `start` looking for a sidecar. Hooks may run from
// a deeper subdirectory than where the channel registered.
export function findSidecar(start: string): SidecarPayload | null {
  let dir = resolve(start);
  for (let i = 0; i < 32; i++) {
    const found = readSidecar(dir);
    if (found) return found;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

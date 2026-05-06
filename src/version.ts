// Resolve clawborrator-mcp's npm version at runtime by reading the
// package.json that ships next to the compiled output.
//
// Why not hardcode? We did, and it drifted: the value sent to the hub
// at register-time stayed at `0.0.1` while the npm-published package
// went to 0.0.4, so `claw session info` always showed `channel v: 0.0.1`.
// Reading from package.json keeps wire reports in lockstep with what
// npm shipped — no double-edit needed at release time.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let cached: string | null = null;

export function packageVersion(): string {
  if (cached) return cached;
  // Compiled output is in dist/, so package.json is one level up.
  // The hook bundle (dist-hook/clawborrator-tail.mjs) lives at the
  // same depth so the same path resolves there too.
  const candidates = [
    resolve(__dirname, '..', 'package.json'),
    resolve(__dirname, '..', '..', 'package.json'), // dist-bundled fallback
  ];
  for (const p of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8'));
      if (parsed && parsed.name === 'clawborrator-mcp' && typeof parsed.version === 'string') {
        cached = parsed.version;
        return parsed.version;
      }
    } catch {
      // try next candidate
    }
  }
  cached = 'unknown';
  return cached;
}

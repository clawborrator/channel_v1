// Standalone bundled hook entry. esbuild rolls this + everything it
// transitively imports (sidecar, transcript, log, hook) into a single
// dist-hook/clawborrator-tail.mjs that gets copied into a project's
// .claude/hooks/ at `claw session init` time.
//
// Hooks then run as plain `node .claude/hooks/clawborrator-tail.mjs
// <HookName>` — no npx, no registry lookup, no install. Same shape
// as the original clawborrator-channel package.
//
// Usage from .claude/settings.json:
//   { "type": "command", "command": "node \".claude/hooks/clawborrator-tail.mjs\" PreToolUse" }

import { runHook } from './hook.js';
import { log } from './log.js';

const hookName = process.argv[2];
if (!hookName) {
  log.error('hook entry invoked without a hook name argument');
  process.exit(0);  // never fail Claude's hook chain
}

runHook(hookName).catch((err: unknown) => {
  log.error('hook fatal', { error: String(err) });
  process.exit(0);
});

// Structured logger. Writes to STDERR only — stdout is reserved for
// the MCP transport. Lines are JSON for easy grep + machine parsing,
// but include a human-readable level + msg up front.

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[(process.env.CLAWBORRATOR_LOG_LEVEL as Level) || 'info'] ?? LEVELS.info;

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (LEVELS[level] < MIN) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  });
  process.stderr.write(line + '\n');
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info:  (msg: string, fields?: Record<string, unknown>) => emit('info',  msg, fields),
  warn:  (msg: string, fields?: Record<string, unknown>) => emit('warn',  msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};

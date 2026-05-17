// Read + validate the env-var configuration the MCP needs to connect.
// Mirrors the shape documented in the channel_v1 design doc §3.

export interface ChannelConfig {
  hubUrl: string;             // ws:// or wss://, no trailing slash
  token: string;              // ck_live_…
  reuseSessionId: string | null;
  // When true, the register frame carries deleteOnDisconnect:true so
  // the hub fully removes this session row when the WS closes
  // (instead of just flipping it offline). Wired through
  // CLAWBORRATOR_EPHEMERAL=1 in the env. spawn-worker.sh sets this
  // automatically for every spawned child; persistent workers leave
  // it unset.
  ephemeral: boolean;
  // Operator-supplied routing name override. When set via
  // CLAWBORRATOR_ROUTING_NAME, the MCP includes it in the register
  // frame and the hub uses it as the candidate routing name instead
  // of deriving from cwd. Normalized at load time (lowercase, non-
  // alphanumeric→dash, trim dashes, leading `@` stripped). Null when
  // unset; the hub falls back to its existing cwd-derivation in that
  // case. Older hubs that don't know about the field silently
  // ignore it.
  routingName: string | null;
}

export function loadConfig(): ChannelConfig {
  const hubUrl = process.env.CLAWBORRATOR_HUB_URL?.trim();
  const token  = process.env.CLAWBORRATOR_TOKEN?.trim();
  if (!hubUrl) throw new Error('CLAWBORRATOR_HUB_URL is required');
  if (!token)  throw new Error('CLAWBORRATOR_TOKEN is required');
  if (!hubUrl.startsWith('ws://') && !hubUrl.startsWith('wss://')) {
    throw new Error(`CLAWBORRATOR_HUB_URL must be ws:// or wss://, got: ${hubUrl}`);
  }
  if (!token.startsWith('ck_live_')) {
    throw new Error(`CLAWBORRATOR_TOKEN must start with ck_live_`);
  }
  return {
    hubUrl:         hubUrl.replace(/\/$/, ''),
    token,
    reuseSessionId: process.env.CLAWBORRATOR_REUSE_SESSION_ID?.trim() || null,
    ephemeral:      process.env.CLAWBORRATOR_EPHEMERAL?.trim() === '1',
    routingName:    normalizeRoutingName(process.env.CLAWBORRATOR_ROUTING_NAME),
  };
}

// Slug-clean the operator-supplied routing name so it matches the
// hub's existing makeRoutingName output: lowercase, alphanumeric +
// dash only, no leading/trailing dashes, no leading `@` (the hub
// adds it). Returns null for unset / empty / fully-stripped inputs
// so the register frame doesn't carry a meaningless field.
function normalizeRoutingName(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const noAt = trimmed.replace(/^@+/, '');
  const slug = noAt.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || null;
}

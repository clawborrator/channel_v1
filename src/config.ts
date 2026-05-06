// Read + validate the env-var configuration the MCP needs to connect.
// Mirrors the shape documented in the channel_v1 design doc §3.

export interface ChannelConfig {
  hubUrl: string;             // ws:// or wss://, no trailing slash
  token: string;              // ck_live_…
  reuseSessionId: string | null;
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
    hubUrl: hubUrl.replace(/\/$/, ''),
    token,
    reuseSessionId: process.env.CLAWBORRATOR_REUSE_SESSION_ID?.trim() || null,
  };
}

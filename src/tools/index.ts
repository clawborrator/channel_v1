// MCP tool registry. Each tool wraps a request-response round-trip
// against the hub via the channel WS.
//
// Tools exposed:
//   reply           — Claude posts a tagged final reply (resolves
//                     pending route_to_peer asks on the originator)
//   list_peers      — discover the operator's other online sessions
//   route_to_peer   — send a prompt to one peer; ask blocks for reply,
//                     tell is fire-and-forget
//   probe_peers     — fan-out a short question across many peers
//
// Inbound prompts (operator-driven or peer-routed) arrive directly to
// Claude via `notifications/claude/channel` — see index.ts onPrompt.
// No queue, no polling tool.

import { randomUUID } from 'node:crypto';
import type { ChannelClient } from '../ws-client.js';

const ASK_TIMEOUT_MS   = 60_000;
const PROBE_TIMEOUT_MS = 30_000;
const LIST_TIMEOUT_MS  = 5_000;

interface CallContext {
  client: ChannelClient;
  /** Hub's chosen sessionId for this channel (filled by `welcome`). */
  sessionId: string | null;
}

export const TOOL_DEFINITIONS = [
  {
    name: 'reply',
    description: 'Post a tagged final reply to a chat. Use this whenever you finish replying to a routed prompt — pass back the chat_id you received from `await_routed_prompt`.',
    inputSchema: {
      type:        'object',
      additionalProperties: false,
      required:    ['chat_id', 'text'],
      properties: {
        chat_id: { type: 'string', description: 'The chat id of the prompt you are replying to' },
        text:    { type: 'string', description: 'Your reply text' },
      },
    },
  },
  {
    name: 'list_peers',
    description: 'List your peer Claude Code sessions reachable for routing. Use this to discover what other projects you can route questions to.',
    inputSchema: {
      type: 'object', additionalProperties: false, properties: {},
    },
  },
  {
    name: 'route_to_peer',
    description: 'Send a prompt to a peer Claude Code session. Use this when a question genuinely belongs to another project. mode=ask blocks for the reply (up to 60s); mode=tell is fire-and-forget.',
    inputSchema: {
      type:        'object',
      additionalProperties: false,
      required:    ['peer', 'prompt', 'mode'],
      properties: {
        peer:   { type: 'string', description: 'Peer routing name (e.g. "@reddit-scout")' },
        prompt: { type: 'string', description: 'What to ask' },
        mode:   { type: 'string', enum: ['ask', 'tell'], description: 'ask: wait for reply; tell: fire-and-forget' },
      },
    },
  },
  {
    name: 'probe_peers',
    description: 'Fan-out the same short question to many peers in parallel. Use for discovery (e.g. "do you have a User model?"). Returns a list of (peer, answer) pairs collected within 30s.',
    inputSchema: {
      type:        'object',
      additionalProperties: false,
      required:    ['prompt'],
      properties: {
        prompt: { type: 'string', description: 'The question to fan out' },
        peers:  { type: 'array',  items: { type: 'string' }, description: 'Peer routing names to ask; null = all online peers' },
      },
    },
  },
] as const;

export async function callTool(
  ctx: CallContext,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; content: { type: 'text'; text: string }[] }> {
  switch (name) {
    case 'reply': {
      const chatId = String(args.chat_id ?? '').trim();
      const text   = String(args.text ?? '');
      if (!chatId) return errorContent('chat_id is required');
      if (!text)   return errorContent('text is required');
      // Reply is a chat_event with chatId in the payload — hub uses
      // it to correlate against any pending route_request waiting on
      // this chatId.
      ctx.client.send({
        type: 'chat_event',
        eventType: 'reply',
        payload: { chatId, text },
        ts: new Date().toISOString(),
      });
      return textContent('reply posted');
    }
    case 'list_peers': {
      const correlationId = randomUUID();
      try {
        const peers = await ctx.client.requestSingle<{ login: string; name: string; online: boolean }[]>(
          { type: 'list_peers_request', correlationId },
          LIST_TIMEOUT_MS,
        );
        if (peers.length === 0) return textContent('no peers online');
        const lines = peers.map((p) => `${p.online ? '●' : '○'} ${p.name} — @${p.login} (${p.online ? 'online' : 'offline'})`);
        return textContent(lines.join('\n'));
      } catch (e: any) {
        return errorContent(e?.message ?? 'list_peers failed');
      }
    }
    case 'route_to_peer': {
      const peer   = String(args.peer ?? '').trim();
      const prompt = String(args.prompt ?? '');
      const mode   = args.mode === 'tell' ? 'tell' : 'ask';
      if (!peer)   return errorContent('peer is required');
      if (!prompt) return errorContent('prompt is required');
      const correlationId = randomUUID();
      if (mode === 'tell') {
        ctx.client.send({ type: 'route_request', correlationId, peer, prompt, mode });
        return textContent(`routed to ${peer} (tell mode — fire-and-forget)`);
      }
      try {
        const result = await ctx.client.requestSingle<{ peerLogin: string; reply: string }>(
          { type: 'route_request', correlationId, peer, prompt, mode },
          ASK_TIMEOUT_MS,
        );
        return textContent(`@${result.peerLogin} replied:\n${result.reply}`);
      } catch (e: any) {
        return errorContent(e?.message ?? 'route_to_peer failed');
      }
    }
    case 'probe_peers': {
      const prompt = String(args.prompt ?? '');
      if (!prompt) return errorContent('prompt is required');
      const peersArg = Array.isArray(args.peers)
        ? (args.peers as unknown[]).filter((p) => typeof p === 'string') as string[]
        : null;
      const correlationId = randomUUID();
      const results = await ctx.client.requestProbe(
        { type: 'probe_request', correlationId, peers: peersArg, prompt },
        PROBE_TIMEOUT_MS,
      );
      if (results.length === 0) return textContent('no peers responded within 30s');
      const lines = results.map((r) => `@${r.peerLogin}: ${r.answer ?? '(no answer)'}`);
      return textContent(lines.join('\n'));
    }
    default:
      return errorContent(`unknown tool: ${name}`);
  }
}

function textContent(text: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text }] };
}
function errorContent(text: string): { isError: true; content: { type: 'text'; text: string }[] } {
  return { isError: true, content: [{ type: 'text', text }] };
}

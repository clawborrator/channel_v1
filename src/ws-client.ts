// WebSocket client to hub_v1's /channel endpoint. Owns the connect /
// register / heartbeat / reconnect-with-backoff loop. Exposes a small
// surface so the MCP entrypoint and hook handlers can post events
// without caring about reconnect state.
//
// Design (per IMPL-PLAN-1-CHANNEL-V1-FRESH-START §4.3):
//   - First connect: register with sessionId=null
//   - Reconnect: register with sessionId=<reuseSessionId env var if set,
//                else null> — fresh session by default
//   - Backoff: 1s, 2s, 5s, 15s, 30s, 60s capped at 60s
//   - Heartbeat: server pings every ~25s; we pong; if 2 pings missed,
//                drop and reconnect

import WebSocket from 'ws';
import { hostname, userInfo } from 'node:os';
import { log } from './log.js';
import { packageVersion } from './version.js';
import type { ChannelConfig } from './config.js';

// Outbound shapes match shared/src/ws-protocol.ts. We don't import
// from there because channel_v1 is its own npm package not in the
// hub_v1 workspace; keeping the types inlined here is the smaller
// price than carrying a peer dep.
type Outbound =
  | { type: 'register'; host: string; cwd: string; osUser: string | null; pid: number; channelVersion: string; sessionId: string | null }
  | { type: 'chat_event'; eventType: 'prompt' | 'reply' | 'reply_chunk'; payload: Record<string, unknown>; ts: string }
  | { type: 'tail_event'; eventType: 'PreToolUse' | 'PostToolUse' | 'Stop' | 'Notification' | 'UserPromptSubmit'; payload: Record<string, unknown>; ts: string }
  | { type: 'permission_request'; requestId: string; tool: string; inputPreview: string; ts: string }
  | { type: 'route_request'; correlationId: string; peer: string; prompt: string; mode: 'ask' | 'tell' }
  | { type: 'probe_request'; correlationId: string; peers: string[] | null; prompt: string }
  | { type: 'list_peers_request'; correlationId: string }
  | { type: 'list_agents_request'; correlationId: string; q?: string }
  | { type: 'dispatch_request'; correlationId: string; handle: string; prompt: string; mode: 'ask' | 'tell' }
  | { type: 'pong'; ts: string };

type Inbound =
  | { type: 'welcome'; sessionId: string; routingName: string; channelTokenName: string }
  | { type: 'prompt'; chatId: string; text: string }
  | { type: 'permission_response'; requestId: string; decision: 'allow' | 'deny' | 'expired'; message: string | null }
  | { type: 'route_response'; correlationId: string; peerLogin: string; reply: string }
  | { type: 'route_reply'; routeId: string; fromName: string; text: string; ts: string; origin?: 'operator' | 'mcp' }
  | { type: 'probe_response'; correlationId: string; peerLogin: string | null; answer: string | null; done?: boolean }
  | { type: 'list_peers_response'; correlationId: string; peers: { login: string; name: string; online: boolean }[] }
  | { type: 'list_agents_response'; correlationId: string; callerLogin: string; agents: { handle: string; ownerLogin: string; name: string; tagline: string; online: boolean; mine: boolean; isolated: boolean }[] }
  | { type: 'peers_update'; peers: { login: string; name: string; online: boolean }[] }
  | { type: 'bye'; reason: string; retry: boolean }
  | { type: 'ping'; ts: string }
  | { type: 'error'; code: string; message: string };

const BACKOFF_SCHEDULE = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000];

export interface ChannelClientHandlers {
  onWelcome?:    (msg: Extract<Inbound, { type: 'welcome' }>) => void;
  onPrompt?:     (msg: Extract<Inbound, { type: 'prompt' }>) => void;
  onRouteReply?: (msg: Extract<Inbound, { type: 'route_reply' }>) => void;
  onPermissionResponse?: (msg: Extract<Inbound, { type: 'permission_response' }>) => void;
  onPeersUpdate?: (msg: Extract<Inbound, { type: 'peers_update' }>) => void;
  onError?:    (msg: Extract<Inbound, { type: 'error' }>) => void;
}

// Pending correlation entry for a send-and-await call. `kind` lets
// the response handler dispatch correctly: 'single' resolves on the
// first matching response; 'probe' accumulates probe_response events
// until done:true (or timeout).
interface PendingSingle {
  kind: 'single';
  resolve: (result: any) => void;
  reject:  (err: Error) => void;
  timer:   NodeJS.Timeout;
}
interface PendingProbe {
  kind: 'probe';
  results: { peerLogin: string; answer: string | null }[];
  resolve: (result: any) => void;
  timer:   NodeJS.Timeout;
}
type Pending = PendingSingle | PendingProbe;

export class ChannelClient {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private currentSessionId: string | null;
  private pending = new Map<string /* correlationId */, Pending>();

  constructor(
    private readonly config: ChannelConfig,
    private readonly handlers: ChannelClientHandlers = {},
  ) {
    this.currentSessionId = config.reuseSessionId;
  }

  connect(): void {
    if (this.stopped) return;
    const url = `${this.config.hubUrl}/channel`;
    log.info('connecting', { url, attempt: this.attempt });

    this.ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.config.token}` },
    });

    this.ws.on('open', () => this.onOpen());
    this.ws.on('message', (data) => this.onMessage(data.toString('utf8')));
    this.ws.on('close', (code, reason) => this.onClose(code, reason.toString()));
    this.ws.on('error', (err) => this.onError(err));
  }

  /** Stop the client; do not reconnect. Resolves when the close
   *  frame has actually flushed (or after a short hard cap), so a
   *  process-exit immediately afterwards doesn't sever the TCP
   *  connection before the FIN has gone out. The hub's on('close')
   *  handler is what flips liveChannels[id] to gone — without
   *  awaiting, the hub waits on TCP-level timeout instead. */
  stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      ws.once('close', done);
      try { ws.close(1000, 'stop'); } catch { done(); return; }
      // Hard cap: don't block shutdown more than 1.5s if the close
      // frame doesn't get acked. The hub will fall back to its pong-
      // timeout heartbeat in that case (~60s).
      setTimeout(done, 1500);
    });
  }

  /** Send a message to hub. Drops the message if the WS isn't open. */
  send(msg: Outbound): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      log.warn('drop send (ws not open)', { type: msg.type });
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  /** Send a request and await its single matching response. Used by
   *  list_peers and route_to_peer (ask mode). */
  requestSingle<T>(msg: Outbound & { correlationId: string }, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.correlationId);
        reject(new Error(`request timed out (correlationId=${msg.correlationId})`));
      }, timeoutMs);
      this.pending.set(msg.correlationId, { kind: 'single', resolve, reject, timer });
      this.send(msg);
    });
  }

  /** Send a probe_request and accumulate per-peer probe_response
   *  events until {done: true} or timeout. Resolves with whatever
   *  was collected. */
  requestProbe(msg: Outbound & { type: 'probe_request' }, timeoutMs: number): Promise<{ peerLogin: string; answer: string | null }[]> {
    return new Promise((resolve) => {
      const results: { peerLogin: string; answer: string | null }[] = [];
      const timer = setTimeout(() => {
        this.pending.delete(msg.correlationId);
        resolve(results);
      }, timeoutMs);
      this.pending.set(msg.correlationId, { kind: 'probe', results, resolve, timer });
      this.send(msg);
    });
  }

  private onOpen(): void {
    log.info('ws open');
    this.attempt = 0;
    const reg: Outbound = {
      type: 'register',
      host: hostname(),
      cwd: process.cwd(),
      osUser: userInfo().username || null,
      pid: process.pid,
      channelVersion: packageVersion(),
      sessionId: this.currentSessionId,  // null on fresh, populated on rebind
    };
    this.send(reg);
  }

  private onMessage(text: string): void {
    let msg: Inbound;
    try {
      msg = JSON.parse(text);
    } catch (e) {
      log.warn('bad message', { text, err: String(e) });
      return;
    }
    log.debug('recv', { type: msg.type });
    // Each per-frame handler lives as a private method so this
    // dispatcher stays a flat switch. Handlers are responsible for
    // their own pending-correlation lookups + handler fan-outs.
    switch (msg.type) {
      case 'welcome':              this.onWelcomeMsg(msg);              break;
      case 'ping':                 this.onPingMsg();                    break;
      case 'prompt':               this.onPromptMsg(msg);               break;
      case 'route_reply':          this.onRouteReplyMsg(msg);           break;
      case 'permission_response':  this.onPermissionResponseMsg(msg);   break;
      case 'peers_update':         this.onPeersUpdateMsg(msg);          break;
      case 'list_peers_response':  this.onListPeersResponse(msg);       break;
      case 'list_agents_response': this.onListAgentsResponse(msg);      break;
      case 'route_response':       this.onRouteResponse(msg);           break;
      case 'probe_response':       this.onProbeResponse(msg);           break;
      case 'bye':                  this.onByeMsg(msg);                  break;
      case 'error':                this.onErrorMsg(msg);                break;
    }
  }

  private onWelcomeMsg(msg: Extract<Inbound, { type: 'welcome' }>): void {
    this.currentSessionId = msg.sessionId;
    log.info('welcomed', { sessionId: msg.sessionId, routingName: msg.routingName });
    this.handlers.onWelcome?.(msg);
  }

  private onPingMsg(): void {
    this.send({ type: 'pong', ts: new Date().toISOString() });
  }

  private onPromptMsg(msg: Extract<Inbound, { type: 'prompt' }>): void {
    this.handlers.onPrompt?.(msg);
  }

  private onRouteReplyMsg(msg: Extract<Inbound, { type: 'route_reply' }>): void {
    this.handlers.onRouteReply?.(msg);
  }

  private onPermissionResponseMsg(msg: Extract<Inbound, { type: 'permission_response' }>): void {
    this.handlers.onPermissionResponse?.(msg);
  }

  private onPeersUpdateMsg(msg: Extract<Inbound, { type: 'peers_update' }>): void {
    this.handlers.onPeersUpdate?.(msg);
  }

  // Resolve the pending single-response request for a given
  // correlationId with a caller-supplied value extracted from the
  // inbound frame. No-ops if nothing was waiting (timed out earlier).
  private resolveSinglePending(correlationId: string, value: unknown): void {
    const p = this.pending.get(correlationId);
    if (!p || p.kind !== 'single') return;
    clearTimeout(p.timer);
    this.pending.delete(correlationId);
    p.resolve(value);
  }

  private onListPeersResponse(msg: Extract<Inbound, { type: 'list_peers_response' }>): void {
    this.resolveSinglePending(msg.correlationId, msg.peers);
  }

  private onListAgentsResponse(msg: Extract<Inbound, { type: 'list_agents_response' }>): void {
    this.resolveSinglePending(msg.correlationId, { agents: msg.agents, callerLogin: msg.callerLogin });
  }

  private onRouteResponse(msg: Extract<Inbound, { type: 'route_response' }>): void {
    this.resolveSinglePending(msg.correlationId, { peerLogin: msg.peerLogin, reply: msg.reply });
  }

  private onProbeResponse(msg: Extract<Inbound, { type: 'probe_response' }>): void {
    const p = this.pending.get(msg.correlationId);
    if (!p || p.kind !== 'probe') return;
    if (msg.done) {
      clearTimeout(p.timer);
      this.pending.delete(msg.correlationId);
      p.resolve(p.results);
    } else if (msg.peerLogin) {
      p.results.push({ peerLogin: msg.peerLogin, answer: msg.answer });
    }
  }

  private onByeMsg(msg: Extract<Inbound, { type: 'bye' }>): void {
    log.info('bye from hub', { reason: msg.reason, retry: msg.retry });
    if (!msg.retry) this.stopped = true;
  }

  private onErrorMsg(msg: Extract<Inbound, { type: 'error' }>): void {
    log.error('hub error', { code: msg.code, message: msg.message });
    this.handlers.onError?.(msg);
    // Auth failures are fatal — don't loop on a revoked token.
    if (msg.code === 'auth_failed' || msg.code === 'token_revoked') {
      this.stopped = true;
      this.ws?.close(1008, msg.code);
      process.exit(2);
    }
  }

  private onClose(code: number, reason: string): void {
    log.info('ws close', { code, reason });
    this.ws = null;
    if (!this.stopped) this.scheduleReconnect();
  }

  private onError(err: Error): void {
    log.warn('ws error', { message: err.message });
    // The 'close' handler runs after; let it own reconnect scheduling.
  }

  private scheduleReconnect(): void {
    const delay = BACKOFF_SCHEDULE[Math.min(this.attempt, BACKOFF_SCHEDULE.length - 1)];
    this.attempt += 1;
    log.info('reconnecting', { delayMs: delay, attempt: this.attempt });
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}

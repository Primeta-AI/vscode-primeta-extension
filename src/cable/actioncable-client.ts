import WebSocket from 'ws';
import { CableTicketError, cableUrlForTicket, mintCableTicket, serverBase } from './cable-ticket';

export interface SpeakMessage {
  text: string;
  state?: string;
  intensity?: number;
}

export interface BridgeStatusMessage {
  event: string;       // "connected" | "disconnected"
  bridge_name: string;
}

export interface PersonaChangedMessage {
  persona_id: number;
  persona_name: string;
}

export interface CableSettings {
  serverUrl: string;
  apiToken: string;
}

/** Minimal surface of a `ws` WebSocket that this client uses (mockable in tests). */
export interface CableSocket {
  readyState: number;
  on(event: string, listener: (...args: any[]) => void): unknown;
  send(data: string): void;
  close(): void;
  terminate?(): void;
}

export interface ActionCableDeps {
  /** Read current settings (VS Code configuration in production). */
  getSettings: () => CableSettings;
  /** Exchange the API token for a one-time cable ticket. */
  mintTicket?: (serverUrl: string, apiToken: string) => Promise<string>;
  /** Open the WebSocket. */
  createSocket?: (url: string, protocols: string[], opts: { origin: string }) => CableSocket;
}

export interface ActionCableCallbacks {
  onMessage: (msg: SpeakMessage) => void;
  onPersonaChanged: (msg: PersonaChangedMessage) => void;
  onBridgeStatus: (msg: BridgeStatusMessage) => void;
}

/**
 * Lightweight ActionCable client for Node.js.
 * Connects to the Rails server's WebSocket endpoint,
 * authenticates with a short-lived one-time ticket (minted per connection
 * attempt via POST /cable/tickets — the API token never goes in the URL),
 * and subscribes
 * to VscodeTtsChannel for assistant messages + bridge events.
 *
 * Subscribes to two streams:
 *  - User-wide stream (bridge_status, persona_changed)
 *  - Bridge-specific stream (assistant_message, emotion) once a bridge is claimed
 */
// Heartbeat watchdog — Rails ActionCable pings every ~3s. If we don't see
// any inbound frame for this long, we assume the underlying TCP connection
// is silently dead (laptop sleep, NAT drop, WiFi switch) and force a
// reconnect. Without this, ws.readyState stays OPEN forever even though
// no bytes are flowing, and the user has to manually relaunch the
// extension to recover.
const HEARTBEAT_TIMEOUT_MS = 15_000;
const HEARTBEAT_CHECK_INTERVAL_MS = 5_000;
const RECONNECT_DELAY_MS = 3_000;
// A 401/403 from the ticket endpoint means the token is bad or revoked;
// don't hammer the server every 3s.
const AUTH_FAILURE_RECONNECT_DELAY_MS = 60_000;

export class ActionCableClient {
  private ws: CableSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastInboundAt = 0;
  private disposed = false;
  private bridgeName: string | null = null;
  private channelIdentifier: string = '';
  private callbacks: ActionCableCallbacks;
  private deps: Required<ActionCableDeps>;
  // Bumped on every connect attempt and on dispose so a slow ticket mint
  // can't open a socket for a superseded attempt.
  private attempt = 0;

  constructor(callbacks: ActionCableCallbacks, deps: ActionCableDeps) {
    this.callbacks = callbacks;
    this.deps = {
      getSettings: deps.getSettings,
      mintTicket: deps.mintTicket ?? ((serverUrl, apiToken) => mintCableTicket(serverUrl, apiToken)),
      createSocket: deps.createSocket
        ?? ((url, protocols, opts) => new WebSocket(url, protocols, opts) as unknown as CableSocket),
    };
  }

  /**
   * Mint a fresh one-time ticket, then open the socket with it. Resolves once
   * the socket has been created (or the attempt was abandoned/failed — failures
   * schedule a reconnect, which mints again).
   */
  async connect(bridgeName?: string): Promise<void> {
    if (this.disposed) return;

    this.bridgeName = bridgeName || null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const attempt = ++this.attempt;

    const { serverUrl, apiToken } = this.deps.getSettings();
    if (!apiToken) return;

    const origin = serverBase(serverUrl);

    let ticket: string;
    try {
      ticket = await this.deps.mintTicket(serverUrl, apiToken);
    } catch (err) {
      if (this.disposed || attempt !== this.attempt) return;
      const authFailure = err instanceof CableTicketError && err.isAuthFailure;
      // Message is token-free by construction (see cable-ticket.ts).
      console.error('[Primeta cable] Ticket mint failed:', (err as Error)?.message);
      // No fallback to ?bridge_token= — just retry later with a fresh mint.
      this.scheduleReconnect(authFailure ? AUTH_FAILURE_RECONNECT_DELAY_MS : RECONNECT_DELAY_MS);
      return;
    }
    if (this.disposed || attempt !== this.attempt) return;

    // Drop any previous socket so its close event doesn't trigger a
    // duplicate reconnect.
    this.teardownSocket();

    // Rails' ActionCable checks the Origin header against
    // `allowed_request_origins`; Node's ws library doesn't send one by
    // default, so the upgrade comes back as 404. Pass it explicitly.
    const ws = this.deps.createSocket(cableUrlForTicket(serverUrl, ticket), ['actioncable-v1-json'], { origin });
    this.ws = ws;

    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.lastInboundAt = Date.now();
      this.startHeartbeatWatchdog();
    });

    ws.on('message', (data: WebSocket.Data) => {
      if (this.ws !== ws) return;
      this.lastInboundAt = Date.now();
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch {}
    });

    ws.on('close', (code: number, reason: Buffer) => {
      if (this.ws !== ws) return;
      console.error('[Primeta cable] WS close', code, reason?.toString());
      this.stopHeartbeatWatchdog();
      this.ws = null;
      this.scheduleReconnect();
    });

    ws.on('error', (err: Error) => {
      console.error('[Primeta cable] WS error', err.message);
      try { ws.close(); } catch {}
    });

    ws.on('unexpected-response', (_req: unknown, res: { statusCode?: number }) => {
      console.error('[Primeta cable] WS unexpected-response', res?.statusCode);
    });
  }

  private teardownSocket() {
    this.stopHeartbeatWatchdog();
    const old = this.ws;
    this.ws = null;
    if (old) {
      try { old.close(); } catch {}
    }
  }

  private handleMessage(msg: any) {
    if (msg.type === 'welcome') {
      const params: Record<string, string> = { channel: 'VscodeTtsChannel' };
      if (this.bridgeName) {
        params.bridge_name = this.bridgeName;
      }
      this.channelIdentifier = JSON.stringify(params);
      this.send({
        command: 'subscribe',
        identifier: this.channelIdentifier,
      });
      return;
    }

    if (msg.type === 'ping') return;

    if (msg.type === 'confirm_subscription') return;

    if (msg.type === 'reject_subscription') {
      console.error('[Primeta cable] REJECT_SUBSCRIPTION', msg.identifier);
      return;
    }

    if (msg.type === 'disconnect') {
      console.error('[Primeta cable] disconnect', msg.reason, 'reconnect:', msg.reconnect);
      return;
    }

    const payload = msg.message;
    if (!payload?.type) return;

    switch (payload.type) {
      case 'assistant_message':
        if (payload.text) {
          this.callbacks.onMessage({
            text: payload.text,
            state: payload.state,
            intensity: payload.intensity,
          });
        }
        break;

      case 'emotion':
        if (payload.state) {
          this.callbacks.onMessage({
            text: '',
            state: payload.state,
            intensity: payload.intensity || 1.0,
          });
        }
        break;

      case 'bridge_status':
        this.callbacks.onBridgeStatus({
          event: payload.event,
          bridge_name: payload.bridge_name,
        });
        break;

      case 'persona_changed':
        this.callbacks.onPersonaChanged({
          persona_id: payload.persona_id,
          persona_name: payload.persona_name,
        });
        break;
    }
  }

  /** Claim a bridge — resubscribes with bridge name to get bridge-specific messages */
  claimBridge(bridgeName: string) {
    if (this.channelIdentifier && this.ws?.readyState === WebSocket.OPEN) {
      this.send({
        command: 'unsubscribe',
        identifier: this.channelIdentifier,
      });
    }

    this.bridgeName = bridgeName;

    const params: Record<string, string> = {
      channel: 'VscodeTtsChannel',
      bridge_name: bridgeName,
    };
    this.channelIdentifier = JSON.stringify(params);

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({
        command: 'subscribe',
        identifier: this.channelIdentifier,
      });
    }
  }

  /** Release the current bridge claim and resubscribe for user-wide events only */
  releaseBridge() {
    if (this.channelIdentifier && this.ws?.readyState === WebSocket.OPEN) {
      this.send({
        command: 'unsubscribe',
        identifier: this.channelIdentifier,
      });
    }

    this.bridgeName = null;

    const params: Record<string, string> = { channel: 'VscodeTtsChannel' };
    this.channelIdentifier = JSON.stringify(params);

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({
        command: 'subscribe',
        identifier: this.channelIdentifier,
      });
    }
  }

  get currentBridge(): string | null {
    return this.bridgeName;
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private send(data: any) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private scheduleReconnect(delayMs = RECONNECT_DELAY_MS) {
    if (this.disposed) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    // connect() mints a brand-new ticket — tickets are one-time use.
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect(this.bridgeName || undefined);
    }, delayMs);
  }

  private startHeartbeatWatchdog() {
    this.stopHeartbeatWatchdog();
    this.heartbeatTimer = setInterval(() => {
      const idle = Date.now() - this.lastInboundAt;
      if (idle <= HEARTBEAT_TIMEOUT_MS) return;
      console.error(`[Primeta cable] No frames for ${Math.round(idle / 1000)}s — connection is dead, forcing reconnect`);
      this.stopHeartbeatWatchdog();
      if (this.ws) {
        try { this.ws.terminate?.(); } catch {}
        try { this.ws.close(); } catch {}
        this.ws = null;
      }
      this.scheduleReconnect();
    }, HEARTBEAT_CHECK_INTERVAL_MS);
  }

  private stopHeartbeatWatchdog() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  dispose() {
    this.disposed = true;
    this.attempt++;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.teardownSocket();
  }
}

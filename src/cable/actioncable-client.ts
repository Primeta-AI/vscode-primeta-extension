import * as vscode from 'vscode';
import WebSocket from 'ws';

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

export interface ActionCableCallbacks {
  onMessage: (msg: SpeakMessage) => void;
  onPersonaChanged: (msg: PersonaChangedMessage) => void;
  onBridgeStatus: (msg: BridgeStatusMessage) => void;
}

/**
 * Lightweight ActionCable client for Node.js.
 * Connects to the Rails server's WebSocket endpoint,
 * authenticates via bridge_api_token, and subscribes
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

export class ActionCableClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastInboundAt = 0;
  private disposed = false;
  private bridgeName: string | null = null;
  private channelIdentifier: string = '';
  private callbacks: ActionCableCallbacks;

  constructor(callbacks: ActionCableCallbacks) {
    this.callbacks = callbacks;
  }

  connect(bridgeName?: string) {
    if (this.disposed) return;

    this.bridgeName = bridgeName || null;

    const config = vscode.workspace.getConfiguration('primeta');
    const serverUrl = config.get<string>('serverUrl', 'https://primeta.ai');
    const apiToken = config.get<string>('apiToken', '');

    if (!apiToken) return;

    const origin = serverUrl.replace(/\/$/, '');
    const wsUrl = origin
      .replace(/^https:/, 'wss:')
      .replace(/^http:/, 'ws:') + `/cable?bridge_token=${apiToken}`;

    // Rails' ActionCable checks the Origin header against
    // `allowed_request_origins`; Node's ws library doesn't send one by
    // default, so the upgrade comes back as 404. Pass it explicitly.
    this.ws = new WebSocket(wsUrl, ['actioncable-v1-json'], { origin });

    this.ws.on('open', () => {
      this.lastInboundAt = Date.now();
      this.startHeartbeatWatchdog();
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      this.lastInboundAt = Date.now();
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch {}
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      console.error('[Primeta cable] WS close', code, reason?.toString());
      this.stopHeartbeatWatchdog();
      this.scheduleReconnect();
    });

    this.ws.on('error', (err: Error) => {
      console.error('[Primeta cable] WS error', err.message);
      this.ws?.close();
    });

    this.ws.on('unexpected-response', (_req: unknown, res: { statusCode?: number }) => {
      console.error('[Primeta cable] WS unexpected-response', res?.statusCode);
    });
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

  private scheduleReconnect() {
    if (this.disposed) return;
    this.reconnectTimer = setTimeout(() => this.connect(this.bridgeName || undefined), 3000);
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
    this.stopHeartbeatWatchdog();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

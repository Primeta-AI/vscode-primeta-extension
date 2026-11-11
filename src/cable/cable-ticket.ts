/**
 * Short-lived ActionCable connection tickets.
 *
 * The long-lived Primeta API token must never appear in a WebSocket URL
 * (URLs end up in proxy/server access logs). Instead we exchange it — in an
 * Authorization header — for a one-time ticket that expires in ~60s, and put
 * only that ticket in the cable URL:
 *
 *   POST {server}/cable/tickets   Authorization: Bearer <apiToken>
 *   201 {"ticket":"<raw>","expires_in":60}
 *   WS   {wsServer}/cable?ticket=<raw>
 *
 * Tickets are single-use, so every connect/reconnect must mint a fresh one.
 * There is deliberately no fallback to the legacy `?bridge_token=` URL.
 *
 * This module has no `vscode` dependency so it can be unit-tested in plain Node.
 */

export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; redirect: 'error' | 'manual' | 'follow'; signal?: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export class CableTicketError extends Error {
  /** HTTP status when the server answered, undefined for network/parse errors. */
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'CableTicketError';
    this.status = status;
  }

  /** True when retrying with the same API token is pointless (bad/revoked token). */
  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

const MINT_TIMEOUT_MS = 10_000;
// Tickets are opaque server-generated strings; be conservative about what we
// accept so a malformed/hostile response can't smuggle extra URL structure.
const TICKET_PATTERN = /^[A-Za-z0-9_\-.~=+/]{16,512}$/;

/** Normalize the configured server URL to an origin-ish base (no trailing slash). */
export function serverBase(serverUrl: string): string {
  return serverUrl.replace(/\/+$/, '');
}

export function cableUrlForTicket(serverUrl: string, ticket: string): string {
  const wsBase = serverBase(serverUrl)
    .replace(/^https:/, 'wss:')
    .replace(/^http:/, 'ws:');
  return `${wsBase}/cable?ticket=${encodeURIComponent(ticket)}`;
}

/**
 * Exchange the API token for a one-time cable ticket. Throws CableTicketError
 * on any failure. Error messages never include the API token.
 */
export async function mintCableTicket(
  serverUrl: string,
  apiToken: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<string> {
  if (!apiToken) throw new CableTicketError('No API token configured');

  const url = `${serverBase(serverUrl)}/cable/tickets`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MINT_TIMEOUT_MS);

  let res: { status: number; json(): Promise<unknown> };
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        Accept: 'application/json',
      },
      // Never follow redirects with the bearer token attached.
      redirect: 'error',
      signal: controller.signal,
    });
  } catch (err) {
    throw new CableTicketError(`Ticket request failed: ${(err as Error)?.name || 'network error'}`);
  } finally {
    clearTimeout(timeout);
  }

  if (res.status !== 201 && res.status !== 200) {
    throw new CableTicketError(`Ticket request rejected (HTTP ${res.status})`, res.status);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new CableTicketError('Ticket response was not valid JSON', res.status);
  }

  const ticket = (body as { ticket?: unknown } | null)?.ticket;
  if (typeof ticket !== 'string' || !TICKET_PATTERN.test(ticket)) {
    throw new CableTicketError('Ticket response missing a valid ticket', res.status);
  }
  if (ticket === apiToken) {
    // Defensive: never let the long-lived token end up in the URL.
    throw new CableTicketError('Ticket response echoed the API token', res.status);
  }
  return ticket;
}

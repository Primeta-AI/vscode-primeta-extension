import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CableTicketError, cableUrlForTicket, mintCableTicket, type FetchLike } from '../src/cable/cable-ticket';
import { ActionCableClient, type CableSocket } from '../src/cable/actioncable-client';

const API_KEY = 'pk_live_SECRET_api_key_do_not_leak_1234567890';
const SERVER = 'https://primeta.example/';
const TICKET_A = 'tkt_AAAAAAAAAAAAAAAAAAAAAAAA';
const TICKET_B = 'tkt_BBBBBBBBBBBBBBBBBBBBBBBB';

type FetchCall = { url: string; init: Parameters<FetchLike>[1] };

function fakeFetch(responses: Array<{ status: number; body?: unknown; throws?: Error; badJson?: boolean }>) {
  const calls: FetchCall[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (!r) throw new Error('unexpected fetch');
    if (r.throws) throw r.throws;
    return {
      status: r.status,
      json: async () => {
        if (r.badJson) throw new SyntaxError('bad json');
        return r.body;
      },
    };
  };
  return { impl, calls };
}

class FakeSocket extends EventEmitter implements CableSocket {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  constructor(public url: string, public protocols: string[], public opts: { origin: string }) { super(); }
  send(data: string) { this.sent.push(data); }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit('close', 1006, Buffer.from(''));
  }
  terminate() { this.close(); }
}

const noopCallbacks = { onMessage() {}, onPersonaChanged() {}, onBridgeStatus() {} };

function makeClient(mintTicket: (s: string, k: string) => Promise<string>) {
  const sockets: FakeSocket[] = [];
  const client = new ActionCableClient(noopCallbacks, {
    getSettings: () => ({ serverUrl: SERVER, apiToken: API_KEY }),
    mintTicket,
    createSocket: (url, protocols, opts) => {
      const s = new FakeSocket(url, protocols, opts);
      sockets.push(s);
      return s;
    },
  });
  return { client, sockets };
}

// Silence expected console.error noise, but capture it to assert no key leaks.
let logged: string[] = [];
mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
afterEach(() => {
  for (const line of logged) assert.ok(!line.includes(API_KEY), `log leaked api key: ${line}`);
  logged = [];
  mock.timers.reset();
});

// ---------------------------------------------------------------- mintCableTicket

test('mint: POSTs to /cable/tickets with Bearer header and no redirects', async () => {
  const { impl, calls } = fakeFetch([{ status: 201, body: { ticket: TICKET_A, expires_in: 60 } }]);
  const ticket = await mintCableTicket(SERVER, API_KEY, impl);
  assert.equal(ticket, TICKET_A);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://primeta.example/cable/tickets');
  assert.ok(!calls[0].url.includes(API_KEY));
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${API_KEY}`);
  assert.equal(calls[0].init.redirect, 'error');
});

for (const status of [401, 403, 500, 302]) {
  test(`mint: HTTP ${status} throws CableTicketError without the key in the message`, async () => {
    const { impl } = fakeFetch([{ status, body: { error: 'nope' } }]);
    await assert.rejects(mintCableTicket(SERVER, API_KEY, impl), (err: unknown) => {
      assert.ok(err instanceof CableTicketError);
      assert.equal(err.status, status);
      assert.equal(err.isAuthFailure, status === 401 || status === 403);
      assert.ok(!err.message.includes(API_KEY));
      return true;
    });
  });
}

test('mint: network error throws CableTicketError without leaking key', async () => {
  const { impl } = fakeFetch([{ status: 0, throws: new TypeError(`fetch failed for ${API_KEY}`) }]);
  await assert.rejects(mintCableTicket(SERVER, API_KEY, impl), (err: unknown) => {
    assert.ok(err instanceof CableTicketError);
    assert.ok(!err.message.includes(API_KEY));
    return true;
  });
});

test('mint: invalid JSON / missing / malformed / echoed ticket all rejected', async () => {
  const bad: Array<{ status: number; body?: unknown; badJson?: boolean }> = [
    { status: 201, badJson: true },
    { status: 201, body: null },
    { status: 201, body: {} },
    { status: 201, body: { ticket: 12345 } },
    { status: 201, body: { ticket: '' } },
    { status: 201, body: { ticket: 'short' } },
    { status: 201, body: { ticket: 'abcdefghijklmnop&bridge_token=x' } },
    { status: 201, body: { ticket: 'abcdefghijklmnop\r\nX: y' } },
    { status: 201, body: { ticket: API_KEY } },
  ];
  for (const r of bad) {
    const { impl } = fakeFetch([r]);
    await assert.rejects(mintCableTicket(SERVER, API_KEY, impl), CableTicketError, JSON.stringify(r.body));
  }
});

test('mint: refuses to call the server without a token', async () => {
  const { impl, calls } = fakeFetch([]);
  await assert.rejects(mintCableTicket(SERVER, '', impl), CableTicketError);
  assert.equal(calls.length, 0);
});

test('cableUrlForTicket: wss + encoded ticket, http -> ws', () => {
  assert.equal(cableUrlForTicket('https://primeta.example/', 'a+b/c='), 'wss://primeta.example/cable?ticket=a%2Bb%2Fc%3D');
  assert.equal(cableUrlForTicket('http://localhost:3000', TICKET_A), `ws://localhost:3000/cable?ticket=${TICKET_A}`);
});

// ---------------------------------------------------------------- ActionCableClient

test('client: successful mint opens URL with ticket, never bridge_token or api key; Origin preserved', async () => {
  const mint = mock.fn(async (_s: string, _k: string) => TICKET_A);
  const { client, sockets } = makeClient(mint);
  await client.connect();

  assert.equal(mint.mock.callCount(), 1);
  assert.deepEqual(mint.mock.calls[0].arguments, [SERVER, API_KEY]);
  assert.equal(sockets.length, 1);
  const s = sockets[0];
  assert.equal(s.url, `wss://primeta.example/cable?ticket=${TICKET_A}`);
  assert.ok(!s.url.includes('bridge_token'));
  assert.ok(!s.url.includes(API_KEY));
  assert.deepEqual(s.protocols, ['actioncable-v1-json']);
  assert.equal(s.opts.origin, 'https://primeta.example');
  client.dispose();
});

test('client: subscribes after welcome on the ticketed socket', async () => {
  const { client, sockets } = makeClient(async () => TICKET_A);
  await client.connect('my-bridge');
  const s = sockets[0];
  s.readyState = 1;
  s.emit('open');
  s.emit('message', Buffer.from(JSON.stringify({ type: 'welcome' })));
  assert.equal(s.sent.length, 1);
  assert.deepEqual(JSON.parse(s.sent[0]), {
    command: 'subscribe',
    identifier: JSON.stringify({ channel: 'VscodeTtsChannel', bridge_name: 'my-bridge' }),
  });
  client.dispose();
});

test('client: mint 401 opens no socket (no bridge_token fallback) and backs off', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const mint = mock.fn(async () => { throw new CableTicketError('Ticket request rejected (HTTP 401)', 401); });
  const { client, sockets } = makeClient(mint);
  await client.connect();
  assert.equal(sockets.length, 0);
  assert.equal(mint.mock.callCount(), 1);

  // Normal 3s reconnect delay does not fire for auth failures...
  mock.timers.tick(3_000);
  await Promise.resolve();
  assert.equal(mint.mock.callCount(), 1);
  // ...but it does retry (with a fresh mint) after the longer backoff.
  mock.timers.tick(60_000);
  await Promise.resolve();
  assert.equal(mint.mock.callCount(), 2);
  assert.equal(sockets.length, 0);
  client.dispose();
});

test('client: generic mint failure opens no URL with the key and retries by minting', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let n = 0;
  const mint = mock.fn(async () => {
    if (n++ === 0) throw new CableTicketError('Ticket request failed: TypeError');
    return TICKET_B;
  });
  const { client, sockets } = makeClient(mint);
  await client.connect();
  assert.equal(sockets.length, 0);

  mock.timers.tick(3_000);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(mint.mock.callCount(), 2);
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, `wss://primeta.example/cable?ticket=${TICKET_B}`);
  for (const s of sockets) assert.ok(!s.url.includes(API_KEY));
  client.dispose();
});

test('client: reconnect after socket close mints a fresh ticket', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const tickets = [TICKET_A, TICKET_B];
  const mint = mock.fn(async () => tickets.shift()!);
  const { client, sockets } = makeClient(mint);
  await client.connect();
  assert.equal(sockets.length, 1);

  sockets[0].close(); // server drops us
  mock.timers.tick(3_000);
  for (let i = 0; i < 5; i++) await Promise.resolve();

  assert.equal(mint.mock.callCount(), 2);
  assert.equal(sockets.length, 2);
  assert.equal(sockets[1].url, `wss://primeta.example/cable?ticket=${TICKET_B}`);
  assert.notEqual(sockets[0].url, sockets[1].url);
  client.dispose();
});

test('client: heartbeat-forced reconnect also mints a fresh ticket (single reconnect)', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const tickets = [TICKET_A, TICKET_B, 'tkt_CCCCCCCCCCCCCCCCCCCCCCCC'];
  const mint = mock.fn(async () => tickets.shift()!);
  const { client, sockets } = makeClient(mint);
  await client.connect();
  sockets[0].readyState = 1;
  sockets[0].emit('open');

  mock.timers.tick(20_000); // watchdog trips, schedules reconnect
  mock.timers.tick(3_000);
  for (let i = 0; i < 5; i++) await Promise.resolve();

  assert.equal(mint.mock.callCount(), 2, 'exactly one reconnect mint');
  assert.equal(sockets.length, 2);
  assert.ok(sockets[0].closed);
  assert.equal(sockets[1].url, `wss://primeta.example/cable?ticket=${TICKET_B}`);
  client.dispose();
});

test('client: dispose during in-flight mint opens no socket and schedules nothing', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let resolve!: (t: string) => void;
  const mint = mock.fn(() => new Promise<string>((r) => { resolve = r; }));
  const { client, sockets } = makeClient(mint);
  const p = client.connect();
  client.dispose();
  resolve(TICKET_A);
  await p;
  assert.equal(sockets.length, 0);
  mock.timers.tick(120_000);
  await Promise.resolve();
  assert.equal(mint.mock.callCount(), 1);
});

test('client: no api token -> no mint, no socket', async () => {
  const mint = mock.fn(async () => TICKET_A);
  const sockets: FakeSocket[] = [];
  const client = new ActionCableClient(noopCallbacks, {
    getSettings: () => ({ serverUrl: SERVER, apiToken: '' }),
    mintTicket: mint,
    createSocket: (u, p, o) => { const s = new FakeSocket(u, p, o); sockets.push(s); return s; },
  });
  await client.connect();
  assert.equal(mint.mock.callCount(), 0);
  assert.equal(sockets.length, 0);
});

test('client: default mint path goes through fetch with Bearer header, not the URL', async () => {
  const realFetch = globalThis.fetch;
  const calls: Array<{ url: string; init: any }> = [];
  (globalThis as any).fetch = async (url: string, init: any) => {
    calls.push({ url, init });
    return { status: 201, json: async () => ({ ticket: TICKET_A, expires_in: 60 }) };
  };
  try {
    const sockets: FakeSocket[] = [];
    const client = new ActionCableClient(noopCallbacks, {
      getSettings: () => ({ serverUrl: SERVER, apiToken: API_KEY }),
      createSocket: (u, p, o) => { const s = new FakeSocket(u, p, o); sockets.push(s); return s; },
    });
    await client.connect();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://primeta.example/cable/tickets');
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${API_KEY}`);
    assert.equal(sockets[0].url, `wss://primeta.example/cable?ticket=${TICKET_A}`);
    client.dispose();
  } finally {
    globalThis.fetch = realFetch;
  }
});

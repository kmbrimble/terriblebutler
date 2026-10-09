import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import { io as connect } from 'socket.io-client';
import './setup.js';
import { createRealtime } from '../lib/realtime.js';

const servers = [];
afterEach(async () => {
  while (servers.length) {
    const srv = servers.pop();
    await new Promise((resolve) => { srv.close(resolve); srv.closeAllConnections(); });
  }
});

async function start(limits, trustPeer = () => false) {
  const server = http.createServer();
  const realtime = createRealtime(server, () => ({ type: 'jwt', jti: 'x', expiresAt: Date.now() + 60_000 }), undefined, trustPeer, limits);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { server, realtime, url: `http://127.0.0.1:${server.address().port}` };
}

// A polling handshake; the status is what allowRequest decided. Opens an engine session when 200.
function handshake(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(`${url}/socket.io/?EIO=4&transport=polling`, { headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}
const BIG = { handshakeMax: 1000, perClientMax: 1000, totalMax: 1000 };

describe('Socket.IO handshake rate limit', () => {
  it('refuses handshakes over the per-minute limit from one client, then accepts a different client', async () => {
    const { url } = await start({ ...BIG, handshakeMax: 3 }, () => true);
    const a = { 'X-Forwarded-For': '203.0.113.7' };
    expect([await handshake(url, a), await handshake(url, a), await handshake(url, a)]).toEqual([200, 200, 200]);
    expect(await handshake(url, a)).toBe(403);
    expect(await handshake(url, { 'X-Forwarded-For': '203.0.113.8' })).toBe(200);
  });

  it('ignores X-Forwarded-For from an untrusted peer: spoofed addresses all share the socket peer\'s bucket', async () => {
    const { url } = await start({ ...BIG, handshakeMax: 2 }, () => false);
    expect(await handshake(url, { 'X-Forwarded-For': '203.0.113.1' })).toBe(200);
    expect(await handshake(url, { 'X-Forwarded-For': '203.0.113.2' })).toBe(200);
    expect(await handshake(url, { 'X-Forwarded-For': '203.0.113.3' })).toBe(403);
  });

  it('keys IPv6 clients on their /64, as the Express limiters do', async () => {
    const { url } = await start({ ...BIG, handshakeMax: 2 }, () => true);
    const from = (address) => ({ 'X-Forwarded-For': address });
    expect(await handshake(url, from('2001:db8:1:2::1'))).toBe(200);
    expect(await handshake(url, from('2001:db8:1:2:ffff::9'))).toBe(200); // same /64
    expect(await handshake(url, from('2001:db8:1:2:abcd::5'))).toBe(403); // same /64 again: over the limit
    expect(await handshake(url, from('2001:db8:1:3::1'))).toBe(200); // a different /64
  });

  it('counts only new sessions: polling and upgrade requests carrying a sid are not handshakes', async () => {
    const { url } = await start({ ...BIG, handshakeMax: 2 });
    const socket = connect(url, { auth: { token: 't' }, reconnection: false });
    await new Promise((resolve, reject) => { socket.on('connect', resolve); socket.on('connect_error', reject); });
    // The client polled several times and upgraded to WebSocket on this one session.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await handshake(url)).toBe(200); // second handshake still allowed
    socket.close();
  });
});

describe('Socket.IO concurrent connection caps', () => {
  it('caps open connections per client and frees the slot when one closes', async () => {
    const { url, realtime } = await start({ ...BIG, perClientMax: 2 });
    const open = () => new Promise((resolve, reject) => {
      const socket = connect(url, { auth: { token: 't' }, transports: ['websocket'], reconnection: false });
      socket.on('connect', () => resolve(socket));
      socket.on('connect_error', reject);
    });
    const first = await open();
    const second = await open();
    await expect(open()).rejects.toBeTruthy();
    expect(realtime.io.engine.clientsCount).toBe(2);

    first.close();
    await new Promise((resolve) => setTimeout(resolve, 200)); // the server sees the close
    const third = await open();
    expect(third.connected).toBe(true);
    second.close();
    third.close();
  });

  it('caps open connections overall, across clients', async () => {
    const { url } = await start({ ...BIG, totalMax: 2 }, () => true);
    expect(await handshake(url, { 'X-Forwarded-For': '198.51.100.1' })).toBe(200);
    expect(await handshake(url, { 'X-Forwarded-For': '198.51.100.2' })).toBe(200);
    expect(await handshake(url, { 'X-Forwarded-For': '198.51.100.3' })).toBe(403);
  });

  it('counts a connection that never authenticates (engine-level), so anonymous clients cannot pile up', async () => {
    const { url, realtime } = await start({ ...BIG, perClientMax: 1 });
    expect(await handshake(url)).toBe(200); // an engine session that never sends a Socket.IO connect packet
    expect(realtime.io.engine.clientsCount).toBe(1);
    expect(await handshake(url)).toBe(403);
  });
});

describe('connection caps hold under a concurrent burst (atomic slot reservation)', () => {
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const settle = async (realtime, predicate, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end && !predicate(realtime.connectionStats())) await pause(20);
    return realtime.connectionStats();
  };
  // engine.io awaits generateId between allowRequest and the new session being announced; a slow one
  // widens that gap so that a count taken only at 'connection' would let the whole burst through.
  const slowIds = async () => { await pause(80); return Math.random().toString(36).slice(2); };
  const open = (url, token = 't') => new Promise((resolve) => {
    const socket = connect(url, { auth: { token }, transports: ['websocket'], reconnection: false });
    socket.on('connect', () => resolve({ socket }));
    socket.on('connect_error', (error) => { socket.close(); resolve({ error }); });
  });

  async function startWith(limits, trustPeer) {
    const server = http.createServer();
    const authenticate = (token) => (token === 't' ? { type: 'jwt', jti: 'x', expiresAt: Date.now() + 60_000 } : null);
    const realtime = createRealtime(server, authenticate, undefined, trustPeer, limits);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    return { realtime, url: `http://127.0.0.1:${server.address().port}` };
  }

  it('N simultaneous handshakes from one client against a cap of M let exactly M through', async () => {
    const { url, realtime } = await startWith({ ...BIG, perClientMax: 3, generateId: slowIds });
    const statuses = await Promise.all(Array.from({ length: 12 }, () => handshake(url)));
    expect(statuses.filter((s) => s === 200)).toHaveLength(3);
    expect(statuses.filter((s) => s === 403)).toHaveLength(9);
    expect(realtime.connectionStats()).toMatchObject({ open: 3, pending: 0 });
  });

  it('the overall cap holds across clients in a burst too', async () => {
    const { url, realtime } = await startWith({ ...BIG, totalMax: 4, generateId: slowIds }, () => true);
    const statuses = await Promise.all(Array.from({ length: 10 }, (_, i) => handshake(url, { 'X-Forwarded-For': `198.51.100.${i + 1}` })));
    expect(statuses.filter((s) => s === 200)).toHaveLength(4);
    expect(realtime.connectionStats().open).toBe(4);
  });

  it('WebSocket bursts are capped exactly as well, and every slot is released when the sockets close', async () => {
    const { url, realtime } = await startWith({ ...BIG, perClientMax: 3, generateId: slowIds });
    const results = await Promise.all(Array.from({ length: 10 }, () => open(url)));
    const sockets = results.filter((r) => r.socket).map((r) => r.socket);
    expect(sockets).toHaveLength(3);
    expect(realtime.connectionStats()).toMatchObject({ open: 3, pending: 0 });
    sockets.forEach((s) => s.close());
    expect(await settle(realtime, (s) => s.open === 0)).toEqual({ open: 0, pending: 0, openClients: 0, pendingClients: 0 });
    const again = await open(url);
    expect(again.socket?.connected).toBe(true); // the full cap is available again
    again.socket?.close();
  });

  it('failed-auth handshakes release their slots (the server ends the session it refused)', async () => {
    const { url, realtime } = await startWith({ ...BIG, perClientMax: 3, generateId: slowIds });
    const bad = await Promise.all(Array.from({ length: 8 }, () => open(url, 'wrong')));
    expect(bad.every((r) => r.error)).toBe(true);
    expect(await settle(realtime, (s) => s.open === 0 && s.pending === 0)).toEqual({ open: 0, pending: 0, openClients: 0, pendingClients: 0 });
    // and a legitimate client is not locked out by the failures
    const good = await Promise.all(Array.from({ length: 3 }, () => open(url)));
    expect(good.filter((r) => r.socket)).toHaveLength(3);
    good.forEach((r) => r.socket?.close());
  });

  it('a handshake that passes allowRequest but never becomes a session frees its slot after the TTL', async () => {
    const stuck = () => new Promise(() => {}); // never resolves
    const { url, realtime } = await startWith({ ...BIG, perClientMax: 1, generateId: stuck, pendingTtlMs: 150 });
    const first = handshake(url).catch(() => 'aborted');
    await settle(realtime, (s) => s.pending === 1);
    expect(await handshake(url)).toBe(403); // the reservation is counted while it is pending
    expect(await settle(realtime, (s) => s.pending === 0)).toMatchObject({ open: 0, pending: 0, pendingClients: 0 });
    void first;
  });

  it('a handshake that fails after allowRequest frees its slot at once, not at the TTL', async () => {
    const failing = async () => { throw new Error('id source down'); };
    const { url, realtime } = await startWith({ ...BIG, perClientMax: 1, generateId: failing, pendingTtlMs: 600_000 });
    await handshake(url);
    expect(await settle(realtime, (s) => s.pending === 0, 1000)).toMatchObject({ open: 0, pending: 0 });
  });
});

describe('the server ends a session whose token it refused', () => {
  // A raw WebSocket speaking the Engine.IO / Socket.IO framing by hand, that never closes itself:
  // anything that ends the connection is the server's doing.
  function rawSession(url, authToken) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${url.replace('http', 'ws')}/socket.io/?EIO=4&transport=websocket`);
      const seen = { frames: [], closedAt: null, openedAt: null };
      ws.onerror = () => reject(new Error('websocket error'));
      ws.onmessage = (event) => {
        const frame = String(event.data);
        seen.frames.push(frame);
        if (frame.startsWith('0')) { seen.openedAt = Date.now(); ws.send(`40${JSON.stringify({ token: authToken })}`); }
        if (frame === '2') ws.send('3'); // answer pings so only the server can end this
      };
      ws.onclose = () => { seen.closedAt = Date.now(); resolve(seen); };
      seen.ws = ws;
      setTimeout(() => { if (!seen.closedAt) { ws.close(); resolve({ ...seen, neverClosedByServer: true }); } }, 4000).unref();
    });
  }

  it('closes the connection after sending the refusal, and the slot is freed', async () => {
    const server = http.createServer();
    const realtime = createRealtime(server, (token) => (token === 't' ? { type: 'jwt', jti: 'x', expiresAt: Date.now() + 60_000 } : null), undefined, () => false, BIG);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const url = `http://127.0.0.1:${server.address().port}`;

    const refused = await rawSession(url, 'wrong');
    expect(refused.neverClosedByServer).toBeUndefined();
    expect(refused.frames.some((f) => f.startsWith('44') && f.includes('Unauthorized'))).toBe(true); // told why first
    expect(refused.closedAt - refused.openedAt).toBeLessThan(2000);
    expect(realtime.connectionStats()).toMatchObject({ open: 0, pending: 0 });

    // control: a valid token is NOT closed
    const accepted = await Promise.race([rawSession(url, 't'), new Promise((resolve) => setTimeout(() => resolve({ stillOpen: true }), 1500))]);
    expect(accepted.stillOpen).toBe(true);
    expect(realtime.connectionStats().open).toBe(1);
  });
});

describe('a handshake that outlives its reservation cannot overshoot the cap', () => {
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  it('its session is closed on arrival; the slot it gave up is not double-counted', async () => {
    const server = http.createServer();
    // The id source takes 400 ms; the reservation lasts 100 ms.
    const realtime = createRealtime(server, () => ({ type: 'jwt', jti: 'x', expiresAt: Date.now() + 60_000 }), undefined, () => false,
      { ...BIG, perClientMax: 1, pendingTtlMs: 100, generateId: async () => { await pause(400); return Math.random().toString(36).slice(2); } });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const url = `http://127.0.0.1:${server.address().port}`;

    const slow = handshake(url).catch(() => 'closed'); // reserves the only slot, then times out before its session exists
    await pause(150);
    expect(realtime.connectionStats().pending).toBe(0); // the TTL gave the slot back
    const second = handshake(url).catch(() => 'closed'); // admitted into the freed slot (it, too, is slow)
    await Promise.all([slow, second]);
    await pause(300);
    // two handshakes were admitted for a cap of one; only one session may survive, and the stats agree with the engine
    expect(realtime.io.engine.clientsCount).toBeLessThanOrEqual(1);
    expect(realtime.connectionStats().open).toBe(realtime.io.engine.clientsCount);
  });
});

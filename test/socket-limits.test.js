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

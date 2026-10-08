import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import http from 'http';
import { io as connect } from 'socket.io-client';
import request from 'supertest';
import './setup.js';
import pkg from '../server.js';
import { TEST_USERNAME, TEST_PASSWORD } from './setup.js';
import { createRealtime } from '../lib/realtime.js';

const { app, server, db } = pkg;
let base;

beforeAll(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
const closeServer = (srv) => new Promise((resolve) => {
  srv.close(resolve);
  srv.closeAllConnections();
});
afterAll(() => closeServer(server));

async function login() {
  const res = await request(app).post('/api/auth/login').send({ username: TEST_USERNAME, password: TEST_PASSWORD });
  return res.body.token;
}
const post = (url, token) => request(app).post(url).set('Authorization', `Bearer ${token}`);

function openSocket(token, url = base) {
  const socket = connect(url, { auth: { token }, transports: ['websocket'], reconnection: false });
  return new Promise((resolve, reject) => {
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}
const disconnected = (socket) => new Promise((resolve) => socket.on('disconnect', resolve));

// Engine.io polling handshake with an explicit Origin header; the status is what allowRequest decides.
function handshake(url, origin) {
  return new Promise((resolve, reject) => {
    const headers = origin ? { Origin: origin } : {};
    http.get(`${url}/socket.io/?EIO=4&transport=polling`, { headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}

describe('Socket.IO origin enforcement (#56)', () => {
  it('accepts a same-origin handshake (Origin host equals request Host)', async () => {
    expect(await handshake(base, base)).toBe(200);
  });

  it('accepts a handshake with no Origin header (same-origin polling GET, non-browser client)', async () => {
    expect(await handshake(base, undefined)).toBe(200);
  });

  it('refuses a cross-origin handshake', async () => {
    expect(await handshake(base, 'https://elsewhere.example')).toBe(403);
  });

  it('refuses a malformed Origin', async () => {
    expect(await handshake(base, 'not a url')).toBe(403);
  });

  it('refuses a cross-origin WebSocket upgrade', async () => {
    const socket = connect(base, {
      auth: { token: await login() },
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: { Origin: 'https://elsewhere.example' },
    });
    await expect(new Promise((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('connect_error', reject);
    })).rejects.toBeTruthy();
    socket.close();
  });

  describe('with APP_ORIGIN set', () => {
    let appServer;
    let appUrl;
    beforeAll(async () => {
      process.env.APP_ORIGIN = 'https://butler.example';
      appServer = http.createServer();
      createRealtime(appServer, () => ({ type: 'jwt', jti: 'x' }));
      delete process.env.APP_ORIGIN;
      await new Promise((resolve) => appServer.listen(0, '127.0.0.1', resolve));
      appUrl = `http://127.0.0.1:${appServer.address().port}`;
    });
    afterAll(() => closeServer(appServer));

    it('accepts only the configured origin', async () => {
      expect(await handshake(appUrl, 'https://butler.example')).toBe(200);
    });
    it('refuses a same-host origin that is not the configured one', async () => {
      expect(await handshake(appUrl, appUrl)).toBe(403);
    });
  });
});

describe('Socket.IO sessions end with their credential (#56)', () => {
  it('rejects a handshake with a bad token', async () => {
    await expect(openSocket('nope')).rejects.toThrow('Unauthorized');
  });

  it('disconnects a revoked device socket, and only that one', async () => {
    const jwtToken = await login();
    const a = (await post('/api/auth/device-token', jwtToken).send({ device_label: 'Socket A' })).body.token;
    const b = (await post('/api/auth/device-token', jwtToken).send({ device_label: 'Socket B' })).body.token;
    const sockA = await openSocket(a);
    const sockB = await openSocket(b);
    const sockJwt = await openSocket(jwtToken);

    const gone = disconnected(sockA);
    const idA = db.prepare("SELECT id FROM device_tokens WHERE device_label = 'Socket A'").get().id;
    expect((await post(`/api/auth/devices/${idA}/revoke`, jwtToken).send()).status).toBe(200);
    await gone;

    expect(sockA.connected).toBe(false);
    expect(sockB.connected).toBe(true);
    expect(sockJwt.connected).toBe(true);
    sockB.close();
    sockJwt.close();
  });

  it('disconnects every socket on revoke-all', async () => {
    const jwtToken = await login();
    const device = (await post('/api/auth/device-token', jwtToken).send({ device_label: 'Socket C' })).body.token;
    const sockDevice = await openSocket(device);
    const sockJwt = await openSocket(jwtToken);

    const gone = Promise.all([disconnected(sockDevice), disconnected(sockJwt)]);
    expect((await post('/api/auth/revoke-all', jwtToken).send()).status).toBe(200);
    await gone;

    expect(sockDevice.connected).toBe(false);
    expect(sockJwt.connected).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import request from 'supertest';
import { createRequire } from 'module';
import './setup.js';
import pkg from '../server.js';
import { TEST_USERNAME, TEST_PASSWORD } from './setup.js';
import { loadFreshApp } from './fresh-app.js';

// Loaded now, before any test loads a fresh app, so this is the logger instance `pkg` writes to.
const { currentLogFile, flush } = createRequire(import.meta.url)('../logger.js');

// OWNER DECISION: revoking a device and "Sign out everywhere" need a FRESH LOGIN (the household
// password re-entered in that request), whatever credential is presented, so a stolen device
// token alone cannot revoke anything. Listing devices stays open to any valid credential and
// minting stays household-JWT-only. These tests pin that; do not weaken them without the owner.

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

function harness(app) {
  const login = async () => (await request(app).post('/api/auth/login').send({ username: TEST_USERNAME, password: TEST_PASSWORD })).body.token;
  const mint = async (household, label) => {
    const res = await request(app).post('/api/auth/device-token').set(bearer(household)).send({ device_label: label });
    expect(res.status).toBe(200);
    return res.body.token;
  };
  const revoke = (token, id, body) => request(app).post(`/api/auth/devices/${id}/revoke`).set(bearer(token)).send(body);
  const revokeAll = (token, body) => request(app).post('/api/auth/revoke-all').set(bearer(token)).send(body);
  const works = async (token) => (await request(app).get('/api/items').set(bearer(token))).status === 200;
  return { login, mint, revoke, revokeAll, works };
}

describe('revocation needs the household password', () => {
  const { app, db } = pkg;
  const h = harness(app);
  const deviceId = (label) => db.prepare('SELECT id FROM device_tokens WHERE device_label = ?').get(label).id;

  it('refuses revoke and sign-out-everywhere without a password, for a JWT and a device token alike', async () => {
    const household = await h.login();
    const tablet = await h.mint(household, 'Step-up tablet');
    const phone = await h.mint(household, 'Step-up phone');
    const phoneId = deviceId('Step-up phone');

    for (const token of [household, tablet]) {
      for (const body of [{}, { password: '' }, { password: 12345 }, { password: { $ne: null } }]) {
        expect([403]).toContain((await h.revoke(token, phoneId, body)).status);
        expect([403]).toContain((await h.revokeAll(token, body)).status);
      }
    }
    expect(await h.works(phone)).toBe(true);
    expect(await h.works(tablet)).toBe(true);
    expect(await h.works(household)).toBe(true);
  });

  it('rejects a wrong password with 403 (not 401, which the client reads as an expired session)', async () => {
    const household = await h.login();
    const tablet = await h.mint(household, 'Wrong-pw tablet');
    const res = await h.revoke(tablet, deviceId('Wrong-pw tablet'), { password: 'not-the-password' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/incorrect/i);
    expect((await h.revokeAll(tablet, { password: 'not-the-password' })).status).toBe(403);
    expect(await h.works(tablet)).toBe(true);
  });

  it('a device token with the right password can revoke another device, and sign out everywhere', async () => {
    const household = await h.login();
    const tablet = await h.mint(household, 'Cut-off tablet');
    const phone = await h.mint(household, 'Lost phone');

    expect((await h.revoke(tablet, deviceId('Lost phone'), { password: TEST_PASSWORD })).status).toBe(200);
    expect(await h.works(phone)).toBe(false);
    expect(await h.works(tablet)).toBe(true);

    expect((await h.revokeAll(tablet, { password: TEST_PASSWORD })).status).toBe(200);
    expect(await h.works(tablet)).toBe(false);
    expect(await h.works(household)).toBe(false);
  });

  it('still lists devices for any valid credential without a password, and keeps minting household-only', async () => {
    const household = await h.login();
    const tablet = await h.mint(household, 'Lister tablet');
    expect((await request(app).get('/api/auth/devices').set(bearer(tablet))).status).toBe(200);
    expect((await request(app).get('/api/auth/devices').set(bearer(household))).status).toBe(200);
    const mintFromDevice = await request(app).post('/api/auth/device-token').set(bearer(tablet)).send({ device_label: 'Nope' });
    expect(mintFromDevice.status).toBe(403);
  });

  it('never records the re-entered password in the action log', async () => {
    const household = await h.login();
    const tablet = await h.mint(household, 'Logged tablet');
    const marker = 'Zq9-unique-wrong-password-marker';
    await h.revoke(tablet, deviceId('Logged tablet'), { password: marker });
    await h.revokeAll(tablet, { password: marker });
    await h.revoke(household, deviceId('Logged tablet'), { password: TEST_PASSWORD });
    await flush();
    const raw = fs.readFileSync(currentLogFile(), 'utf8');
    expect(raw).toContain('/revoke');
    expect(raw).not.toContain(marker);
    expect(raw).not.toContain(TEST_PASSWORD);
  });
});

describe('re-authentication shares the login limits', () => {
  it('failed re-auth attempts spend the per-client login limit, so login is throttled too', async () => {
    const { app, db } = loadFreshApp({ LOGIN_RATE_LIMIT_MAX: '3' });
    const h = harness(app);
    const household = await h.login(); // attempt 1
    const tablet = await h.mint(household, 'Limit tablet');
    const id = db.prepare("SELECT id FROM device_tokens WHERE device_label = 'Limit tablet'").get().id;

    expect((await h.revoke(tablet, id, { password: 'wrong' })).status).toBe(403); // 2
    expect((await h.revokeAll(tablet, { password: 'wrong' })).status).toBe(403); // 3
    const blocked = await h.revoke(tablet, id, { password: TEST_PASSWORD });
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeTruthy();
    expect(await h.works(tablet)).toBe(true);
    const loginBlocked = await request(app).post('/api/auth/login').send({ username: TEST_USERNAME, password: TEST_PASSWORD });
    expect(loginBlocked.status).toBe(429);
  });

  it('failed re-auth attempts feed the account-wide backoff, which a correct login then resets', async () => {
    const { app } = loadFreshApp({ LOGIN_RATE_LIMIT_MAX: '1000' });
    const h = harness(app);
    const household = await h.login();
    const tablet = await h.mint(household, 'Backoff tablet');
    for (let i = 0; i < 3; i++) expect((await h.revokeAll(tablet, { password: 'wrong' })).status).toBe(403);

    // The next attempt of any kind has to wait its backoff gap (500 ms at the first step).
    const started = Date.now();
    expect((await request(app).post('/api/auth/login').send({ username: TEST_USERNAME, password: TEST_PASSWORD })).status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);

    const resetStart = Date.now();
    expect((await h.revokeAll(tablet, { password: 'wrong' })).status).toBe(403);
    expect(Date.now() - resetStart).toBeLessThan(300);
  });
});

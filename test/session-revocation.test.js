import { describe, it, expect, vi } from 'vitest';
import crypto from 'crypto';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { createRequire } from 'module';
import './setup.js';
import pkg from '../server.js';
import { TEST_USERNAME, TEST_PASSWORD, TEST_TOKEN } from './setup.js';
import { createAuthState } from '../lib/auth-state.js';
import { createAuth } from '../lib/middleware.js';

// routes/auth.js loads the CJS build of bcryptjs; the ESM import above is a separate instance.
const bcryptCjs = createRequire(import.meta.url)('bcryptjs');
const { app, db } = pkg;
const authState = createAuthState(db);
const auth = createAuth(db);

// The login limiter allows 5 attempts per window, so only tests about the login route itself
// use it; everything else signs a session JWT for the current epoch directly.
async function login() {
  const res = await request(app).post('/api/auth/login').send({ username: TEST_USERNAME, password: TEST_PASSWORD });
  expect(res.status).toBe(200);
  return res.body.token;
}
const session = () =>
  jwt.sign({ sub: TEST_USERNAME, ver: authState.getEpoch() }, process.env.JWT_SECRET, { expiresIn: '30d', jwtid: crypto.randomUUID() });

const get = (url, token) => request(app).get(url).set('Authorization', `Bearer ${token}`);
const post = (url, token) => request(app).post(url).set('Authorization', `Bearer ${token}`);

async function mintDevice(jwtToken, label = 'Tablet') {
  const res = await post('/api/auth/device-token', jwtToken).send({ device_label: label });
  expect(res.status).toBe(200);
  return res.body.token;
}

describe('household JWT versioning (#49)', () => {
  it('login issues a JWT carrying the current epoch and a jti, still valid for 30 days', async () => {
    const decoded = jwt.decode(await login());
    expect(decoded.ver).toBe(authState.getEpoch());
    expect(typeof decoded.jti).toBe('string');
    expect(decoded.exp - decoded.iat).toBe(30 * 24 * 60 * 60);
  });

  it('rejects a legacy JWT that has no epoch claim', async () => {
    const legacy = jwt.sign({ sub: TEST_USERNAME }, process.env.JWT_SECRET, { expiresIn: '30d' });
    expect((await get('/api/items', legacy)).status).toBe(401);
  });

  it('rejects an HS384-signed token even with the right secret', async () => {
    const t = jwt.sign({ sub: TEST_USERNAME, ver: authState.getEpoch() }, process.env.JWT_SECRET, { algorithm: 'HS384' });
    expect(auth.authenticateToken(t)).toBeNull();
  });

  it('rejects a JWT after the epoch is bumped', async () => {
    const token = session();
    expect((await get('/api/items', token)).status).toBe(200);
    authState.revokeAllSessions();
    expect((await get('/api/items', token)).status).toBe(401);
    expect((await get('/api/items', session())).status).toBe(200);
  });
});

describe('credential fingerprint / password rotation (#49)', () => {
  const hashA = bcrypt.hashSync('one', 4);
  const hashB = bcrypt.hashSync('two', 4);

  it('first run stores the fingerprint without bumping the epoch', () => {
    db.prepare('UPDATE auth_state SET credential_fingerprint = NULL').run();
    const epoch = authState.getEpoch();
    expect(authState.syncCredentialFingerprint('u', hashA)).toBe('initialised');
    expect(authState.getEpoch()).toBe(epoch);
  });

  it('an unchanged credential leaves the epoch alone', () => {
    const epoch = authState.getEpoch();
    expect(authState.syncCredentialFingerprint('u', hashA)).toBe('unchanged');
    expect(authState.getEpoch()).toBe(epoch);
  });

  it('a rotated password hash bumps the epoch and revokes every device token', async () => {
    const jwtToken = session();
    const device = await mintDevice(jwtToken, 'Before rotation');
    const epoch = authState.getEpoch();

    expect(authState.syncCredentialFingerprint('u', hashB)).toBe('rotated');

    expect(authState.getEpoch()).toBe(epoch + 1);
    expect((await get('/api/items', jwtToken)).status).toBe(401);
    expect((await get('/api/items', device)).status).toBe(401);
  });

  it('a changed username alone also counts as rotation', () => {
    expect(authState.syncCredentialFingerprint('someone-else', hashB)).toBe('rotated');
  });

  it('never stores the hash itself', () => {
    const row = db.prepare('SELECT * FROM auth_state').get();
    expect(JSON.stringify(row)).not.toContain(hashA);
    expect(JSON.stringify(row)).not.toContain(hashB);
  });
});

describe('device-token issuance (#54)', () => {
  it('a household JWT can mint a device token, and the issuing jti is recorded', async () => {
    const token = session();
    await mintDevice(token, 'Provenance tablet');
    const row = db.prepare("SELECT issued_by_jti FROM device_tokens WHERE device_label = 'Provenance tablet'").get();
    expect(row.issued_by_jti).toBe(jwt.decode(token).jti);
  });

  it('a device token cannot mint another device token', async () => {
    const device = await mintDevice(session(), 'Parent tablet');
    const res = await post('/api/auth/device-token', device).send({ device_label: 'Child' });
    expect(res.status).toBe(403);
    expect(db.prepare("SELECT COUNT(*) AS n FROM device_tokens WHERE device_label = 'Child'").get().n).toBe(0);
  });

  it('a device token can list devices, and revoke one when the password is re-entered', async () => {
    const device = await mintDevice(session(), 'Manager tablet');
    expect((await get('/api/auth/devices', device)).status).toBe(200);
    const other = db.prepare("SELECT id FROM device_tokens WHERE device_label = 'Manager tablet'").get();
    expect((await post(`/api/auth/devices/${other.id}/revoke`, device).send({ password: TEST_PASSWORD })).status).toBe(200);
  });

  it('caps device_label length', async () => {
    const token = session();
    const res = await post('/api/auth/device-token', token).send({ device_label: 'x'.repeat(101) });
    expect(res.status).toBe(400);
    const ok = await post('/api/auth/device-token', token).send({ device_label: 'x'.repeat(100) });
    expect(ok.status).toBe(200);
  });
});

describe('POST /api/auth/revoke-all (#49, #54)', () => {
  it('requires auth', async () => {
    expect((await request(app).post('/api/auth/revoke-all')).status).toBe(401);
  });

  it('invalidates every JWT and device token; a fresh login works afterwards', async () => {
    const jwtToken = session();
    const device = await mintDevice(jwtToken, 'Doomed tablet');

    const res = await post('/api/auth/revoke-all', jwtToken).send({ password: TEST_PASSWORD });
    expect(res.status).toBe(200);

    expect((await get('/api/items', jwtToken)).status).toBe(401);
    expect((await get('/api/items', device)).status).toBe(401);
    expect((await get('/api/items', TEST_TOKEN)).status).toBe(401);
    expect((await get('/api/items', await login())).status).toBe(200);
  });

  it('can be triggered from a device token with the password', async () => {
    const device = await mintDevice(session(), 'Panic tablet');
    expect((await post('/api/auth/revoke-all', device).send({ password: TEST_PASSWORD })).status).toBe(200);
    expect((await get('/api/items', device)).status).toBe(401);
  });
});

describe('POST /api/auth/login bcrypt failure (#61)', () => {
  it('answers a generic 500 rather than leaking the error', async () => {
    const spy = vi.spyOn(bcryptCjs, 'compare').mockRejectedValueOnce(new Error('Invalid salt version: secret-detail'));
    const res = await request(app).post('/api/auth/login').send({ username: TEST_USERNAME, password: TEST_PASSWORD });
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret-detail');
  });
});

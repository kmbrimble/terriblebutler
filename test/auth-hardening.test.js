import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRequire } from 'module';
import './setup.js';
import { TEST_USERNAME, TEST_PASSWORD } from './setup.js';

const nodeRequire = createRequire(import.meta.url);
const { registerLoginRoute, registerDeviceTokenRoutes } = nodeRequire('../routes/auth.js');
const bcrypt = nodeRequire('bcryptjs');

const noBackoff = () => ({ reserve: vi.fn(() => ({ waitMs: 0 })), recordSuccess: vi.fn() });
const passthrough = (req, res, next) => next();

function loginApp(compare, backoff = noBackoff()) {
  const app = express();
  app.use(express.json());
  registerLoginRoute(app, {
    loginRateLimiter: passthrough,
    loginBackoff: backoff,
    AUTH_USERNAME: TEST_USERNAME,
    AUTH_PASSWORD_HASH: process.env.AUTH_PASSWORD_HASH,
    JWT_KEY: Buffer.from(process.env.JWT_SECRET, 'hex'),
    authState: { getEpoch: () => 1 },
    compare,
  });
  return app;
}

function stepUpApp(compare, backoff = noBackoff()) {
  const app = express();
  app.use(express.json());
  const revokeAll = vi.fn();
  registerDeviceTokenRoutes(app, {
    db: null,
    hashDeviceToken: (t) => t,
    requireHouseholdJwt: passthrough,
    authState: { revokeAllSessions: revokeAll },
    disconnectSockets: () => {},
    loginRateLimiter: passthrough,
    loginBackoff: backoff,
    AUTH_PASSWORD_HASH: process.env.AUTH_PASSWORD_HASH,
    compare,
  });
  return { app, revokeAll };
}

const login = (app, password) => request(app).post('/api/auth/login').send({ username: TEST_USERNAME, password });
const revokeAll = (app, password) => request(app).post('/api/auth/revoke-all').send({ password });

describe('bcrypt comparator failure', () => {
  it('login answers a generic 500 and leaks nothing when the comparator throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = loginApp(async () => { throw new Error('Invalid salt revision sentinel-detail'); });
    const res = await login(app, TEST_PASSWORD);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Login is unavailable.' });
    expect(JSON.stringify(res.body) + JSON.stringify(res.headers)).not.toContain('sentinel-detail');
    expect(error).toHaveBeenCalled(); // logged server-side
    error.mockRestore();
  });

  it('step-up re-authentication answers a generic 500 and does not revoke anything', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app, revokeAll: spy } = stepUpApp(async () => { throw new Error('sentinel-detail'); });
    const res = await revokeAll(app, TEST_PASSWORD);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Re-authentication is unavailable.' });
    expect(spy).not.toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('password length bound (1024 bytes)', () => {
  const huge = 'p'.repeat(1025);

  it('login: an over-long password is the same 401 as a wrong one, and bcrypt never sees it', async () => {
    const compare = vi.fn(async () => false);
    const app = loginApp(compare);
    const wrong = await login(app, 'wrong-password');
    const long = await login(app, huge);
    expect(long.status).toBe(wrong.status);
    expect(long.status).toBe(401);
    expect(long.body).toEqual(wrong.body);
    expect(compare).toHaveBeenCalledTimes(1); // only the ordinary wrong password
  });

  it('login: the bound is in bytes, not characters', async () => {
    const compare = vi.fn(async () => false);
    const app = loginApp(compare);
    await login(app, '€'.repeat(400)); // 400 characters but 1200 bytes
    expect(compare).not.toHaveBeenCalled();
    await login(app, 'p'.repeat(1024)); // exactly the limit
    expect(compare).toHaveBeenCalledTimes(1);
  });

  it('login: an over-long password still takes a backoff slot, like any wrong attempt', async () => {
    const backoff = noBackoff();
    const app = loginApp(vi.fn(async () => true), backoff);
    const res = await login(app, huge);
    expect(res.status).toBe(401);
    expect(backoff.reserve).toHaveBeenCalledTimes(1);
    expect(backoff.recordSuccess).not.toHaveBeenCalled();
  });

  it('login: a correct password in the normal range still succeeds', async () => {
    const app = loginApp(bcrypt.compare);
    const res = await login(app, TEST_PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  it('step-up: an over-long password is the same 403 as a wrong one, never reaches bcrypt, revokes nothing', async () => {
    const compare = vi.fn(async () => false);
    const { app, revokeAll: spy } = stepUpApp(compare);
    const wrong = await revokeAll(app, 'wrong-password');
    const long = await revokeAll(app, huge);
    expect(long.status).toBe(403);
    expect(long.status).toBe(wrong.status);
    expect(long.body).toEqual(wrong.body);
    expect(compare).toHaveBeenCalledTimes(1);
    expect(spy).not.toHaveBeenCalled();
  });
});

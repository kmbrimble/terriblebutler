import { describe, it, expect } from 'vitest';
import request from 'supertest';
import './setup.js';
import { api } from './setup.js';
import pkg from '../server.js';
import { loadFreshApp } from './fresh-app.js';

const { app } = pkg;

describe('Stage 3-lite features', () => {
  it('healthz returns status only, never the version', async () => {
    const res = await request(app).get('/healthz');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('/api/health shows the version only to an authenticated caller', async () => {
    expect((await request(app).get('/api/health')).body).toEqual({ status: 'ok' });
    expect((await request(app).get('/api/health').set('Authorization', 'Bearer nope')).body).toEqual({ status: 'ok' });
    const authed = await api(app).get('/api/health');
    expect(authed.body.status).toBe('ok');
    expect(typeof authed.body.version).toBe('string');
  });

  it('healthz is not under /api and not rate limited', async () => {
    const res = await request(app).get('/healthz');

    expect(res.headers['ratelimit-limit']).toBeUndefined();
  });

  it('security headers are present', async () => {
    const res = await api(app).get('/api/locations');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('camera is allowed in Permissions-Policy', async () => {
    const res = await api(app).get('/api/locations');

    expect(res.headers['permissions-policy']).toBeDefined();
    expect(res.headers['permissions-policy']).toContain('camera=(self)');
  });

  it('x-powered-by header is disabled', async () => {
    const res = await api(app).get('/api/locations');

    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('api responses include rate limit headers', async () => {
    const res = await api(app).get('/api/locations');

    expect(res.headers['ratelimit-limit']).toBe('240');
  });

  it('the mutation rate limit stays at its production default of 90/min when MUTATION_RATE_LIMIT_MAX is unset', async () => {
    const res = await api(app).post('/api/locations').send({ name: `Rate Limit Default ${Date.now()}` });

    expect(res.headers['ratelimit-limit']).toBe('90');
  });

  it('the general API rate limit stays at its production default of 240/min when GENERAL_API_RATE_LIMIT_MAX is unset', async () => {
    const res = await api(app).get('/api/locations');

    expect(res.headers['ratelimit-limit']).toBe('240');
  });

  it('the login rate limit stays at its production default of 5/15min when LOGIN_RATE_LIMIT_MAX is unset', async () => {
    const { app: freshApp } = loadFreshApp({ LOGIN_RATE_LIMIT_MAX: undefined });
    const res = await request(freshApp).post('/api/auth/login').send({ username: 'nobody', password: 'wrong' });

    expect(res.headers['ratelimit-limit']).toBe('5');
  });
});

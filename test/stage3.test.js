import { describe, it, expect } from 'vitest';
import request from 'supertest';
import './setup.js';
import pkg from '../server.js';

const { app } = pkg;

describe('Stage 3-lite features', () => {
  it('healthz returns ok', async () => {
    const res = await request(app).get('/healthz');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('healthz is not under /api and not rate limited', async () => {
    const res = await request(app).get('/healthz');

    expect(res.headers['ratelimit-limit']).toBeUndefined();
  });

  it('security headers are present', async () => {
    const res = await request(app).get('/api/locations');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('camera is allowed in Permissions-Policy', async () => {
    const res = await request(app).get('/api/locations');

    expect(res.headers['permissions-policy']).toBeDefined();
    expect(res.headers['permissions-policy']).toContain('camera=(self)');
  });

  it('x-powered-by header is disabled', async () => {
    const res = await request(app).get('/api/locations');

    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('api responses include rate limit headers', async () => {
    const res = await request(app).get('/api/locations');

    expect(res.headers['ratelimit-limit']).toBe('240');
  });
});

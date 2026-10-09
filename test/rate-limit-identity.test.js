// A 429 says which limiter fired (body `limiter`, header RateLimit-Policy) so a client can word it truthfully.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import './setup.js';
import { TEST_TOKEN } from './setup.js';
import { loadFreshApp } from './fresh-app.js';

const authed = (test) => test.set('Authorization', `Bearer ${TEST_TOKEN}`);

describe('429 responses identify the limiter', () => {
  it('login: limiter "login", with its quota and 15-minute window in RateLimit-Policy', async () => {
    const { app } = loadFreshApp({ LOGIN_RATE_LIMIT_MAX: '2', GENERAL_API_RATE_LIMIT_MAX: '1000', MUTATION_RATE_LIMIT_MAX: '1000' });
    await request(app).post('/api/auth/login').send({});
    await request(app).post('/api/auth/login').send({});
    const res = await request(app).post('/api/auth/login').send({});
    expect(res.status).toBe(429);
    expect(res.body.limiter).toBe('login');
    expect(res.headers['ratelimit-policy']).toBe('2;w=900;name="login"');
    expect(res.headers['ratelimit-limit']).toBe('2');
  });

  it('step-up (revoke-all) shares the login limiter and says so', async () => {
    const { app } = loadFreshApp({ LOGIN_RATE_LIMIT_MAX: '1', GENERAL_API_RATE_LIMIT_MAX: '1000', MUTATION_RATE_LIMIT_MAX: '1000' });
    await authed(request(app).post('/api/auth/revoke-all')).send({ password: 'wrong' });
    const res = await authed(request(app).post('/api/auth/revoke-all')).send({ password: 'wrong' });
    expect(res.status).toBe(429);
    expect(res.body.limiter).toBe('login');
  });

  it('the general API limiter names itself "api" (not login) on a revoke request', async () => {
    const { app } = loadFreshApp({ GENERAL_API_RATE_LIMIT_MAX: '1', LOGIN_RATE_LIMIT_MAX: '1000', MUTATION_RATE_LIMIT_MAX: '1000' });
    await authed(request(app).get('/api/locations'));
    const res = await authed(request(app).post('/api/auth/revoke-all')).send({ password: 'x' });
    expect(res.status).toBe(429);
    expect(res.body.limiter).toBe('api');
    expect(res.headers['ratelimit-policy']).toBe('1;w=60;name="api"');
  });

  it('the mutation limiter names itself "mutation"', async () => {
    const { app } = loadFreshApp({ MUTATION_RATE_LIMIT_MAX: '1', GENERAL_API_RATE_LIMIT_MAX: '1000', LOGIN_RATE_LIMIT_MAX: '1000' });
    await authed(request(app).post('/api/locations')).send({ name: 'Limiter identity A' });
    const res = await authed(request(app).post('/api/locations')).send({ name: 'Limiter identity B' });
    expect(res.status).toBe(429);
    expect(res.body.limiter).toBe('mutation');
  });

  it('every response (not just a 429) carries the policy', async () => {
    const { app } = loadFreshApp({ GENERAL_API_RATE_LIMIT_MAX: '1000' });
    const res = await authed(request(app).get('/api/locations'));
    expect(res.headers['ratelimit-policy']).toBe('1000;w=60;name="api"');
  });
});

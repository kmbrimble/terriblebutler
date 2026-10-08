import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';
import './setup.js';
import { api, TEST_TOKEN } from './setup.js';
import { loadFreshApp } from './fresh-app.js';

// Fresh copy so the production 5-per-15-minutes login limit applies to the limiter under test.
const { app } = loadFreshApp({ LOGIN_RATE_LIMIT_MAX: '5' });
const middleware = createRequire(import.meta.url)('../lib/middleware.js');
const { parseBearerToken, loginRateLimiter } = middleware;

afterEach(() => vi.restoreAllMocks());

describe('rate-limit headers are in seconds, not an epoch timestamp', () => {
  const capture = () => ({ headers: {}, code: 200, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json() {} });

  it('RateLimit-Reset counts down the seconds left in the window', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const first = capture();
    loginRateLimiter({ ip: '192.0.2.10', socket: {} }, first, () => {});
    expect(first.headers['RateLimit-Reset']).toBe('900');

    now.mockReturnValue(1_700_000_000_000 + 600_500);
    const later = capture();
    loginRateLimiter({ ip: '192.0.2.10', socket: {} }, later, () => {});
    expect(later.headers['RateLimit-Reset']).toBe('300');
  });

  it('a 429 carries Retry-After equal to RateLimit-Reset', () => {
    let res;
    for (let i = 0; i < 6; i++) {
      res = capture();
      loginRateLimiter({ ip: '192.0.2.11', socket: {} }, res, () => {});
    }
    expect(res.code).toBe(429);
    expect(res.headers['Retry-After']).toBe(res.headers['RateLimit-Reset']);
    expect(Number(res.headers['Retry-After'])).toBeLessThanOrEqual(900);
  });

  it('every limiter on the real app reports a small number of seconds', async () => {
    const res = await api(app).get('/api/locations');
    const reset = Number(res.headers['ratelimit-reset']);
    expect(reset).toBeGreaterThanOrEqual(1);
    expect(reset).toBeLessThanOrEqual(60);
    const mutation = await api(app).post('/api/locations').send({ name: `Reset ${Date.now()}` });
    expect(Number(mutation.headers['ratelimit-reset'])).toBeLessThanOrEqual(60);
  });
});

describe('Authorization header parsing', () => {
  it.each([
    ['Bearer abc.def-ghi_jkl~+/=', 'abc.def-ghi_jkl~+/='],
    ['bearer abc', 'abc'],
    ['BEARER abc', 'abc'],
    ['Bearer   abc', 'abc'],
  ])('accepts %j', (header, token) => {
    expect(parseBearerToken(header)).toBe(token);
  });

  it.each([
    undefined, '', 'Bearer', 'Bearer ', 'Bearer  ', 'Basic abc', 'Bearerabc', ' Bearer abc', 'Bearer abc ',
    'Bearer abc def', 'Bearer abc\tdef', 'Bearer abc,def', 'Bearer "abc"', 'Bearer=abc', 'Token abc', ['Bearer abc'],
  ])('rejects %j', (header) => {
    expect(parseBearerToken(header)).toBeNull();
  });

  it('requireAuth honours a lower-case scheme but not trailing parts', async () => {
    expect((await request(app).get('/api/items').set('Authorization', `bearer ${TEST_TOKEN}`)).status).toBe(200);
    expect((await request(app).get('/api/items').set('Authorization', `Bearer ${TEST_TOKEN} extra`)).status).toBe(401);
    expect((await request(app).get('/api/items').set('Authorization', `Bearer ${TEST_TOKEN},x`)).status).toBe(401);
    expect((await request(app).get('/api/items').set('Authorization', TEST_TOKEN)).status).toBe(401);
  });

  it('/api/health uses the same parser, so a malformed header never unlocks the version', async () => {
    expect((await request(app).get('/api/health').set('Authorization', `Bearer ${TEST_TOKEN}`)).body.version).toBeTruthy();
    expect((await request(app).get('/api/health').set('Authorization', `Bearer ${TEST_TOKEN} extra`)).body).toEqual({ status: 'ok' });
  });
});

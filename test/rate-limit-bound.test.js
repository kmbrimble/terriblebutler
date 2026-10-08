import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import './setup.js';

const middleware = createRequire(import.meta.url)('../lib/middleware.js');
const res = { setHeader() {}, status() { return this; }, json() {} };
const reqFor = (ip) => ({ ip, socket: {} });

describe('rate limiter bucket maps', () => {
  it('stay bounded when many distinct clients arrive', () => {
    const { generalApiRateLimiter, MAX_RATE_LIMIT_BUCKETS } = middleware;
    for (let i = 0; i < MAX_RATE_LIMIT_BUCKETS + 100; i++) {
      generalApiRateLimiter(reqFor(`10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`), res, () => {});
    }
    expect(generalApiRateLimiter.buckets.size).toBeLessThanOrEqual(MAX_RATE_LIMIT_BUCKETS);
  });

  it('flooding one limiter never evicts another limiter\'s counts (login attempts)', () => {
    const { generalApiRateLimiter, loginRateLimiter, MAX_RATE_LIMIT_BUCKETS } = middleware;
    loginRateLimiter(reqFor('203.0.113.9'), res, () => {});
    for (let i = 0; i < MAX_RATE_LIMIT_BUCKETS + 100; i++) {
      generalApiRateLimiter(reqFor(`172.${i >> 16}.${(i >> 8) & 255}.${i & 255}`), res, () => {});
    }
    expect(loginRateLimiter.buckets.get('login:203.0.113.9').count).toBe(1);
  });
});

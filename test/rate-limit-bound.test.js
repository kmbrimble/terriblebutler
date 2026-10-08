import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import './setup.js';

const middleware = createRequire(import.meta.url)('../lib/middleware.js');

describe('rate limiter bucket map', () => {
  it('stays bounded when many distinct clients arrive', () => {
    const { generalApiRateLimiter, rateLimitBuckets, MAX_RATE_LIMIT_BUCKETS } = middleware;
    const res = { setHeader() {}, status() { return this; }, json() {} };
    for (let i = 0; i < MAX_RATE_LIMIT_BUCKETS + 100; i++) {
      generalApiRateLimiter({ ip: `10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`, socket: {} }, res, () => {});
    }
    expect(rateLimitBuckets.size).toBeLessThanOrEqual(MAX_RATE_LIMIT_BUCKETS);
  });
});

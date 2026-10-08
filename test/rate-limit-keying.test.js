import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import './setup.js';

const middleware = createRequire(import.meta.url)('../lib/middleware.js');
const { clientKey, loginRateLimiter, MAX_RATE_LIMIT_BUCKETS } = middleware;
const reqFor = (ip) => ({ ip, socket: {} });
const makeRes = () => ({ code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json() {} });
const hit = (limiter, ip) => { const res = makeRes(); limiter(reqFor(ip), res, () => {}); return res.code; };

describe('rate-limit client key', () => {
  it('keys IPv6 on its /64, however the address is written', () => {
    const key = clientKey(reqFor('2001:db8:1:2:aaaa:bbbb:cccc:dddd'));
    expect(key).toBe('2001:db8:1:2::/64');
    expect(clientKey(reqFor('2001:0DB8:0001:0002::1'))).toBe(key);
    expect(clientKey(reqFor('2001:db8:1:2::'))).toBe(key);
    expect(clientKey(reqFor('2001:db8:1:2:ffff:ffff:ffff:ffff%eth0'))).toBe(key);
    expect(clientKey(reqFor('2001:db8:1:3::1'))).not.toBe(key);
  });

  it('handles compression that reaches into the prefix and ::', () => {
    expect(clientKey(reqFor('2001:db8::1'))).toBe('2001:db8:0:0::/64');
    expect(clientKey(reqFor('::1'))).toBe('0:0:0:0::/64');
    expect(clientKey(reqFor('::'))).toBe('0:0:0:0::/64');
  });

  it('leaves IPv4 alone and folds IPv4-mapped IPv6 in either notation', () => {
    expect(clientKey(reqFor('203.0.113.7'))).toBe('203.0.113.7');
    expect(clientKey(reqFor('::ffff:203.0.113.7'))).toBe('203.0.113.7');
    expect(clientKey(reqFor('::ffff:cb00:7107'))).toBe('203.0.113.7');
  });

  it('shares one login bucket across a rotating IPv6 allocation', () => {
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push(hit(loginRateLimiter, `2001:db8:77:1:${i}::${i + 1}`));
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes.slice(5)).toEqual([429, 429]);
  });
});

describe('bucket eviction under flood', () => {
  it('never drops a bucket that is over its limit while unlocked buckets exist', () => {
    for (let i = 0; i < 7; i++) hit(loginRateLimiter, '198.51.100.1');
    expect(hit(loginRateLimiter, '198.51.100.1')).toBe(429);
    for (let i = 0; i < MAX_RATE_LIMIT_BUCKETS + 100; i++) {
      hit(loginRateLimiter, `10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`);
    }
    expect(loginRateLimiter.buckets.size).toBeLessThanOrEqual(MAX_RATE_LIMIT_BUCKETS);
    expect(hit(loginRateLimiter, '198.51.100.1')).toBe(429);
  });

  it('stays bounded even when every bucket is locked', () => {
    for (let i = 0; i < MAX_RATE_LIMIT_BUCKETS + 50; i++) {
      const ip = `100.${i >> 16}.${(i >> 8) & 255}.${i & 255}`;
      for (let n = 0; n < 6; n++) hit(loginRateLimiter, ip);
    }
    expect(loginRateLimiter.buckets.size).toBeLessThanOrEqual(MAX_RATE_LIMIT_BUCKETS);
  }, 60000);
});

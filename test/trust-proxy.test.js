import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import './setup.js';
import { TEST_USERNAME } from './setup.js';
import { loadFreshApp } from './fresh-app.js';

// Each mode needs a fresh app: TRUST_PROXY is read once at config load.
function loadApp(trustProxy) {
  return loadFreshApp({ TRUST_PROXY: trustProxy }).app;
}

// Burns the login limiter (5 attempts) for `forwardedFor`, then reports how a sixth attempt
// from the same and from a different forwarded address fare.
async function exhaustLogin(app, forwardedFor, otherForwardedFor) {
  const attempt = (xff) =>
    request(app).post('/api/auth/login').set('X-Forwarded-For', xff).send({ username: TEST_USERNAME, password: 'wrong-password' });
  for (let i = 0; i < 5; i++) expect((await attempt(forwardedFor)).status).toBe(401);
  return { same: (await attempt(forwardedFor)).status, other: (await attempt(otherForwardedFor)).status };
}

afterEach(() => {
  delete process.env.TRUST_PROXY;
});

describe('TRUST_PROXY parsing', () => {
  let parseTrustProxy;
  beforeEach(async () => {
    ({ parseTrustProxy } = await import('../lib/config.js'));
  });

  it('treats unset, empty and "false" as trust nothing', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('0')).toBe(false);
  });

  it('accepts a hop count', () => {
    expect(parseTrustProxy('2')).toBe(2);
  });

  it('accepts IPs, CIDRs and named ranges', () => {
    expect(parseTrustProxy('172.17.0.0/16, 172.18.0.5,loopback')).toEqual(['172.17.0.0/16', '172.18.0.5', 'loopback']);
  });

  it.each(['true', 'TRUE', '*', '10.0.0.1,*', '0.0.0.0/0', '::/0'])('rejects trust-everything value %s', (value) => {
    expect(() => parseTrustProxy(value)).toThrow(/must not trust every hop/);
  });

  it.each(['not-an-address', '999.1.1.1', '10.0.0.0/99', '1,2', '10.0.0.1,,10.0.0.2', '100'])('rejects malformed value %s', (value) => {
    expect(() => parseTrustProxy(value)).toThrow(/TRUST_PROXY/);
  });
});

describe('rate limiter client address', () => {
  it('unset: ignores X-Forwarded-For, so spoofed addresses all share the socket peer bucket', async () => {
    const app = loadApp(undefined);
    const { same, other } = await exhaustLogin(app, '203.0.113.7', '203.0.113.8');
    expect(same).toBe(429);
    expect(other).toBe(429);
  });

  it('hop count: keys on the forwarded client address', async () => {
    const app = loadApp('1');
    const { same, other } = await exhaustLogin(app, '203.0.113.7', '203.0.113.8');
    expect(same).toBe(429);
    expect(other).toBe(401);
  });

  it('address list including the peer: keys on the forwarded client address', async () => {
    const app = loadApp('loopback');
    const { same, other } = await exhaustLogin(app, '203.0.113.7', '203.0.113.8');
    expect(same).toBe(429);
    expect(other).toBe(401);
  });

  it('address list excluding the peer: ignores X-Forwarded-For (direct callers cannot spoof)', async () => {
    const app = loadApp('172.18.0.0/16');
    const { same, other } = await exhaustLogin(app, '203.0.113.7', '203.0.113.8');
    expect(same).toBe(429);
    expect(other).toBe(429);
  });

  it('walks past every trusted hop to the first untrusted address', async () => {
    const app = loadApp('loopback,172.17.0.0/16,172.18.0.0/16');
    // client, cloudflared hop, NPM hop (peer is loopback under supertest)
    const { same, other } = await exhaustLogin(app, '203.0.113.7, 172.17.0.7, 172.18.0.5', '203.0.113.8, 172.17.0.7, 172.18.0.5');
    expect(same).toBe(429);
    expect(other).toBe(401);
  });

  it('normalises IPv4-mapped IPv6 so both spellings share one bucket', async () => {
    const app = loadApp('loopback');
    const { same, other } = await exhaustLogin(app, '203.0.113.7', '::ffff:203.0.113.7');
    expect(same).toBe(429);
    expect(other).toBe(429);
  });
});

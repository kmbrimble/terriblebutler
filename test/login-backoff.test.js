import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRequire } from 'module';
import './setup.js';
import { TEST_USERNAME, TEST_PASSWORD } from './setup.js';

const require = createRequire(import.meta.url);
const { createLoginBackoff } = require('../lib/login-backoff.js');
const { registerLoginRoute } = require('../routes/auth.js');

function clocked(opts) {
  const clock = { t: 1_000_000 };
  return { clock, backoff: createLoginBackoff({ now: () => clock.t, ...opts }) };
}

describe('login backoff', () => {
  it('lets the first attempts through at once, then spaces them out up to the cap', () => {
    const { backoff } = clocked({ free: 2, baseMs: 100, capMs: 400, maxWaitMs: 100000 });
    const waits = Array.from({ length: 7 }, () => backoff.reserve().waitMs);
    // exactly `free` attempts run at once; the very next one already waits baseMs
    expect(waits.slice(0, 2)).toEqual([0, 0]);
    expect(waits[2]).toBe(100);
    // later gaps grow (doubling) and stop growing at the cap
    const gaps = waits.slice(2).map((w, i, arr) => (i ? w - arr[i - 1] : w));
    expect(gaps).toEqual([100, 100, 200, 400, 400]);
  });

  it('sheds load rather than queueing without bound, and says when to retry', () => {
    const { backoff } = clocked({ free: 0, baseMs: 100, capMs: 100, maxWaitMs: 250 });
    const results = Array.from({ length: 6 }, () => backoff.reserve());
    expect(results.slice(0, 3).every((r) => r.waitMs !== undefined)).toBe(true);
    expect(results[5].retryAfterMs).toBeGreaterThan(0);
  });

  it('a success resets it, and quiet time decays it', () => {
    const { backoff, clock } = clocked({ free: 1, baseMs: 100, capMs: 100, maxWaitMs: 100000, quietMs: 1000 });
    backoff.reserve(); backoff.reserve(); backoff.reserve();
    backoff.recordSuccess();
    expect(backoff.reserve().waitMs).toBe(0);
    backoff.reserve(); backoff.reserve();
    clock.t += 5000;
    expect(backoff.reserve().waitMs).toBe(0);
  });

  describe('on POST /api/auth/login', () => {
    function loginApp(loginBackoff, compare) {
      const app = express();
      app.use(express.json());
      registerLoginRoute(app, {
        loginRateLimiter: (req, res, next) => next(),
        loginBackoff,
        AUTH_USERNAME: process.env.AUTH_USERNAME,
        AUTH_PASSWORD_HASH: process.env.AUTH_PASSWORD_HASH,
        JWT_KEY: Buffer.from(process.env.JWT_SECRET, 'hex'),
        authState: { getEpoch: () => 1 },
        compare,
      });
      return app;
    }
    const attempt = (app, password) => request(app).post('/api/auth/login').send({ username: TEST_USERNAME, password });

    it('never locks out: the right password still works under attack, just after the delay', async () => {
      const app = loginApp(createLoginBackoff({ free: 1, baseMs: 60, capMs: 60, maxWaitMs: 5000 }));
      for (let i = 0; i < 5; i++) expect((await attempt(app, 'wrong')).status).toBe(401);
      const started = Date.now();
      const ok = await attempt(app, TEST_PASSWORD);
      expect(ok.status).toBe(200);
      expect(ok.body.token).toBeTruthy();
      expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    });

    // Deterministic: the clock is frozen and attempts are sequential, so the outcome depends only
    // on the backoff arithmetic (free: 1; then a 100 ms gap each; queue at most 150 ms deep),
    // never on how long bcrypt takes under load.
    it('answers 429 with Retry-After once the wait queue is full, without running bcrypt', async () => {
      const compare = vi.fn(async () => false);
      const app = loginApp(createLoginBackoff({ free: 1, baseMs: 100, capMs: 100, maxWaitMs: 150, now: () => 1_000_000 }), compare);
      const codes = [];
      let last;
      for (let i = 0; i < 3; i++) {
        last = await attempt(app, 'wrong');
        codes.push(last.status);
      }
      // attempt 1 free, attempt 2 waits 100 ms (inside the queue), attempt 3 would wait 200 ms (> 150): shed
      expect(codes).toEqual([401, 401, 429]);
      expect(Number(last.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(compare).toHaveBeenCalledTimes(2);
    });

    it('delays an attempt by the wait the backoff reserves', async () => {
      const app = loginApp({ reserve: () => ({ waitMs: 120 }), recordSuccess() {} });
      const started = Date.now();
      expect((await attempt(app, 'wrong')).status).toBe(401);
      expect(Date.now() - started).toBeGreaterThanOrEqual(110); // a lower bound only: it can't be early
    });

    it('a successful login resets the delay', async () => {
      const app = loginApp(createLoginBackoff({ free: 1, baseMs: 400, capMs: 400, maxWaitMs: 5000 }));
      await attempt(app, 'wrong'); await attempt(app, 'wrong');
      await attempt(app, TEST_PASSWORD);
      const started = Date.now();
      await attempt(app, 'wrong');
      expect(Date.now() - started).toBeLessThan(300);
    });
  });
});

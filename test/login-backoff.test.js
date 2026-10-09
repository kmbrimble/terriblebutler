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

  // Nothing here reads the wall clock or really waits: the backoff runs on an injected clock and the
  // route's sleep is a recorder, so the outcome depends only on the arithmetic, never on how long
  // bcrypt or the machine takes.
  describe('on POST /api/auth/login', () => {
    function loginApp(loginBackoff, { compare, sleep = async () => {} } = {}) {
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
        sleep,
      });
      return app;
    }
    const attempt = (app, password) => request(app).post('/api/auth/login').send({ username: TEST_USERNAME, password });
    const recorder = () => { const waits = []; return { waits, sleep: async (ms) => { waits.push(ms); } }; };
    const frozen = (opts) => createLoginBackoff({ now: () => 1_000_000, ...opts });

    it('never locks out: the right password still works under attack, just after the delay', async () => {
      const { waits, sleep } = recorder();
      const app = loginApp(frozen({ free: 1, baseMs: 60, capMs: 60, maxWaitMs: 5000 }), { sleep });
      for (let i = 0; i < 5; i++) expect((await attempt(app, 'wrong')).status).toBe(401);
      const ok = await attempt(app, TEST_PASSWORD);
      expect(ok.status).toBe(200);
      expect(ok.body.token).toBeTruthy();
      // free attempt 1 runs at once; with the clock stopped each further attempt queues 60 ms behind the last
      expect(waits).toEqual([60, 120, 180, 240, 300]);
    });

    // free: 1; then a 100 ms gap each; the queue is at most 150 ms deep.
    it('answers 429 with Retry-After once the wait queue is full, without running bcrypt', async () => {
      const compare = vi.fn(async () => false);
      const { waits, sleep } = recorder();
      const app = loginApp(frozen({ free: 1, baseMs: 100, capMs: 100, maxWaitMs: 150 }), { compare, sleep });
      const codes = [];
      let last;
      for (let i = 0; i < 3; i++) {
        last = await attempt(app, 'wrong');
        codes.push(last.status);
      }
      // attempt 1 free, attempt 2 waits 100 ms (inside the queue), attempt 3 would wait 200 ms (> 150): shed
      expect(codes).toEqual([401, 401, 429]);
      expect(waits).toEqual([100]);
      expect(Number(last.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(compare).toHaveBeenCalledTimes(2);
    });

    it('delays an attempt by exactly the wait the backoff reserves, before checking the password', async () => {
      const order = [];
      const compare = vi.fn(async () => { order.push('compare'); return false; });
      const app = loginApp({ reserve: () => ({ waitMs: 120 }), recordSuccess() {} }, { compare, sleep: async (ms) => { order.push(`sleep ${ms}`); } });
      expect((await attempt(app, 'wrong')).status).toBe(401);
      expect(order).toEqual(['sleep 120', 'compare']);
    });

    it('a successful login resets the delay', async () => {
      const { waits, sleep } = recorder();
      const app = loginApp(frozen({ free: 1, baseMs: 400, capMs: 400, maxWaitMs: 5000 }), { sleep });
      await attempt(app, 'wrong'); await attempt(app, 'wrong');
      expect(waits).toEqual([400]);
      expect((await attempt(app, TEST_PASSWORD)).status).toBe(200); // waits 800 behind the failures, then resets
      expect(waits).toEqual([400, 800]);
      expect((await attempt(app, 'wrong')).status).toBe(401);
      expect(waits).toEqual([400, 800]); // the next attempt is free again: no new wait
    });
  });
});

import { describe, it, expect, afterEach } from 'vitest';
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
    expect(waits.slice(0, 3)).toEqual([0, 0, 0]);
    // each later attempt starts a growing gap after the previous one: 100, 200, 400, 400
    expect(waits.slice(3)).toEqual([100, 300, 700, 1100]);
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
    function loginApp(loginBackoff) {
      const app = express();
      app.use(express.json());
      registerLoginRoute(app, {
        loginRateLimiter: (req, res, next) => next(),
        loginBackoff,
        AUTH_USERNAME: process.env.AUTH_USERNAME,
        AUTH_PASSWORD_HASH: process.env.AUTH_PASSWORD_HASH,
        JWT_SECRET: process.env.JWT_SECRET,
        authState: { getEpoch: () => 1 },
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

    it('delays parallel guesses so they cannot outrun the cap, and answers 429 when the queue is full', async () => {
      const app = loginApp(createLoginBackoff({ free: 1, baseMs: 100, capMs: 100, maxWaitMs: 150 }));
      const started = Date.now();
      const results = await Promise.all(Array.from({ length: 8 }, () => attempt(app, 'wrong')));
      const codes = results.map((r) => r.status);
      expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
      expect(results.find((r) => r.status === 429).headers['retry-after']).toBeTruthy();
      expect(codes.filter((c) => c === 401).length).toBeLessThan(8);
      expect(Date.now() - started).toBeGreaterThanOrEqual(100);
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

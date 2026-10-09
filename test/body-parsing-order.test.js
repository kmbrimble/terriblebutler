import { describe, it, expect } from 'vitest';
import request from 'supertest';
import './setup.js';
import { TEST_TOKEN } from './setup.js';
import { loadFreshApp } from './fresh-app.js';

const MALFORMED = '{"name": ';
const authed = (test) => test.set('Authorization', `Bearer ${TEST_TOKEN}`);
const postJson = (test, body = MALFORMED) => test.set('Content-Type', 'application/json').send(body);

describe('JSON body parsing runs after the rate limiters', () => {
  it('a throttled client gets 429 for a malformed body, not 400 (the body is never parsed)', async () => {
    const { app } = loadFreshApp({ MUTATION_RATE_LIMIT_MAX: '2', GENERAL_API_RATE_LIMIT_MAX: '1000' });
    for (let i = 0; i < 2; i++) {
      expect((await postJson(authed(request(app).post('/api/locations')), JSON.stringify({ name: `Order test ${i}` }))).status).toBe(201);
    }
    expect((await postJson(authed(request(app).post('/api/locations')))).status).toBe(429);
  });

  it('the general limiter also precedes parsing', async () => {
    const { app } = loadFreshApp({ GENERAL_API_RATE_LIMIT_MAX: '1', MUTATION_RATE_LIMIT_MAX: '1000' });
    expect((await authed(request(app).get('/api/locations'))).status).toBe(200);
    expect((await postJson(authed(request(app).post('/api/locations')))).status).toBe(429);
  });

  it('login: its limiter runs before its body is parsed, and a malformed body is still a 400 when not throttled', async () => {
    const { app } = loadFreshApp({ LOGIN_RATE_LIMIT_MAX: '2', GENERAL_API_RATE_LIMIT_MAX: '1000' });
    expect((await postJson(request(app).post('/api/auth/login'))).status).toBe(400);
    expect((await postJson(request(app).post('/api/auth/login'))).status).toBe(400);
    const third = await postJson(request(app).post('/api/auth/login'));
    expect(third.status).toBe(429);
    expect(third.headers['retry-after']).toBeTruthy();
  });

  it('an unauthenticated /api caller gets 401 for a malformed body: no body is parsed for them', async () => {
    const { app } = loadFreshApp({ GENERAL_API_RATE_LIMIT_MAX: '1000', MUTATION_RATE_LIMIT_MAX: '1000' });
    expect((await postJson(request(app).post('/api/locations'))).status).toBe(401);
  });

  it('an authenticated malformed body is still a clean 400', async () => {
    const { app } = loadFreshApp({ GENERAL_API_RATE_LIMIT_MAX: '1000', MUTATION_RATE_LIMIT_MAX: '1000' });
    const res = await postJson(authed(request(app).post('/api/locations')));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/malformed json/i);
  });

  it('keeps the empty-object default for body-less requests and the 1 MB bound', async () => {
    const { app } = loadFreshApp({ GENERAL_API_RATE_LIMIT_MAX: '1000', MUTATION_RATE_LIMIT_MAX: '1000' });
    expect((await authed(request(app).post('/api/locations'))).status).toBe(400);
    const big = JSON.stringify({ name: 'x'.repeat(1_100_000) });
    expect((await postJson(authed(request(app).post('/api/locations')), big)).status).toBe(413);
  });

  it('multipart routes still work (the JSON parser ignores them)', async () => {
    const { app } = loadFreshApp({ GENERAL_API_RATE_LIMIT_MAX: '1000', MUTATION_RATE_LIMIT_MAX: '1000' });
    const res = await authed(request(app).post('/api/invoices/import')).attach('invoice', Buffer.from('not a pdf'), { filename: 'x.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(400); // reached the handler, which rejected the file
    expect(res.body.error).toMatch(/not a PDF/i);
  });
});

describe('non-API paths never parse bodies', () => {
  it('a malformed JSON POST outside /api is a plain 404, never a 400 parse error', async () => {
    const { app } = loadFreshApp({});
    for (const url of ['/', '/media/abc', '/healthz', '/anything/else']) {
      const res = await postJson(request(app).post(url));
      expect(res.status).toBe(404);
      expect(res.body?.error ?? '').not.toMatch(/malformed json/i);
    }
  });

  it('no route outside /api sees a populated body', async () => {
    const { app } = loadFreshApp({});
    let seen = 'unset';
    app.post('/probe-outside-api', (req, res) => { seen = req.body; res.end(); });
    await postJson(request(app).post('/probe-outside-api'), JSON.stringify({ a: 1 }));
    expect(seen).toBeUndefined();
  });
});

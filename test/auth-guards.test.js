import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import './setup.js';
import { TEST_USERNAME, TEST_PASSWORD } from './setup.js';
import { loadFreshApp } from './fresh-app.js';

let app;
let db;
beforeAll(() => {
  // Generous limits so the sweep measures authentication, not throttling.
  ({ app, db } = loadFreshApp({ GENERAL_API_RATE_LIMIT_MAX: '100000', MUTATION_RATE_LIMIT_MAX: '100000', LLM_RATE_LIMIT_MAX: '100000' }));
});

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const login = async () => (await request(app).post('/api/auth/login').send({ username: TEST_USERNAME, password: TEST_PASSWORD })).body.token;

describe('JWT algorithm pin', () => {
  const claims = () => ({ sub: TEST_USERNAME, ver: db.prepare('SELECT token_epoch AS e FROM auth_state').get()?.e ?? 1 });
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

  it('accepts the HS256 baseline (so the rejections below mean something)', async () => {
    const t = jwt.sign(claims(), process.env.JWT_SECRET, { algorithm: 'HS256', jwtid: 'guard-baseline', expiresIn: '1h' });
    expect((await request(app).get('/api/items').set(bearer(t))).status).toBe(200);
  });

  it.each(['HS384', 'HS512'])('rejects a token signed with %s using the right secret', async (algorithm) => {
    const t = jwt.sign(claims(), process.env.JWT_SECRET, { algorithm, jwtid: `guard-${algorithm}`, expiresIn: '1h' });
    expect((await request(app).get('/api/items').set(bearer(t))).status).toBe(401);
  });

  it('rejects a correctly signed token that carries no expiry', async () => {
    const t = jwt.sign(claims(), process.env.JWT_SECRET, { algorithm: 'HS256', jwtid: 'guard-no-exp' });
    expect(jwt.decode(t).exp).toBeUndefined();
    expect((await request(app).get('/api/items').set(bearer(t))).status).toBe(401);
  });

  it('rejects an unsigned alg:none token', async () => {
    const t = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ ...claims(), jti: 'guard-none' })}.`;
    expect((await request(app).get('/api/items').set(bearer(t))).status).toBe(401);
  });
});

describe('unauthenticated route sweep', () => {
  const PUBLIC = new Set(['POST /api/auth/login', 'GET /api/health']);
  const sample = (path) => path.replace(/:\w+/g, '1');
  const apiRoutes = () => {
    const routes = [];
    for (const layer of app.router.stack) {
      if (!layer.route || !String(layer.route.path).startsWith('/api/')) continue;
      for (const method of Object.keys(layer.route.methods)) {
        routes.push({ method, path: layer.route.path, label: `${method.toUpperCase()} ${layer.route.path}` });
      }
    }
    return routes;
  };

  it('finds the route table (guards against the sweep silently covering nothing)', () => {
    expect(apiRoutes().length).toBeGreaterThan(30);
  });

  it('every /api route except login and health answers 401 without credentials', async () => {
    for (const r of apiRoutes().filter((x) => !PUBLIC.has(x.label))) {
      const res = await request(app)[r.method](sample(r.path)).send({});
      expect(res.status, r.label).toBe(401);
    }
  });

  it('every /api route also answers 401 to a bad bearer token', async () => {
    for (const r of apiRoutes().filter((x) => !PUBLIC.has(x.label))) {
      const res = await request(app)[r.method](sample(r.path)).set(bearer('not-a-token')).send({});
      expect(res.status, r.label).toBe(401);
    }
  });

  it('made-up paths under every real route answer 401 unauthenticated (never 404 or the SPA), and 404 JSON once authenticated', async () => {
    const token = await login();
    for (const r of apiRoutes()) {
      const madeUp = `${sample(r.path)}/zz-not-a-route`;
      const anon = await request(app)[r.method](madeUp).send({});
      expect(anon.status, `anon ${r.label}`).toBe(401);
      const authed = await request(app)[r.method](madeUp).set(bearer(token)).send({});
      expect(authed.status, `authed ${r.label}`).toBe(404);
      expect(authed.headers['content-type'], r.label).toMatch(/json/);
    }
  });

  it('path variants (case, trailing slash, double slash, percent-encoding) never reach an authenticated route', async () => {
    const variants = (p) => [
      p.replace('/api/', '/API/'),
      `${p}/`,
      p.replace('/api/', '//api/'),
      p.replace('/api/', '/api//'),
      p.replace('/api/', '/%61pi/'),
      p.replace('/api/', '/api/%2e/'),
      p.replace(/\/(\w)/, (m, c) => `/%${c.charCodeAt(0).toString(16)}`),
    ];
    for (const r of apiRoutes().filter((x) => !PUBLIC.has(x.label))) {
      for (const path of variants(sample(r.path))) {
        const res = await request(app)[r.method](path).send({});
        const servedData = res.status < 400 && /json/.test(res.headers['content-type'] || '');
        expect(servedData, `${r.label} via ${path}`).toBe(false);
      }
    }
  });
});

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

describe('device-token holders may manage devices (deliberate owner decision)', () => {
  // A remembered tablet must be able to cut off a lost phone, so a DEVICE token (not just a
  // household JWT) can list devices, revoke individual ones and "Sign out everywhere". Minting
  // stays household-JWT-only. If this is ever tightened, change it deliberately with the owner.
  it('lets a device token list devices, revoke another device, and sign out everywhere', async () => {
    const household = await login();
    const mint = async (device_label) => (await request(app).post('/api/auth/device-token').set(bearer(household)).send({ device_label })).body.token;
    const tablet = await mint('Guard tablet');
    const phone = await mint('Guard lost phone');
    const phoneId = db.prepare("SELECT id FROM device_tokens WHERE device_label = 'Guard lost phone'").get().id;

    expect((await request(app).get('/api/auth/devices').set(bearer(tablet))).status).toBe(200);
    expect((await request(app).post(`/api/auth/devices/${phoneId}/revoke`).set(bearer(tablet))).status).toBe(200);
    expect((await request(app).get('/api/items').set(bearer(phone))).status).toBe(401);
    expect((await request(app).post('/api/auth/device-token').set(bearer(tablet)).send({ device_label: 'x' })).status).toBe(403);

    expect((await request(app).post('/api/auth/revoke-all').set(bearer(tablet))).status).toBe(200);
    expect((await request(app).get('/api/items').set(bearer(tablet))).status).toBe(401);
    expect((await request(app).get('/api/items').set(bearer(household))).status).toBe(401);
  });
});

// Rotating JWT_SECRET (the signing key) revokes device tokens as well as JWTs, like a password change.
import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'crypto';
import request from 'supertest';
import { io as connect } from 'socket.io-client';
import { createRequire } from 'module';
import './setup.js';
import { TEST_USERNAME, TEST_PASSWORD } from './setup.js';
import { loadFreshApp } from './fresh-app.js';

const nodeRequire = createRequire(import.meta.url);
vi.setConfig({ testTimeout: 30000 });
const S1 = crypto.randomBytes(32).toString('hex');
const S2 = crypto.randomBytes(32).toString('hex');
const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const openServers = [];
afterEach(async () => {
  vi.restoreAllMocks();
  // Servers a test chose to listen on must not outlive it.
  await Promise.all(openServers.splice(0).filter((server) => server.listening).map((server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); })));
});

function boot(secret) {
  const logged = [];
  for (const level of ['log', 'info', 'warn', 'error']) vi.spyOn(console, level).mockImplementation((...args) => logged.push(args.join(' ')));
  const loaded = loadFreshApp({ JWT_SECRET: secret });
  vi.restoreAllMocks();
  openServers.push(loaded.server);
  return { ...loaded, logged };
}
const epoch = (db) => db.prepare('SELECT token_epoch FROM auth_state').get().token_epoch;
const stored = (db) => db.prepare('SELECT credential_fingerprint AS fp FROM auth_state').get().fp;

async function login(app) {
  return (await request(app).post('/api/auth/login').send({ username: TEST_USERNAME, password: TEST_PASSWORD })).body.token;
}
async function mintDevice(app, jwtToken) {
  return (await request(app).post('/api/auth/device-token').set(bearer(jwtToken)).send({ device_label: 'Key rotation tablet' })).body.token;
}
const status = async (app, token) => (await request(app).get('/api/items').set(bearer(token))).status;
function socketResult(server, token) {
  return new Promise((resolve) => {
    const socket = connect(`http://127.0.0.1:${server.address().port}`, { auth: { token }, transports: ['websocket'], reconnection: false });
    socket.on('connect', () => { socket.close(); resolve('connected'); });
    socket.on('connect_error', (error) => { socket.close(); resolve(error.message); });
  });
}

describe('JWT_SECRET rotation', () => {
  it('first start records the key digest without revoking; a restart with the same key changes nothing', async () => {
    const first = boot(S1);
    expect(stored(first.db)).toMatch(/^[0-9a-f]{64}\.[0-9a-f]{64}$/);
    const jwtToken = await login(first.app);
    const device = await mintDevice(first.app, jwtToken);
    const before = epoch(first.db);
    const second = boot(S1);
    expect(epoch(second.db)).toBe(before);
    expect(await status(second.app, device)).toBe(200);
    expect(await status(second.app, jwtToken)).toBe(200);
  });

  it('a new JWT_SECRET revokes every JWT and every device token, and a revoked device cannot reconnect a socket', async () => {
    const before = boot(S1);
    await new Promise((resolve) => before.server.listen(0, '127.0.0.1', resolve));
    const jwtToken = await login(before.app);
    const device = await mintDevice(before.app, jwtToken);
    expect(await socketResult(before.server, device)).toBe('connected');
    const oldEpoch = epoch(before.db);

    const after = boot(S2);
    await new Promise((resolve) => after.server.listen(0, '127.0.0.1', resolve));
    expect(after.logged.join('\n')).toMatch(/JWT signing key changed/);
    expect(epoch(after.db)).toBe(oldEpoch + 1);
    expect(after.db.prepare("SELECT COUNT(*) AS n FROM device_tokens WHERE revoked = 0").get().n).toBe(0);
    expect(await status(after.app, jwtToken)).toBe(401);
    expect(await status(after.app, device)).toBe(401);
    expect(await socketResult(after.server, device)).toBe('Unauthorized');
    // the household can log in again, and a restart on the same new key is quiet
    const fresh = await login(after.app);
    expect(await status(after.app, fresh)).toBe(200);
    const again = boot(S2);
    expect(epoch(again.db)).toBe(oldEpoch + 1);
    expect(again.logged.join('\n')).not.toMatch(/changed since last start/);
    expect(await status(again.app, fresh)).toBe(200);
  });

  it('the upgrade from a fingerprint without a key digest records it and revokes nothing', async () => {
    const live = boot(S2);
    const jwtToken = await login(live.app);
    const device = await mintDevice(live.app, jwtToken);
    // what 0.46 and earlier stored: the credential digest alone
    const legacy = crypto.createHash('sha256').update(`butler-credential-v1\0${TEST_USERNAME}\0${process.env.AUTH_PASSWORD_HASH}`).digest('hex');
    live.db.prepare('UPDATE auth_state SET credential_fingerprint = ?').run(legacy);
    const before = epoch(live.db);
    const upgraded = boot(S2);
    expect(epoch(upgraded.db)).toBe(before);
    expect(stored(upgraded.db)).toMatch(/^[0-9a-f]{64}\.[0-9a-f]{64}$/);
    expect(stored(upgraded.db).startsWith(legacy)).toBe(true);
    expect(await status(upgraded.app, device)).toBe(200);
    expect(await status(upgraded.app, jwtToken)).toBe(200);
  });

  it('a legacy value for a DIFFERENT login is still a rotation', () => {
    const live = boot(S2);
    live.db.prepare('UPDATE auth_state SET credential_fingerprint = ?').run('a'.repeat(64));
    const before = epoch(live.db);
    const rotated = boot(S2);
    expect(epoch(rotated.db)).toBe(before + 1);
  });

  it('neither the key nor the secret is stored or logged', () => {
    const live = boot(S1);
    const row = JSON.stringify(live.db.prepare('SELECT * FROM auth_state').get());
    const keyBase64 = Buffer.from(S1, 'hex').toString('base64');
    for (const secret of [S1, keyBase64, S1.toUpperCase()]) {
      expect(row).not.toContain(secret);
      expect(live.logged.join('\n')).not.toContain(secret);
    }
    // the digest is keyed: the same key under a different label would not match, and it is not a bare hash of the key
    const bare = crypto.createHash('sha256').update(Buffer.from(S1, 'hex')).digest('hex');
    expect(row).not.toContain(bare);
  });

  it('createAuthState unit: the three outcomes', () => {
    const Database = nodeRequire('better-sqlite3');
    const { createAuthState } = nodeRequire('../lib/auth-state');
    const db = new Database(':memory:');
    db.exec('CREATE TABLE auth_state (id INTEGER PRIMARY KEY CHECK (id = 1), token_epoch INTEGER NOT NULL DEFAULT 1, credential_fingerprint TEXT); CREATE TABLE device_tokens (id INTEGER PRIMARY KEY, revoked INTEGER NOT NULL DEFAULT 0)');
    db.exec('INSERT INTO device_tokens (revoked) VALUES (0)');
    const state = createAuthState(db);
    const k1 = Buffer.alloc(32, 1);
    const k2 = Buffer.alloc(32, 2);
    expect(state.syncCredentialFingerprint('u', 'h', k1)).toBe('initialised');
    expect(state.syncCredentialFingerprint('u', 'h', k1)).toBe('unchanged');
    expect(state.syncCredentialFingerprint('u', 'h', k2)).toBe('key_rotated');
    expect(db.prepare('SELECT revoked FROM device_tokens').get().revoked).toBe(1);
    expect(state.syncCredentialFingerprint('u', 'other', k2)).toBe('rotated');
    expect(state.syncCredentialFingerprint('u', 'other', k1)).toBe('key_rotated');
  });
});

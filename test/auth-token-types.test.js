import { describe, it, expect } from 'vitest';
import './setup.js';
import pkg from '../server.js';
import { TEST_TOKEN } from './setup.js';
import { createAuthState } from '../lib/auth-state.js';
import { createAuth } from '../lib/middleware.js';

const { db } = pkg;

// The Socket.IO handshake passes a client-controlled `auth.token` of any JSON type straight
// to authenticateToken; a non-string used to throw out of hashDeviceToken and kill the process.
describe('authenticateToken with non-string tokens', () => {
  const { authenticateToken } = createAuth(db, createAuthState(db));

  it.each([[123], [{ a: 1 }], [['x']], [true]])('returns null for %j instead of throwing', (token) => {
    expect(authenticateToken(token)).toBeNull();
  });

  it('still accepts a valid JWT', () => {
    expect(authenticateToken(TEST_TOKEN)).toMatchObject({ type: 'jwt', jti: 'test-setup-jwt' });
  });
});

describe('credentialExpiry', () => {
  const { authenticateToken, credentialExpiry } = createAuth(db, createAuthState(db));
  const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

  it('gives a JWT its exp claim', () => {
    const credential = authenticateToken(TEST_TOKEN);
    expect(credentialExpiry(credential)).toBe(credential.expiresAt);
    expect(credential.expiresAt).toBeGreaterThan(Date.now());
  });

  it('tracks a device token\'s sliding idle expiry and reports revocation as null', () => {
    db.prepare("INSERT INTO device_tokens (token_hash, device_label) VALUES ('expiry-hash', 'Expiry tablet')").run();
    const { id } = db.prepare("SELECT id FROM device_tokens WHERE token_hash = 'expiry-hash'").get();
    const credential = { type: 'device', id };

    const before = credentialExpiry(credential);
    expect(before).toBeGreaterThan(Date.now() + YEAR_MS - 60_000);

    db.prepare("UPDATE device_tokens SET last_used_at = datetime('now', '-100 days') WHERE id = ?").run(id);
    expect(credentialExpiry(credential)).toBeLessThan(before - 99 * 24 * 60 * 60 * 1000);

    db.prepare('UPDATE device_tokens SET revoked = 1 WHERE id = ?').run(id);
    expect(credentialExpiry(credential)).toBeNull();
  });
});

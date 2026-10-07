import { describe, it, expect } from 'vitest';
import './setup.js';
import pkg from '../server.js';
import { TEST_TOKEN } from './setup.js';
import { createAuth } from '../lib/middleware.js';

const { db } = pkg;

// The Socket.IO handshake passes a client-controlled `auth.token` of any JSON type straight
// to authenticateToken; a non-string used to throw out of hashDeviceToken and kill the process.
describe('authenticateToken with non-string tokens', () => {
  const { authenticateToken } = createAuth(db);

  it.each([[123], [{ a: 1 }], [['x']], [true]])('returns false for %j instead of throwing', (token) => {
    expect(authenticateToken(token)).toBe(false);
  });

  it('still accepts a valid JWT', () => {
    expect(authenticateToken(TEST_TOKEN)).toBe(true);
  });
});

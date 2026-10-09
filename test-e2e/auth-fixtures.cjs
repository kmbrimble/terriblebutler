const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

// Fixed, throwaway credentials for the e2e run only - unrelated to production secrets.
// Plain CommonJS (not .mjs): Playwright bundles .mjs config/setup files with esbuild
// for named-export detection, which was unreliable for a file with computed
// top-level exports (bcrypt.hashSync(...)). CJS + Node's native ESM-imports-CJS
// interop (cjs-module-lexer) sidesteps that entirely.
// Fixed rather than randomly generated: Playwright loads playwright.config.js and
// test-e2e/global-setup.mjs through separate transform contexts, so a value computed
// with fresh randomness at module-load time (e.g. crypto.randomBytes) is NOT
// guaranteed to come out the same in both - and the token minted here must match the
// secret the spawned server process is given.
const AUTH_USERNAME = 'e2euser';
const AUTH_PASSWORD = 'e2epass123';
// Hex, as the server requires (64+ hex characters = 32+ bytes); the server signs with the decoded bytes.
// nosemgrep: generic.secrets.security.detected-generic-secret.detected-generic-secret -- throwaway fixed e2e secret for a throwaway server, unrelated to any real secret
const JWT_SECRET = '2f9a6c1d4b7e80352f9a6c1d4b7e80352f9a6c1d4b7e80352f9a6c1d4b7e8035';
const AUTH_PASSWORD_HASH = bcrypt.hashSync(AUTH_PASSWORD, 10);

// Hand-rolled HS256 signer, cross-checked against the server's `jsonwebtoken` verify.
function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function signJwt(payload, secret, expiresInSeconds) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + expiresInSeconds };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(body))}`;
  const signature = crypto.createHmac('sha256', Buffer.from(secret, 'hex')).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

// The e2e server starts on a fresh DB, so its token epoch is 1; `ver` and `jti` are required.
const TEST_TOKEN = signJwt({ sub: AUTH_USERNAME, ver: 1, jti: 'e2e-fixture' }, JWT_SECRET, 30 * 24 * 60 * 60);

module.exports = { AUTH_USERNAME, AUTH_PASSWORD, JWT_SECRET, AUTH_PASSWORD_HASH, TEST_TOKEN, signJwt };

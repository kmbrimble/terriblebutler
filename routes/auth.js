const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { cleanText } = require('../lib/domain-helpers');

const DEVICE_LABEL_MAX = 100;

// Checks a submitted household password through the account-level backoff (lib/login-backoff.js)
// then bcrypt. Shared by login and by step-up re-authentication so both feed the same backoff:
// a failed re-auth counts exactly like a failed login. Resolves to { valid } or, when the wait
// queue is full, { retryAfterMs }; rejects if bcrypt itself fails (a misconfigured hash).
function createPasswordCheck({ loginBackoff, AUTH_PASSWORD_HASH }) {
  return async function checkPassword(password) {
    const slot = loginBackoff.reserve();
    if (slot.retryAfterMs) return { retryAfterMs: slot.retryAfterMs };
    if (slot.waitMs) await new Promise((resolve) => setTimeout(resolve, slot.waitMs));
    return { valid: await bcrypt.compare(password, AUTH_PASSWORD_HASH) };
  };
}

// Registered before `requireAuth` is mounted — login must stay reachable unauthenticated.
function registerLoginRoute(app, { loginRateLimiter, loginBackoff, AUTH_USERNAME, AUTH_PASSWORD_HASH, JWT_SECRET, authState }) {
  const checkPassword = createPasswordCheck({ loginBackoff, AUTH_PASSWORD_HASH });
  app.post('/api/auth/login', loginRateLimiter, async (req, res) => {
    const { username, password } = req.body || {};
    // bcrypt.compare rejects on non-strings, and an unhandled rejection kills the process.
    if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    // Account-level backstop (lib/login-backoff.js): delays the check, never locks the account.
    // Express 5 would forward a rejection to the global error handler, which answers 400 with
    // err.message. A bcrypt failure here means AUTH_PASSWORD_HASH is misconfigured: log it
    // server-side and answer a generic 500.
    let result;
    try {
      result = await checkPassword(password);
    } catch (err) {
      console.error('Login failed: bcrypt.compare threw (is AUTH_PASSWORD_HASH a valid bcrypt hash?)', err);
      return res.status(500).json({ error: 'Login is unavailable.' });
    }
    if (result.retryAfterMs) {
      res.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
      return res.status(429).json({ error: 'Too many login attempts. Please try again shortly.' });
    }
    if (username !== AUTH_USERNAME || !result.valid) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    loginBackoff.recordSuccess();
    const token = jwt.sign({ sub: username, ver: authState.getEpoch() }, JWT_SECRET, {
      expiresIn: '30d',
      jwtid: crypto.randomUUID(),
      algorithm: 'HS256',
    });
    res.json({ token });
  });
}

// Registered after `requireAuth` is mounted. Minting a device token needs an interactive
// login (a household JWT): a device token must not be able to issue replacements for itself.
// Listing devices accepts any valid credential. OWNER DECISION: revoking a device and "Sign out
// everywhere" need a FRESH LOGIN, the household password re-entered in that very request
// (step-up), whatever credential type is presented, so a stolen device token alone cannot
// revoke anything. A remembered tablet can still cut off a lost phone, but only by someone who
// knows the household password. The check shares the login rate limit and account backoff, and
// a wrong password counts as a failed login. test/auth-guards.test.js pins all of this.
function registerDeviceTokenRoutes(app, { db, hashDeviceToken, requireHouseholdJwt, authState, disconnectSockets, loginRateLimiter, loginBackoff, AUTH_PASSWORD_HASH }) {
  const checkPassword = createPasswordCheck({ loginBackoff, AUTH_PASSWORD_HASH });

  // Mounted per-route. Rejects (403, never 401, which the client reads as "session expired")
  // unless the body carries the correct household password.
  async function requireFreshLogin(req, res, next) {
    const { password } = req.body || {};
    if (typeof password !== 'string' || !password) {
      return res.status(403).json({ error: 'Enter your password to do this.' });
    }
    let result;
    try {
      result = await checkPassword(password);
    } catch (err) {
      console.error('Re-authentication failed: bcrypt.compare threw (is AUTH_PASSWORD_HASH a valid bcrypt hash?)', err);
      return res.status(500).json({ error: 'Re-authentication is unavailable.' });
    }
    if (result.retryAfterMs) {
      res.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
      return res.status(429).json({ error: 'Too many password attempts. Please try again shortly.' });
    }
    if (!result.valid) return res.status(403).json({ error: 'Incorrect password.' });
    loginBackoff.recordSuccess();
    next();
  }

  app.post('/api/auth/device-token', requireHouseholdJwt, (req, res) => {
    let label;
    try {
      label = cleanText(req.body?.device_label, { required: true, max: DEVICE_LABEL_MAX });
    } catch (err) {
      return res.status(400).json({ error: `device_label is required and must be at most ${DEVICE_LABEL_MAX} characters.` });
    }
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO device_tokens (token_hash, device_label, issued_by_jti) VALUES (?, ?, ?)')
      .run(hashDeviceToken(token), label, req.credential.jti);
    res.json({ token });
  });

  app.get('/api/auth/devices', (req, res) => {
    const devices = db.prepare(
      'SELECT id, device_label, created_at, last_used_at, revoked FROM device_tokens ORDER BY created_at DESC'
    ).all();
    res.json(devices);
  });

  app.post('/api/auth/devices/:id/revoke', loginRateLimiter, requireFreshLogin, (req, res) => {
    const device = db.prepare('SELECT id FROM device_tokens WHERE id = ?').get(req.params.id);
    if (!device) {
      return res.status(404).json({ error: 'Device not found.' });
    }
    db.prepare('UPDATE device_tokens SET revoked = 1 WHERE id = ?').run(device.id);
    disconnectSockets((c) => c.type === 'device' && c.id === device.id);
    res.json({ success: true });
  });

  // "Sign out everywhere": ends every household session and revokes every device token,
  // including the caller's own. Needs the password (see above).
  app.post('/api/auth/revoke-all', loginRateLimiter, requireFreshLogin, (req, res) => {
    authState.revokeAllSessions();
    disconnectSockets(() => true);
    res.json({ success: true });
  });
}

module.exports = { registerLoginRoute, registerDeviceTokenRoutes };

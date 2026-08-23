const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// Registered before `requireAuth` is mounted — login must stay reachable unauthenticated.
function registerLoginRoute(app, { loginRateLimiter, AUTH_USERNAME, AUTH_PASSWORD_HASH, JWT_SECRET }) {
  app.post('/api/auth/login', loginRateLimiter, async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    const validPassword = await bcrypt.compare(password, AUTH_PASSWORD_HASH);
    if (username !== AUTH_USERNAME || !validPassword) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const token = jwt.sign({ sub: username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token });
  });
}

// Registered after `requireAuth` is mounted — issuing/listing/revoking device tokens
// requires an already-authenticated household session.
function registerDeviceTokenRoutes(app, { db, hashDeviceToken }) {
  app.post('/api/auth/device-token', (req, res) => {
    const { device_label } = req.body || {};
    if (!device_label || typeof device_label !== 'string' || !device_label.trim()) {
      return res.status(400).json({ error: 'device_label is required.' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO device_tokens (token_hash, device_label) VALUES (?, ?)')
      .run(hashDeviceToken(token), device_label.trim());
    res.json({ token });
  });

  app.get('/api/auth/devices', (req, res) => {
    const devices = db.prepare(
      'SELECT id, device_label, created_at, last_used_at, revoked FROM device_tokens ORDER BY created_at DESC'
    ).all();
    res.json(devices);
  });

  app.post('/api/auth/devices/:id/revoke', (req, res) => {
    const result = db.prepare('UPDATE device_tokens SET revoked = 1 WHERE id = ?').run(req.params.id);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Device not found.' });
    }
    res.json({ success: true });
  });
}

module.exports = { registerLoginRoute, registerDeviceTokenRoutes };

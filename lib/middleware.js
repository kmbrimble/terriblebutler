const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('./config');
const { keyForAddress, createHitCounter, MAX_RATE_LIMIT_BUCKETS } = require('./rate-limit-core');

// Content-Security-Policy for the built React client. Scripts are 'self' only (no inline,
// no eval): the pre-paint theme bootstrap is the external /theme-init.js. 'self' also covers
// same-origin Socket.IO over ws/wss in current browsers. blob:/data: images serve the camera
// crop and barcode scanner. Styles are 'self' too: React, Cropper.js 2 and html5-qrcode all
// style via the CSSOM, which CSP allows (verified by the e2e suite's CSP-violation guard).
// No upgrade-insecure-requests: the app is also reached over plain http on the LAN.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), fullscreen=(self)');
  next();
}

// The resolved client address (req.ip honours the configured trust proxy). IPv4-mapped IPv6
// (::ffff:a.b.c.d) is folded to plain IPv4 so one client cannot hold two buckets.
function clientAddress(req) {
  const address = req.ip || req.socket.remoteAddress || 'unknown';
  return address.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1');
}

// The identity rate limits are keyed on. An IPv6 client is normally handed a whole /64 (or
// larger), so keying on the full address would let it rotate addresses for fresh buckets;
// IPv6 is keyed on its /64 prefix. IPv4, and IPv4-mapped IPv6 in either notation, stay a
// plain IPv4 address. Logs keep the full address (clientAddress).
function clientKey(req) {
  return keyForAddress(clientAddress(req));
}

// Verbose action logging (#14): every mutating /api/* call, request + response body. Mounted
// after the rate limiters and requireAuth (#52), so a request that was throttled or not
// authenticated never has its body logged.
function actionLogger(logAction) {
  return (req, res, next) => {
    if (req.method === 'GET') return next();
    const start = Date.now();
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      logAction({
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        duration_ms: Date.now() - start,
        ip: clientAddress(req),
        request_body: req.body,
        response_body: body,
      });
      return originalJson(body);
    };
    next();
  };
}

// Login attempts happen before authentication, so they cannot use actionLogger. They are
// logged as an audit event instead: outcome, status and client IP, never a body. The
// submitted username is recorded only on success, where it is the configured one; on failure
// it is attacker-controlled free text and often a mistyped password.
function loginAuditLogger(logAction) {
  return (req, res, next) => {
    res.on('finish', () => {
      const outcome = res.statusCode === 200 ? 'success'
        : res.statusCode === 429 ? 'rate_limited'
        : res.statusCode === 401 ? 'failure'
        : 'rejected';
      const entry = { event: 'login', outcome, status: res.statusCode, ip: clientAddress(req) };
      if (outcome === 'success' && typeof req.body?.username === 'string') entry.username = req.body.username;
      logAction(entry);
    });
    next();
  };
}


function createRateLimiter({ windowMs, maxRequests, bucketName }) {
  const counter = createHitCounter({ windowMs, maxRequests, bucketName });
  const limiter = (req, res, next) => {
    const { limited, remaining, resetSeconds } = counter.hit(clientKey(req));
    res.setHeader('RateLimit-Limit', String(maxRequests));
    // Which limiter this is and its window, so a client can word a 429 truthfully (IETF
    // draft-ietf-httpapi-ratelimit-headers: "<quota>;w=<window seconds>").
    res.setHeader('RateLimit-Policy', `${maxRequests};w=${Math.round(windowMs / 1000)};name="${bucketName}"`);
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(resetSeconds));

    if (limited) {
      res.setHeader('Retry-After', String(resetSeconds));
      return res.status(429).json({
        error: 'Too many requests. Please try again shortly.',
        limiter: bucketName,
      });
    }

    next();
  };
  limiter.buckets = counter.buckets;
  return limiter;
}

const generalApiRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: config.GENERAL_API_RATE_LIMIT_MAX,
  bucketName: 'api'
});

const mutationRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: config.MUTATION_RATE_LIMIT_MAX,
  bucketName: 'mutation'
});

const llmRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: config.LLM_RATE_LIMIT_MAX,
  bucketName: 'llm'
});

const loginRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxRequests: config.LOGIN_RATE_LIMIT_MAX,
  bucketName: 'login'
});

function mutationRateLimiterMiddleware(req, res, next) {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return mutationRateLimiter(req, res, next);
  }
  next();
}

// JSON request bodies are parsed only for /api, and only once the request has passed the rate
// limiters (and, except for login, authentication), so a throttled or unauthenticated client
// never makes the server buffer and parse a body. Express 5 leaves req.body undefined when a
// request carries none (Express 4 gave {}); handlers destructure it, so restore the default.
const jsonBody = [
  express.json({ limit: '1mb' }),
  (req, res, next) => {
    if (req.body === undefined) req.body = {};
    next();
  },
];

const DEVICE_TOKEN_MAX_IDLE_MS = 365 * 24 * 60 * 60 * 1000;
const DEVICE_TOKEN_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

function hashDeviceToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// SQLite's CURRENT_TIMESTAMP produces "YYYY-MM-DD HH:MM:SS" in UTC with no timezone suffix;
// `new Date()` on that string is parsed as LOCAL time, skewing every idle calculation by the
// host's UTC offset. Tests also store proper ISO strings (with a 'Z') directly, so only add
// one where it's missing.
function parseUtcTimestamp(value) {
  return new Date(/Z$/.test(value) ? value : `${value.replace(' ', 'T')}Z`);
}

// Accepts either a household JWT or a device token as the bearer value and returns the
// credential it resolved to ({ type: 'jwt', jti } or { type: 'device', id }), or null.
// A JWT must be HS256, unexpired and carry the current token epoch (`ver`, see
// lib/auth-state.js), so bumping the epoch ends every household session. A device token is
// opaque (not self-contained), so it's checked against its stored hash and rejected if
// revoked or idle beyond DEVICE_TOKEN_MAX_IDLE_MS; a successful check bumps last_used_at,
// giving it a sliding expiry instead of a hard one.
// The one place the Authorization header is read. Accepts exactly `Bearer <token68>`
// (RFC 7235: case-insensitive scheme, one or more spaces, then a single token with no
// further parts) and returns the token, or null for anything else.
const BEARER_HEADER = /^bearer +([A-Za-z0-9\-._~+/]+=*)$/i;
function parseBearerToken(header) {
  const match = typeof header === 'string' ? BEARER_HEADER.exec(header) : null;
  return match ? match[1] : null;
}

function createAuth(db, authState) {
  function authenticateToken(token) {
    // The Socket.IO handshake token is client-controlled and can be any JSON type; hashing a
    // non-string below throws, and an uncaught throw there kills the process.
    if (typeof token !== 'string') return null;
    try {
      const claims = jwt.verify(token, config.JWT_KEY, { algorithms: ['HS256'] });
      if (claims.ver !== authState.getEpoch() || typeof claims.jti !== 'string' || !Number.isFinite(claims.exp)) return null;
      return { type: 'jwt', jti: claims.jti, expiresAt: claims.exp * 1000 };
    } catch (err) {
      // Not a valid JWT — fall through to the device-token check below.
    }
    const row = db.prepare('SELECT * FROM device_tokens WHERE token_hash = ?').get(hashDeviceToken(token));
    if (!row || row.revoked) return null;
    const idleMs = Date.now() - parseUtcTimestamp(row.last_used_at).getTime();
    if (idleMs > DEVICE_TOKEN_MAX_IDLE_MS) return null;
    // Only write last_used_at once an hour per device, not on every request — a device token
    // is used for every API call a tablet/phone makes, and the sliding-expiry check above only
    // needs hour-level precision, not per-request precision.
    if (idleMs > DEVICE_TOKEN_TOUCH_INTERVAL_MS) {
      db.prepare('UPDATE device_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
      return { type: 'device', id: row.id, expiresAt: Date.now() + DEVICE_TOKEN_MAX_IDLE_MS };
    }
    return { type: 'device', id: row.id, expiresAt: parseUtcTimestamp(row.last_used_at).getTime() + DEVICE_TOKEN_MAX_IDLE_MS };
  }

  // When a credential an open socket authenticated with stops being valid, as epoch ms, or
  // null if it already is invalid. A JWT's expiry is fixed (an epoch bump disconnects its
  // sockets directly, see routes/auth.js). A device token's is re-read from the row because it slides: HTTP use pushes
  // last_used_at forward, and an open socket by itself does not count as use.
  function credentialExpiry(credential) {
    if (credential.type === 'jwt') {
      return credential.expiresAt;
    }
    const row = db.prepare('SELECT last_used_at, revoked FROM device_tokens WHERE id = ?').get(credential.id);
    if (!row || row.revoked) return null;
    return parseUtcTimestamp(row.last_used_at).getTime() + DEVICE_TOKEN_MAX_IDLE_MS;
  }

  // The credential a request's bearer header resolves to, or null (also used by /api/health).
  function credentialFromRequest(req) {
    const token = parseBearerToken(req.headers['authorization']);
    return token ? authenticateToken(token) : null;
  }

  function requireAuth(req, res, next) {
    const credential = credentialFromRequest(req);
    if (!credential) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    req.credential = credential;
    next();
  }

  // Mounted per-route after requireAuth for operations that need an interactive login.
  function requireHouseholdJwt(req, res, next) {
    if (req.credential?.type !== 'jwt') {
      return res.status(403).json({ error: 'Log in with your password to do this.' });
    }
    next();
  }

  return { authenticateToken, credentialFromRequest, requireAuth, requireHouseholdJwt, credentialExpiry };
}

module.exports = {
  securityHeaders,
  clientAddress,
  clientKey,
  jsonBody,
  actionLogger,
  loginAuditLogger,
  generalApiRateLimiter,
  mutationRateLimiterMiddleware,
  llmRateLimiter,
  loginRateLimiter,
  hashDeviceToken,
  parseBearerToken,
  createAuth,
  MAX_RATE_LIMIT_BUCKETS,
};

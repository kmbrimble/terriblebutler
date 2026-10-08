const multer = require('multer');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('./config');

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), fullscreen=(self)');
  next();
}

// Verbose action logging (#14): every mutating /api/* call, request + response body.
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
        request_body: req.body,
        response_body: body,
      });
      return originalJson(body);
    };
    next();
  };
}

const rateLimitBuckets = new Map();

function createRateLimiter({ windowMs, maxRequests, bucketName }) {
  return (req, res, next) => {
    const now = Date.now();
    const clientAddress = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${bucketName}:${clientAddress}`;

    let bucket = rateLimitBuckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      bucket = {
        count: 0,
        resetAt: now + windowMs
      };
    }

    bucket.count += 1;
    rateLimitBuckets.set(key, bucket);

    res.setHeader('RateLimit-Limit', String(maxRequests));
    res.setHeader(
      'RateLimit-Remaining',
      String(Math.max(0, maxRequests - bucket.count))
    );
    res.setHeader(
      'RateLimit-Reset',
      String(Math.ceil(bucket.resetAt / 1000))
    );

    if (bucket.count > maxRequests) {
      return res.status(429).json({
        error: 'Too many requests. Please try again shortly.'
      });
    }

    next();
  };
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

const rateLimitCleanupTimer = setInterval(() => {
  const now = Date.now();

  for (const [key, bucket] of rateLimitBuckets.entries()) {
    if (bucket.resetAt <= now) {
      rateLimitBuckets.delete(key);
    }
  }
}, 5 * 60 * 1000);

rateLimitCleanupTimer.unref();

// Configure Multer for image and invoice uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
function fileFilterFor(allowedTypes) {
  return (req, file, cb) => {
    if (!allowedTypes.includes(file.mimetype)) {
      return cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
    cb(null, true);
  };
}
const imageUpload = multer({
  storage,
  limits: { fileSize: config.MAX_IMAGE_BYTES, files: 1 },
  fileFilter: fileFilterFor(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
});
const invoiceUpload = multer({
  storage,
  limits: { fileSize: config.MAX_INVOICE_BYTES, files: 1 },
  fileFilter: fileFilterFor(['application/pdf'])
});
fs.mkdirSync(path.join(__dirname, '..', 'uploads'), { recursive: true });

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
function createAuth(db, authState) {
  function authenticateToken(token) {
    // The Socket.IO handshake token is client-controlled and can be any JSON type; hashing a
    // non-string below throws, and an uncaught throw there kills the process.
    if (typeof token !== 'string') return null;
    try {
      const claims = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] });
      if (claims.ver !== authState.getEpoch() || typeof claims.jti !== 'string') return null;
      return { type: 'jwt', jti: claims.jti };
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
    }
    return { type: 'device', id: row.id };
  }

  function requireAuth(req, res, next) {
    const [scheme, token] = (req.headers['authorization'] || '').split(' ');
    const credential = scheme === 'Bearer' && token ? authenticateToken(token) : null;
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

  return { authenticateToken, requireAuth, requireHouseholdJwt };
}

module.exports = {
  securityHeaders,
  actionLogger,
  generalApiRateLimiter,
  mutationRateLimiterMiddleware,
  llmRateLimiter,
  loginRateLimiter,
  imageUpload,
  invoiceUpload,
  hashDeviceToken,
  createAuth,
};

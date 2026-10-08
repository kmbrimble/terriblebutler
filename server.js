const express = require('express');
const http = require('http');
const path = require('path');
const multer = require('multer');
const { logAction } = require('./logger');
const { scheduleNightlyBackup } = require('./backup');

const config = require('./lib/config');
const { openDatabase } = require('./lib/database');
const { createAuthState } = require('./lib/auth-state');
const { createRealtime } = require('./lib/realtime');
const middleware = require('./lib/middleware');
const { createDomainHelpers, checkDuplicateBarcodes, sendServerError } = require('./lib/domain-helpers');
const { setupGracefulShutdown } = require('./lib/shutdown');
const uploads = require('./lib/uploads');
const { createLoginBackoff } = require('./lib/login-backoff');
const { scheduleImportPurge } = require('./lib/invoice-retention');

const { registerHealthzRoute, registerApiHealthRoute } = require('./routes/health');
const { registerLoginRoute, registerDeviceTokenRoutes } = require('./routes/auth');
const { registerLocationRoutes } = require('./routes/locations');
const { registerCategoryRoutes } = require('./routes/categories');
const { registerItemRoutes } = require('./routes/items');
const { registerPriceHistoryRoutes } = require('./routes/price-history');
const { registerUploadRoutes } = require('./routes/uploads');
const { registerInvoiceRoutes } = require('./routes/invoices');

const APP_VERSION = config.APP_VERSION;
const app = express();

app.disable('x-powered-by');
// Forwarded-header trust is explicit and off by default (#53); see lib/config.js TRUST_PROXY.
app.set('trust proxy', config.TRUST_PROXY);

app.use(middleware.securityHeaders);

const server = http.createServer(app);

// Middleware setup
app.use(express.json({ limit: '1mb' }));
// Express 5 leaves req.body undefined when a request carries no body (Express 4 gave {}).
// Handlers destructure req.body directly, so restore the empty-object default.
app.use((req, res, next) => {
  if (req.body === undefined) req.body = {};
  next();
});

// The React client is now the default front end, served at /.
app.use(express.static(path.join(__dirname, 'client/dist')));

// Stored images are not served statically. They are delivered only through /media/:name with a
// short-lived signature (lib/uploads.js); registered before the SPA fallback so it can't shadow it.
uploads.registerMediaRoute(app);

registerHealthzRoute(app);

app.use('/api', middleware.generalApiRateLimiter);

app.use('/api/parse-label-llm', middleware.llmRateLimiter);

// Starting an invoice import (POST only) also drives LLM calls (#55). Gated by method and
// exact path so the import's review endpoints (GET/PATCH/DELETE/commit under the same prefix)
// are not throttled by the LLM budget.
app.use('/api/invoices/import', (req, res, next) =>
  req.method === 'POST' && req.path === '/' ? middleware.llmRateLimiter(req, res, next) : next()
);

app.use('/api', middleware.mutationRateLimiterMiddleware);

// Initialise Database
const { db, dbPath } = openDatabase();

const domainHelpers = createDomainHelpers(db);
const { getItem, barcodeBelongsToAnotherItem, validForeignId, recalculateItemPrices, resolveTargetLocation, upsertItemLocationQuantity } = domainHelpers;

const authState = createAuthState(db);
// Rotating AUTH_PASSWORD_HASH / AUTH_USERNAME ends every session: the epoch bump makes
// existing JWTs stale and revokes all device tokens (see lib/auth-state.js).
if (authState.syncCredentialFingerprint(config.AUTH_USERNAME, config.AUTH_PASSWORD_HASH) === 'rotated') {
  console.log('[Auth] Login credential changed since last start: all sessions and device tokens revoked.');
}

const { authenticateToken, credentialFromRequest, requireAuth, requireHouseholdJwt, credentialExpiry } = middleware.createAuth(db, authState);

// Helper to broadcast inventory updates via Socket.io
const { io, broadcastUpdate, disconnectSockets } = createRealtime(server, authenticateToken, credentialExpiry, app.get('trust proxy fn'));

// --- AUTH ---
// One backoff for login and for step-up re-authentication, so a failed re-auth counts as a failed login.
const loginBackoff = createLoginBackoff();
// Login runs before requireAuth, so it is audited (outcome + IP, no body) rather than logged.
app.use('/api/auth/login', middleware.loginAuditLogger(logAction));
registerLoginRoute(app, {
  loginRateLimiter: middleware.loginRateLimiter,
  loginBackoff,
  AUTH_USERNAME: config.AUTH_USERNAME,
  AUTH_PASSWORD_HASH: config.AUTH_PASSWORD_HASH,
  JWT_SECRET: config.JWT_SECRET,
  authState,
});

registerApiHealthRoute(app, { APP_VERSION, credentialFromRequest });

app.use('/api', requireAuth);

// Verbose action logging (#14, #52): mounted after the rate limiters and requireAuth so only
// authenticated, non-throttled requests have their bodies logged.
app.use('/api', middleware.actionLogger(logAction));

registerDeviceTokenRoutes(app, { db, hashDeviceToken: middleware.hashDeviceToken, requireHouseholdJwt, authState, disconnectSockets, loginRateLimiter: middleware.loginRateLimiter, loginBackoff, AUTH_PASSWORD_HASH: config.AUTH_PASSWORD_HASH });

// --- LOCATION ENDPOINTS ---
registerLocationRoutes(app, { db, broadcastUpdate });

// --- CATEGORY ENDPOINTS ---
registerCategoryRoutes(app, { db, broadcastUpdate });

// --- ITEM ENDPOINTS ---
registerItemRoutes(app, { db, broadcastUpdate, getItem, barcodeBelongsToAnotherItem, validForeignId, recalculateItemPrices, resolveTargetLocation, upsertItemLocationQuantity });

registerPriceHistoryRoutes(app, { db, broadcastUpdate, getItem, recalculateItemPrices });

// --- IMAGE AND LLM ENDPOINTS ---
registerUploadRoutes(app, { db, imageUpload: uploads.imageUpload });

registerInvoiceRoutes(app, { db, broadcastUpdate, invoiceUpload: uploads.invoiceUpload, validForeignId, upsertItemLocationQuantity });

// Anything under /api that no route above handled is a JSON 404, never the SPA shell. Mounted
// after every route, so it is reached only by an authenticated caller: requireAuth sits in front
// of everything but login and health, and answers 401 first, so an unauthenticated caller cannot
// tell a real path from a made-up one.
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// React client SPA fallback. Registered after every /api route (and /media above)
// so this wildcard can't shadow them — any request that fell through all of those is a
// client-side route or a hard refresh/deep link into the React app.
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'client/dist/index.html'));
});

// Controlled errors for uploads and malformed requests keep their (deliberate) messages;
// anything else is an unexpected failure, so the client gets a generic 500 with a correlation
// id and the detail stays in the server log (#61).
app.use((err, req, res, next) => {
  if (!err) return next();
  if (res.headersSent) return next(err);
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON in request body.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large.' });
  // Router param decoding (a bad %-escape in the path) sets status 400 without expose.
  if (err instanceof URIError) return res.status(400).json({ error: 'Malformed request path.' });
  // Multipart parse failures from busboy (via multer) are plain Errors with fixed messages.
  // ponytail: message match; a busboy upgrade that rewords these flips them back to 500 (the
  // multipart tests in test/error-hardening.test.js would catch it). Upgrade path: a tagging
  // wrapper around the multer instances in lib/middleware.js.
  if (/^(Unexpected end of form|Malformed (part header|urlencoded form)|Multipart: |Part terminated early|Unexpected end of multipart data)/.test(err.message)) {
    return res.status(400).json({ error: 'Malformed upload request.' });
  }
  const status = err.status || err.statusCode;
  if (status >= 400 && status < 500 && err.expose) return res.status(status).json({ error: err.message || 'Request failed' });
  return sendServerError(res, err, 'Request failed');
});

checkDuplicateBarcodes(db);

setupGracefulShutdown({ db, io, server });

// Start Server
const PORT = config.PORT;
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Terrible Butler server listening on port ${PORT}`);
    console.log(`[Config] trust proxy: ${JSON.stringify(config.TRUST_PROXY)}`);
    // Without either, the Socket.IO origin check expects the Node port's own plain-http origin, so
    // browsers behind a TLS-terminating proxy lose live updates (the page itself still loads).
    if (!process.env.APP_ORIGIN && !config.TRUST_PROXY) {
      console.warn('[Config] Neither APP_ORIGIN nor TRUST_PROXY is set: behind a TLS proxy, browser Socket.IO connections will be refused. Set APP_ORIGIN=https://<your host> (or TRUST_PROXY).');
    }
  });
  scheduleNightlyBackup(db, path.join(path.dirname(dbPath), 'backups'));
  scheduleImportPurge(db, config.INVOICE_IMPORT_RETENTION_DAYS);
}
module.exports = { app, server, db };

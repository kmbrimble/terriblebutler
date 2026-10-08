const express = require('express');
const http = require('http');
const path = require('path');
const multer = require('multer');
const { logAction } = require('./logger');
const { scheduleNightlyBackup } = require('./backup');

const config = require('./lib/config');
const { openDatabase } = require('./lib/database');
const { createRealtime } = require('./lib/realtime');
const middleware = require('./lib/middleware');
const { createDomainHelpers, checkDuplicateBarcodes, sendServerError } = require('./lib/domain-helpers');
const { setupGracefulShutdown } = require('./lib/shutdown');

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
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// legacy: the original front end, kept live at /legacy as a one-week rollback safety net
// after the cutover to the React client (see CHANGELOG). Scoped entirely under /legacy, so
// it can't shadow /api or /uploads regardless of registration order.
app.use('/legacy', express.static(path.join(__dirname, 'public')));

registerHealthzRoute(app, { APP_VERSION });

app.use('/api', middleware.generalApiRateLimiter);

app.use(
  ['/api/parse-label-llm', '/api/invoices/parse'],
  middleware.llmRateLimiter
);

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

const { authenticateToken, requireAuth } = middleware.createAuth(db);

// Helper to broadcast inventory updates via Socket.io
const { io, broadcastUpdate } = createRealtime(server, authenticateToken);

// --- AUTH ---
// Login runs before requireAuth, so it is audited (outcome + IP, no body) rather than logged.
app.use('/api/auth/login', middleware.loginAuditLogger(logAction));
registerLoginRoute(app, {
  loginRateLimiter: middleware.loginRateLimiter,
  AUTH_USERNAME: config.AUTH_USERNAME,
  AUTH_PASSWORD_HASH: config.AUTH_PASSWORD_HASH,
  JWT_SECRET: config.JWT_SECRET,
});

registerApiHealthRoute(app, { APP_VERSION });

app.use('/api', requireAuth);

// Verbose action logging (#14, #52): mounted after the rate limiters and requireAuth so only
// authenticated, non-throttled requests have their bodies logged.
app.use('/api', middleware.actionLogger(logAction));

registerDeviceTokenRoutes(app, { db, hashDeviceToken: middleware.hashDeviceToken });

// --- LOCATION ENDPOINTS ---
registerLocationRoutes(app, { db, broadcastUpdate });

// --- CATEGORY ENDPOINTS ---
registerCategoryRoutes(app, { db, broadcastUpdate });

// --- ITEM ENDPOINTS ---
registerItemRoutes(app, { db, broadcastUpdate, getItem, barcodeBelongsToAnotherItem, validForeignId, recalculateItemPrices, resolveTargetLocation, upsertItemLocationQuantity });

registerPriceHistoryRoutes(app, { db, broadcastUpdate, getItem, recalculateItemPrices });

// --- IMAGE AND LLM ENDPOINTS ---
registerUploadRoutes(app, { db, imageUpload: middleware.imageUpload });

registerInvoiceRoutes(app, { db, broadcastUpdate, invoiceUpload: middleware.invoiceUpload, validForeignId, upsertItemLocationQuantity });

// React client SPA fallback. Registered after every /api route (and /uploads, /legacy above)
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
  });
  scheduleNightlyBackup(db, path.join(path.dirname(dbPath), 'backups'));
}
module.exports = { app, server, db };

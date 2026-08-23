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
const { createDomainHelpers, checkDuplicateBarcodes } = require('./lib/domain-helpers');
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

app.use(middleware.securityHeaders);

const server = http.createServer(app);

// Middleware setup
app.use(express.json({ limit: '1mb' }));

// The React client is now the default front end, served at /.
app.use(express.static(path.join(__dirname, 'client/dist')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// legacy: the original front end, kept live at /legacy as a one-week rollback safety net
// after the cutover to the React client (see CHANGELOG). Scoped entirely under /legacy, so
// it can't shadow /api or /uploads regardless of registration order.
app.use('/legacy', express.static(path.join(__dirname, 'public')));

// Verbose action logging (#14): every mutating /api/* call, request + response body.
app.use('/api', middleware.actionLogger(logAction));

registerHealthzRoute(app, { APP_VERSION });

app.use('/api', middleware.generalApiRateLimiter);

app.use(
  ['/api/parse-label-llm', '/api/invoices/parse'],
  middleware.llmRateLimiter
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
registerLoginRoute(app, {
  loginRateLimiter: middleware.loginRateLimiter,
  AUTH_USERNAME: config.AUTH_USERNAME,
  AUTH_PASSWORD_HASH: config.AUTH_PASSWORD_HASH,
  JWT_SECRET: config.JWT_SECRET,
});

registerApiHealthRoute(app, { APP_VERSION });

app.use('/api', requireAuth);

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
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'client/dist/index.html'));
});

// Return controlled errors for uploads and malformed JSON.
app.use((err, req, res, next) => {
  console.error(err);
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
  if (err) return res.status(400).json({ error: err.message || 'Request failed' });
  next();
});

checkDuplicateBarcodes(db);

setupGracefulShutdown({ db, io, server });

// Start Server
const PORT = config.PORT;
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Terrible Butler server listening on port ${PORT}`);
  });
  scheduleNightlyBackup(db, path.join(path.dirname(dbPath), 'backups'));
}
module.exports = { app, server, db };

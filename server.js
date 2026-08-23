const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { PDFParse } = require('pdf-parse');
const Fuse = require('fuse.js');
const { findMatch, resolveNamedMatch } = require('./item-matching');
const { validateLabelResult, validateInvoiceItems, validateClassifyResult } = require('./llm-schema');
const { parseInvoice } = require('./parsers/router');
const sharp = require('sharp');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { logAction } = require('./logger');
const { scheduleNightlyBackup } = require('./backup');
// Initialise App and Server
const APP_VERSION = '0.29';
const app = express();

const JWT_SECRET = process.env.JWT_SECRET;
const AUTH_USERNAME = process.env.AUTH_USERNAME;
const AUTH_PASSWORD_HASH = process.env.AUTH_PASSWORD_HASH;
if (!JWT_SECRET || !AUTH_USERNAME || !AUTH_PASSWORD_HASH) {
  throw new Error('AUTH_USERNAME, AUTH_PASSWORD_HASH and JWT_SECRET environment variables are required.');
}

app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), fullscreen=(self)');
  next();
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.APP_ORIGIN || true }
});
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
app.use('/api', (req, res, next) => {
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
});

app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', version: APP_VERSION });
});

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
  maxRequests: 240,
  bucketName: 'api'
});

const mutationRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 90,
  bucketName: 'mutation'
});

const llmRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 10,
  bucketName: 'llm'
});

app.use('/api', generalApiRateLimiter);

app.use(
  ['/api/parse-label-llm', '/api/invoices/parse'],
  llmRateLimiter
);

app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return mutationRateLimiter(req, res, next);
  }

  next();
});

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
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_INVOICE_BYTES = 20 * 1024 * 1024;
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
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
  fileFilter: fileFilterFor(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
});
const invoiceUpload = multer({
  storage,
  limits: { fileSize: MAX_INVOICE_BYTES, files: 1 },
  fileFilter: fileFilterFor(['application/pdf'])
});
// Ensure runtime directories exist before uploads or database access.
fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
// Initialise Database
const { runMigrations, migrations } = require('./db-migrations');
const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'inventory.db');
const isFreshDb = !fs.existsSync(dbPath);
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = FULL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
// Initialise Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS locations (
    id INTEGER PRIMARY KEY,
    name TEXT UNIQUE
  );
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY,
    name TEXT UNIQUE
  );
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    barcode TEXT,
    name TEXT NOT NULL,
    location_id INTEGER,
    category_id INTEGER,
    container_details TEXT,
    quantity REAL DEFAULT 0,
    reorder_threshold REAL DEFAULT 0,
    is_ignored_grocery INTEGER DEFAULT 0,
    image_path TEXT,
    last_price REAL DEFAULT 0,
    lowest_price REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(location_id) REFERENCES locations(id),
    FOREIGN KEY(category_id) REFERENCES categories(id)
  );
  CREATE TABLE IF NOT EXISTS price_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER,
    price REAL,
    vendor TEXT,
    recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(item_id) REFERENCES items(id)
  );
  CREATE TABLE IF NOT EXISTS item_locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL,
    location_id INTEGER,
    quantity REAL NOT NULL DEFAULT 0,
    is_open INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE,
    FOREIGN KEY(location_id) REFERENCES locations(id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_item_locations_unique ON item_locations(item_id, location_id) WHERE location_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_item_locations_unique_null ON item_locations(item_id) WHERE location_id IS NULL;
  CREATE TABLE IF NOT EXISTS invoice_imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    retailer TEXT NOT NULL,
    invoice_number TEXT,
    invoice_date TEXT,
    source_filename TEXT,
    status TEXT NOT NULL DEFAULT 'in_progress',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS device_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    device_label TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    revoked INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS invoice_import_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id INTEGER NOT NULL REFERENCES invoice_imports(id),
    raw_name TEXT NOT NULL,
    qty_ordered REAL,
    qty_supplied REAL,
    unit_price REAL,
    line_total REAL,
    gst_applicable INTEGER NOT NULL DEFAULT 0,
    matched_item_id INTEGER REFERENCES items(id),
    suggested_category_id INTEGER REFERENCES categories(id),
    suggested_location_id INTEGER REFERENCES locations(id),
    final_category_id INTEGER REFERENCES categories(id),
    final_location_id INTEGER REFERENCES locations(id),
    barcode_scanned TEXT,
    qty_confirmed REAL,
    line_status TEXT NOT NULL DEFAULT 'pending',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
runMigrations(db, migrations, isFreshDb);
// Seed default locations
const insertLocation = db.prepare('INSERT OR IGNORE INTO locations (name) VALUES (?)');
const defaultLocations = ['Chest Freezer', 'Fridge Freezer', 'Fridge', 'Pantry', 'HP Cupboard'];
defaultLocations.forEach(loc => {
  insertLocation.run(loc);
});
// Helper to broadcast inventory updates via Socket.io
function broadcastUpdate(action, itemData) {
  io.emit('inventory_updated', { action, item: itemData });
  if (action === 'locations_updated' || action === 'categories_updated') {
    io.emit(action, itemData);
  }
}
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token || !authenticateToken(token)) {
    return next(new Error('Unauthorized'));
  }
  next();
});
io.on('connection', (socket) => {
  console.log('A client connected');
  socket.on('disconnect', () => {
    console.log('A client disconnected');
  });
});
// Multi-location stock: an item's real quantity is the sum of its item_locations rows,
// not the (now vestigial) items.quantity column. Appending these as SELECT columns named
// "quantity"/"locations_json" after items.* means the computed value wins in the row
// object (later same-named keys overwrite earlier ones) without having to enumerate every
// other items.* column. Repeated verbatim in WHERE clauses since SQLite can't reference a
// SELECT-list alias there.
const TOTAL_QUANTITY_SQL = `COALESCE((SELECT SUM(quantity) FROM item_locations WHERE item_id = items.id), 0)`;
const LOCATIONS_BREAKDOWN_SQL = `(
    SELECT json_group_array(json_object('location_id', il.location_id, 'location_name', l.name, 'quantity', il.quantity, 'is_open', il.is_open))
    FROM item_locations il
    LEFT JOIN locations l ON il.location_id = l.id
    WHERE il.item_id = items.id
  )`;
// Parses the locations_json column produced by LOCATIONS_BREAKDOWN_SQL into a real array.
function parseItemLocations(row) {
  if (!row) return row;
  row.locations = row.locations_json ? JSON.parse(row.locations_json) : [];
  delete row.locations_json;
  return row;
}
// Helper query to retrieve full item details
const getItemStmt = db.prepare(`
  SELECT items.*, locations.name as location_name, categories.name as category_name,
    ${TOTAL_QUANTITY_SQL} AS quantity,
    ${LOCATIONS_BREAKDOWN_SQL} AS locations_json
  FROM items
  LEFT JOIN locations ON items.location_id = locations.id
  LEFT JOIN categories ON items.category_id = categories.id
  WHERE items.id = ?
`);
function getItem(id) {
  return parseItemLocations(getItemStmt.get(id));
}
// Helper for strict ID parsing
function parseIntOrNull(val) {
  if (val === "" || val === undefined || val === null) return null;
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? null : parsed;
}
function cleanText(value, { required = false, max = 500 } = {}) {
  const text = value === undefined || value === null ? '' : String(value).trim();
  if (required && !text) throw new Error('A required text value is missing');
  if (text.length > max) throw new Error(`Text exceeds the ${max} character limit`);
  return text;
}
function finiteNumber(value, { name = 'Value', min = 0, allowNull = false } = {}) {
  if ((value === '' || value === undefined || value === null) && allowNull) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min) throw new Error(`${name} must be a finite number not less than ${min}`);
  return number;
}
function normaliseBarcode(value) {
  const barcode = cleanText(value, { max: 128 });
  return barcode || null;
}
function barcodeBelongsToAnotherItem(barcode, itemId = null) {
  if (!barcode) return false;
  const row = itemId === null
    ? db.prepare('SELECT id FROM items WHERE barcode = ? LIMIT 1').get(barcode)
    : db.prepare('SELECT id FROM items WHERE barcode = ? AND id <> ? LIMIT 1').get(barcode, itemId);
  return Boolean(row);
}
function validForeignId(table, value, fieldName) {
  const id = parseIntOrNull(value);
  if (id === null) return null;
  if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)) throw new Error(`${fieldName} does not exist`);
  return id;
}
function recalculateItemPrices(itemId) {
  const last = db.prepare('SELECT price FROM price_history WHERE item_id = ? AND price > 0 ORDER BY recorded_at DESC, id DESC LIMIT 1').get(itemId);
  const lowest = db.prepare('SELECT MIN(price) AS price FROM price_history WHERE item_id = ? AND price > 0').get(itemId);
  db.prepare('UPDATE items SET last_price = ?, lowest_price = ? WHERE id = ?').run(last?.price || 0, lowest?.price || 0, itemId);
}
function sendMutationError(res, err) {
  const status = /already assigned/i.test(err.message) ? 409 : 400;
  return res.status(status).json({ error: err.message });
}
// Helper for safe JSON extraction from LLM output
function extractJsonFromText(text) {
  const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/i;
  const match = text.match(codeBlockRegex);
  if (match && match[1]) {
    try { return JSON.parse(match[1]); } catch (e) { }
  }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    try { return JSON.parse(text.substring(firstBrace, lastBrace + 1)); } catch (e) { }
  }
  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    try { return JSON.parse(text.substring(firstBracket, lastBracket + 1)); } catch (e) { }
  }
  return JSON.parse(text);
}
const nativeFetch = global.fetch;
async function fetchWithTimeout(url, options = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await nativeFetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
// Helper for LLM API fetching with fallback
async function fetchWithOllamaFallback(llmApiUrl, payload) {
  let response = await fetchWithTimeout(llmApiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (response.status === 500 && payload.response_format) {
    delete payload.response_format;
    response = await fetchWithTimeout(llmApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }
  if (!response.ok) {
    throw new Error(`HTTP error status: ${response.status}`);
  }
  return response;
}
// --- AUTH ---
const loginRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxRequests: 5,
  bucketName: 'login'
});

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

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: APP_VERSION });
});

const DEVICE_TOKEN_MAX_IDLE_MS = 365 * 24 * 60 * 60 * 1000;

function hashDeviceToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Accepts either a household JWT or a device token as the bearer value. A device token
// is opaque (not self-contained like a JWT), so it's checked against its stored hash and
// rejected if revoked or idle beyond DEVICE_TOKEN_MAX_IDLE_MS; a successful check bumps
// last_used_at, giving it a sliding expiry instead of a hard one.
function authenticateToken(token) {
  try {
    jwt.verify(token, JWT_SECRET);
    return true;
  } catch (err) {
    // Not a valid JWT — fall through to the device-token check below.
  }
  const row = db.prepare('SELECT * FROM device_tokens WHERE token_hash = ?').get(hashDeviceToken(token));
  if (!row || row.revoked) return false;
  if (Date.now() - new Date(row.last_used_at).getTime() > DEVICE_TOKEN_MAX_IDLE_MS) return false;
  db.prepare('UPDATE device_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
  return true;
}

function requireAuth(req, res, next) {
  const [scheme, token] = (req.headers['authorization'] || '').split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!authenticateToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.use('/api', requireAuth);

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

// --- LOCATION ENDPOINTS ---
app.get('/api/locations', (req, res) => {
  res.json(db.prepare('SELECT * FROM locations').all());
});
app.post('/api/locations', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  try {
    const info = db.prepare('INSERT INTO locations (name) VALUES (?)').run(name);
    broadcastUpdate('locations_updated', {});
    res.status(201).json({ id: info.lastInsertRowid, name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.put('/api/locations/:id', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  try {
    const info = db.prepare('UPDATE locations SET name = ? WHERE id = ?').run(name, req.params.id);
    if (!info.changes) return res.status(404).json({ error: 'Location not found' });
    broadcastUpdate('locations_updated', {});
    res.json({ id: req.params.id, name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.delete('/api/locations/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT id FROM locations WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Location not found' });
    db.transaction(() => {
      const stranded = db.prepare('SELECT id, item_id, quantity FROM item_locations WHERE location_id = ?').all(req.params.id);
      for (const row of stranded) {
        const unassigned = db.prepare('SELECT id, quantity FROM item_locations WHERE item_id = ? AND location_id IS NULL').get(row.item_id);
        if (unassigned) {
          db.prepare('UPDATE item_locations SET quantity = quantity + ? WHERE id = ?').run(row.quantity, unassigned.id);
          db.prepare('DELETE FROM item_locations WHERE id = ?').run(row.id);
        } else {
          db.prepare('UPDATE item_locations SET location_id = NULL WHERE id = ?').run(row.id);
        }
      }
      db.prepare('UPDATE invoice_import_lines SET suggested_location_id = NULL WHERE suggested_location_id = ?').run(req.params.id);
      db.prepare('UPDATE invoice_import_lines SET final_location_id = NULL WHERE final_location_id = ?').run(req.params.id);
      db.prepare('DELETE FROM locations WHERE id = ?').run(req.params.id);
    })();
    broadcastUpdate('locations_updated', {});
    res.json({ message: 'Location deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// --- CATEGORY ENDPOINTS ---
app.get('/api/categories', (req, res) => {
  res.json(db.prepare('SELECT * FROM categories').all());
});
app.post('/api/categories', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  try {
    const info = db.prepare('INSERT INTO categories (name) VALUES (?)').run(name);
    broadcastUpdate('categories_updated', {});
    res.status(201).json({ id: info.lastInsertRowid, name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.put('/api/categories/:id', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  try {
    const info = db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name, req.params.id);
    if (!info.changes) return res.status(404).json({ error: 'Category not found' });
    broadcastUpdate('categories_updated', {});
    res.json({ id: req.params.id, name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.delete('/api/categories/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT id FROM categories WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Category not found' });
    db.transaction(() => {
      db.prepare('UPDATE items SET category_id = NULL WHERE category_id = ?').run(req.params.id);
      db.prepare('UPDATE invoice_import_lines SET suggested_category_id = NULL WHERE suggested_category_id = ?').run(req.params.id);
      db.prepare('UPDATE invoice_import_lines SET final_category_id = NULL WHERE final_category_id = ?').run(req.params.id);
      db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
    })();
    broadcastUpdate('categories_updated', {});
    res.json({ message: 'Category deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// --- ITEM ENDPOINTS ---
app.get('/api/items', (req, res) => {
  const stmt = db.prepare(`
    SELECT items.*, locations.name as location_name, categories.name as category_name,
      ${TOTAL_QUANTITY_SQL} AS quantity,
      ${LOCATIONS_BREAKDOWN_SQL} AS locations_json
    FROM items
    LEFT JOIN locations ON items.location_id = locations.id
    LEFT JOIN categories ON items.category_id = categories.id
  `);
  res.json(stmt.all().map(parseItemLocations));
});
app.get('/api/grocery-list', (req, res) => {
  const stmt = db.prepare(`
    SELECT items.*, locations.name as location_name, categories.name as category_name,
      ${TOTAL_QUANTITY_SQL} AS quantity,
      ${LOCATIONS_BREAKDOWN_SQL} AS locations_json
    FROM items
    LEFT JOIN locations ON items.location_id = locations.id
    LEFT JOIN categories ON items.category_id = categories.id
    WHERE ${TOTAL_QUANTITY_SQL} <= reorder_threshold AND is_ignored_grocery = 0
  `);
  res.json(stmt.all().map(parseItemLocations));
});
app.get('/api/out-of-stock-ignored', (req, res) => {
  const stmt = db.prepare(`
    SELECT items.*, locations.name as location_name, categories.name as category_name,
      ${TOTAL_QUANTITY_SQL} AS quantity,
      ${LOCATIONS_BREAKDOWN_SQL} AS locations_json
    FROM items
    LEFT JOIN locations ON items.location_id = locations.id
    LEFT JOIN categories ON items.category_id = categories.id
    WHERE is_ignored_grocery = 1
  `);
  res.json(stmt.all().map(parseItemLocations));
});
app.get('/api/items/search', (req, res) => {
  const query = req.query.q;
  if (!query) {
    return res.json([]);
  }
  const itemsList = db.prepare(`
    SELECT items.*, locations.name as location_name, categories.name as category_name,
      ${TOTAL_QUANTITY_SQL} AS quantity,
      ${LOCATIONS_BREAKDOWN_SQL} AS locations_json
    FROM items
    LEFT JOIN locations ON items.location_id = locations.id
    LEFT JOIN categories ON items.category_id = categories.id
  `).all().map(parseItemLocations);
  const fuse = new Fuse(itemsList, {
    keys: ['name', 'barcode', 'category_name'],
    threshold: 0.3
  });
  const results = fuse.search(query).map(result => result.item);
  res.json(results);
});
app.get('/api/items/match', (req, res) => {
  const barcode = req.query.barcode ? String(req.query.barcode).trim() : null;
  const name = req.query.name ? String(req.query.name).trim() : '';
  const existingItems = db.prepare(`
    SELECT items.id, items.name, items.barcode, items.location_id,
      ${TOTAL_QUANTITY_SQL} AS quantity
    FROM items
  `).all();
  const fuse = new Fuse(existingItems, { keys: ['name'], threshold: 0.3 });
  const match = findMatch(existingItems, { barcode, name }, fuse);
  res.json({ type: match.type, candidates: match.candidates });
});
app.get('/api/items/barcode/:barcode', (req, res) => {
  const stmt = db.prepare(`
    SELECT items.*, locations.name as location_name, categories.name as category_name,
      ${TOTAL_QUANTITY_SQL} AS quantity,
      ${LOCATIONS_BREAKDOWN_SQL} AS locations_json
    FROM items
    LEFT JOIN locations ON items.location_id = locations.id
    LEFT JOIN categories ON items.category_id = categories.id
    WHERE barcode = ?
  `);
  const item = stmt.get(req.params.barcode);
  if (item) {
    res.json(parseItemLocations(item));
  } else {
    res.status(404).json({ error: 'Item not found' });
  }
});
app.get('/api/items/:id/details', (req, res) => {
  const item = getItem(req.params.id);
  if (!item) {
    return res.status(404).json({ error: 'Item not found' });
  }
  const lastPurchase = db.prepare('SELECT price, vendor, recorded_at FROM price_history WHERE item_id = ? ORDER BY recorded_at DESC LIMIT 1').get(req.params.id);
  const lowestPurchase = db.prepare('SELECT price, vendor, recorded_at FROM price_history WHERE item_id = ? AND price > 0 ORDER BY price ASC, recorded_at DESC LIMIT 1').get(req.params.id);
  item.last_purchase = lastPurchase || null;
  item.lowest_purchase = lowestPurchase || null;
  res.json(item);
});
app.get('/api/items/:id/price-history', (req, res) => {
  const stmt = db.prepare('SELECT * FROM price_history WHERE item_id = ? ORDER BY recorded_at DESC');
  res.json(stmt.all(req.params.id));
});
app.post('/api/items', (req, res) => {
  try {
    const barcode = normaliseBarcode(req.body.barcode);
    const name = cleanText(req.body.name, { required: true, max: 200 });
    const locationId = validForeignId('locations', req.body.location_id, 'Location');
    const categoryId = validForeignId('categories', req.body.category_id, 'Category');
    const details = cleanText(req.body.container_details, { max: 500 });
    const quantity = finiteNumber(req.body.quantity ?? 0, { name: 'Quantity', min: 0 });
    const threshold = finiteNumber(req.body.reorder_threshold ?? 0, { name: 'Reorder threshold', min: 0 });
    const price = finiteNumber(req.body.price, { name: 'Price', min: 0, allowNull: true });
    const vendor = cleanText(req.body.vendor || 'Manual entry', { max: 200 });
    const purchaseDate = req.body.purchase_date ? cleanText(req.body.purchase_date, { max: 40 }) : null;
    if (barcodeBelongsToAnotherItem(barcode)) throw new Error('This barcode is already assigned to another item');
    const create = db.transaction(() => {
      const info = db.prepare(`INSERT INTO items
        (barcode, name, category_id, container_details, reorder_threshold)
        VALUES (?, ?, ?, ?, ?)`)
        .run(barcode, name, categoryId, details, threshold);
      const id = Number(info.lastInsertRowid);
      db.prepare('INSERT INTO item_locations (item_id, location_id, quantity) VALUES (?, ?, ?)').run(id, locationId, quantity);
      if (price && price > 0) {
        if (purchaseDate) db.prepare('INSERT INTO price_history (item_id, price, vendor, recorded_at) VALUES (?, ?, ?, ?)').run(id, price, vendor, purchaseDate);
        else db.prepare('INSERT INTO price_history (item_id, price, vendor) VALUES (?, ?, ?)').run(id, price, vendor);
        recalculateItemPrices(id);
      }
      return getItem(id);
    });
    const item = create();
    broadcastUpdate('add', item);
    res.status(201).json(item);
  } catch (err) { sendMutationError(res, err); }
});
app.put('/api/items/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = getItem(id);
  if (!existing) return res.status(404).json({ error: 'Item not found' });
  try {
    const barcode = req.body.barcode === undefined ? existing.barcode : normaliseBarcode(req.body.barcode);
    const name = cleanText(req.body.name, { required: true, max: 200 });
    const categoryId = validForeignId('categories', req.body.category_id, 'Category');
    const details = cleanText(req.body.container_details, { max: 500 });
    const threshold = finiteNumber(req.body.reorder_threshold, { name: 'Reorder threshold', min: 0 });
    const price = finiteNumber(req.body.price, { name: 'Price', min: 0, allowNull: true });
    const vendor = cleanText(req.body.vendor || 'Manual entry', { max: 200 });
    const purchaseDate = req.body.purchase_date ? cleanText(req.body.purchase_date, { max: 40 }) : null;
    if (barcodeBelongsToAnotherItem(barcode, id)) throw new Error('This barcode is already assigned to another item');
    const update = db.transaction(() => {
      db.prepare(`UPDATE items SET barcode = ?, name = ?, category_id = ?,
        container_details = ?, reorder_threshold = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(barcode, name, categoryId, details, threshold, id);
      if (price && price > 0) {
        if (purchaseDate) db.prepare('INSERT INTO price_history (item_id, price, vendor, recorded_at) VALUES (?, ?, ?, ?)').run(id, price, vendor, purchaseDate);
        else db.prepare('INSERT INTO price_history (item_id, price, vendor) VALUES (?, ?, ?)').run(id, price, vendor);
        recalculateItemPrices(id);
      }
      return getItem(id);
    });
    const item = update();
    broadcastUpdate('update', item);
    res.json(item);
  } catch (err) { sendMutationError(res, err); }
});
// Resolves which item_locations row a quantity change should apply to. If the client
// gave an explicit location_id (including '' / null meaning "unassigned"), use that. If
// omitted and the item has stock in exactly one location, infer it — otherwise the
// change is ambiguous and must be rejected (the front end shows a picker in that case).
function resolveTargetLocation(id, rawLocationId) {
  // Omitted entirely -> infer (only safe when the item has at most one location row).
  // Present as null/'' -> an explicit choice of the "unassigned" bucket, not a fallthrough.
  if (rawLocationId === undefined) {
    const rows = db.prepare('SELECT location_id FROM item_locations WHERE item_id = ?').all(id);
    if (rows.length === 1) return rows[0].location_id;
    if (rows.length === 0) return null;
    throw new Error('This item has stock in more than one location — a location_id is required');
  }
  if (rawLocationId === null || rawLocationId === '') return null;
  return validForeignId('locations', rawLocationId, 'Location');
}
function upsertItemLocationQuantity(id, locationId, action, amount) {
  const existing = locationId === null
    ? db.prepare('SELECT id, quantity FROM item_locations WHERE item_id = ? AND location_id IS NULL').get(id)
    : db.prepare('SELECT id, quantity FROM item_locations WHERE item_id = ? AND location_id = ?').get(id, locationId);
  if (action === 'add') {
    if (existing) db.prepare('UPDATE item_locations SET quantity = quantity + ? WHERE id = ?').run(amount, existing.id);
    else db.prepare('INSERT INTO item_locations (item_id, location_id, quantity) VALUES (?, ?, ?)').run(id, locationId, amount);
    return true;
  }
  if (action === 'subtract') {
    if (!existing || existing.quantity < amount) return false;
    // Subtracting exactly 1 auto-clears this location's "open" flag (issue #31) — a
    // data-layer rule applied to ANY caller of this branch (quick "-" button, or a manual
    // deduct of exactly 1 via /deduct), not just one specific UI control.
    if (amount === 1) db.prepare('UPDATE item_locations SET quantity = quantity - ?, is_open = 0 WHERE id = ?').run(amount, existing.id);
    else db.prepare('UPDATE item_locations SET quantity = quantity - ? WHERE id = ?').run(amount, existing.id);
    return true;
  }
  if (action === 'set') {
    if (existing) db.prepare('UPDATE item_locations SET quantity = ? WHERE id = ?').run(amount, existing.id);
    else db.prepare('INSERT INTO item_locations (item_id, location_id, quantity) VALUES (?, ?, ?)').run(id, locationId, amount);
    return true;
  }
  return null;
}
app.patch('/api/items/:id/quantity', (req, res) => {
  const id = Number(req.params.id);
  if (!getItem(id)) return res.status(404).json({ error: 'Item not found' });
  try {
    const amount = finiteNumber(req.body.amount, { name: 'Amount', min: 0 });
    const action = req.body.action;
    const locationId = resolveTargetLocation(id, req.body.location_id);
    const changed = db.transaction(() => upsertItemLocationQuantity(id, locationId, action, amount))();
    if (changed === null) return res.status(400).json({ error: 'Invalid quantity action' });
    if (!changed) return res.status(409).json({ error: 'Insufficient quantity or item not found' });
    db.prepare('UPDATE items SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    const item = getItem(id);
    broadcastUpdate('update_quantity', item);
    res.json(item);
  } catch (err) { sendMutationError(res, err); }
});
app.post('/api/items/:id/deduct', (req, res) => {
  const id = Number(req.params.id);
  if (!getItem(id)) return res.status(404).json({ error: 'Item not found' });
  try {
    const amount = finiteNumber(req.body.amount, { name: 'Amount', min: 0.000001 });
    const locationId = resolveTargetLocation(id, req.body.location_id);
    const changed = db.transaction(() => upsertItemLocationQuantity(id, locationId, 'subtract', amount))();
    if (!changed) return res.status(409).json({ error: 'Insufficient quantity' });
    db.prepare('UPDATE items SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    const item = getItem(id);
    broadcastUpdate('update_quantity', item);
    res.json(item);
  } catch (err) { sendMutationError(res, err); }
});
app.patch('/api/items/:id/ignore-grocery', (req, res) => {
  const { is_ignored_grocery } = req.body;
  const stmt = db.prepare("UPDATE items SET is_ignored_grocery = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
  try {
    const info = stmt.run(is_ignored_grocery, req.params.id);
    if (!info.changes) return res.status(404).json({ error: 'Item not found' });
    const updatedItem = getItem(req.params.id);
    broadcastUpdate('update_ignore', updatedItem);
    res.json(updatedItem);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.patch('/api/items/:id/open', (req, res) => {
  const id = Number(req.params.id);
  if (!getItem(id)) return res.status(404).json({ error: 'Item not found' });
  try {
    const isOpen = req.body.is_open ? 1 : 0;
    const locationId = resolveTargetLocation(id, req.body.location_id);
    const existing = locationId === null
      ? db.prepare('SELECT id FROM item_locations WHERE item_id = ? AND location_id IS NULL').get(id)
      : db.prepare('SELECT id FROM item_locations WHERE item_id = ? AND location_id = ?').get(id, locationId);
    if (!existing) return res.status(404).json({ error: 'Item is not stocked at that location' });
    db.prepare('UPDATE item_locations SET is_open = ? WHERE id = ?').run(isOpen, existing.id);
    db.prepare('UPDATE items SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    const updatedItem = getItem(id);
    broadcastUpdate('update_open', updatedItem);
    res.json(updatedItem);
  } catch (err) { sendMutationError(res, err); }
});
app.delete('/api/items/:id', (req, res) => {
  const id = Number(req.params.id);
  const item = getItem(id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  db.transaction(() => {
    db.prepare('DELETE FROM price_history WHERE item_id = ?').run(id);
    db.prepare('DELETE FROM items WHERE id = ?').run(id);
  })();
  broadcastUpdate('delete', item);
  res.json({ message: 'Item deleted' });
});
app.delete('/api/price-history/:id', (req, res) => {
  const row = db.prepare('SELECT item_id FROM price_history WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Price history entry not found' });
  db.transaction(() => {
    db.prepare('DELETE FROM price_history WHERE id = ?').run(req.params.id);
    recalculateItemPrices(row.item_id);
  })();
  broadcastUpdate('price_history_updated', getItem(row.item_id));
  res.json({ message: 'Price history entry deleted' });
});
// --- IMAGE AND LLM ENDPOINTS ---
app.post('/api/upload-image', imageUpload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image uploaded' });
  }
  const imagePath = `/uploads/${req.file.filename}`;
  res.json({ image_path: imagePath });
});
app.post('/api/parse-label-llm', imageUpload.single('image'), async (req, res) => {
  const fallbackObject = { name: "", container_details: "", category_id: null, location_id: null };
  if (!req.file) {
    console.error("[Label Parser] No image file received in upload request.");
    return res.status(400).json({ error: 'No image uploaded' });
  }
  const llmApiUrl = process.env.LLM_API_URL || 'http://192.168.0.10:11434/v1/chat/completions';
  const llmModel = process.env.LLM_MODEL || 'ibm/granite3.3-vision:2b';
  console.log(`[Label Parser] Received file: ${req.file.originalname} (${req.file.size} bytes)`);
  try {
    const locs = db.prepare('SELECT id, name FROM locations').all();
    const cats = db.prepare('SELECT id, name FROM categories').all();
    const locNames = locs.map(l => l.name).join(', ');
    const catNames = cats.map(c => c.name).join(', ');
    const resizedBuffer = await sharp(req.file.path)
      .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    const base64Image = resizedBuffer.toString('base64');
    console.log(`[Label Parser] Resized image base64 length: ${base64Image.length} characters`);
    const promptText = `Read the text on this product label. Extract the information into a JSON object.
"name": Combine the product brand and product name into a single string.
"container_details": ONLY the strict measurement of weight, volume, or size (e.g., '180g', '2L'). Exclude all other descriptive text.
"category_name": Select the most appropriate category strictly from this list: [${catNames}]. If no category is a good fit, leave it empty.
"location_name": Select the most logical physical storage location for this product strictly from this list: [${locNames}].`;
    const payload = {
      model: llmModel,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: promptText },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
          ]
        }
      ],
      temperature: 0.1,
      max_tokens: 1024,
      stream: false,
      // Ollama's OpenAI-compatible /v1/chat/completions endpoint does not honour a raw
      // top-level `format` field (that's the native /api/chat structured-output
      // mechanism) — it's silently ignored, letting the model return free-form,
      // off-schema JSON. `response_format` with an attached json_schema is the field
      // this endpoint actually enforces. Verified against ibm/granite3.3-vision:2b.
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "label_result",
          schema: {
            type: "object",
            properties: {
              name: { type: "string" },
              category_name: { type: "string" },
              location_name: { type: "string" },
              container_details: { type: "string" }
            },
            required: ["name", "category_name", "location_name", "container_details"]
          }
        }
      }
    };
    console.log(`[Label Parser] Sending request to LLM URL: ${llmApiUrl} (Model: ${llmModel})`);
    const response = await fetchWithTimeout(llmApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Label Parser Error] Ollama responded with HTTP ${response.status}:`, errorText);
      throw new Error(`LLM API returned HTTP ${response.status}: ${errorText}`);
    }
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '{}';
    console.log("[Label Parser] Raw LLM Response:", content);
    let parsedData;
    try {
      parsedData = extractJsonFromText(content);
    } catch (parseErr) {
      console.error("[Label Parser Error] JSON parse failed on response:", parseErr.message);
      parsedData = fallbackObject;
    }
    const validated = validateLabelResult(parsedData);
    if (validated.errors.length) console.warn('[Label Parser] LLM response failed schema validation:', validated.errors);
    const categoryMatch = resolveNamedMatch(cats, validated.category_name, new Fuse(cats, { keys: ['name'], threshold: 0.3 }));
    const locationMatch = resolveNamedMatch(locs, validated.location_name, new Fuse(locs, { keys: ['name'], threshold: 0.3 }));
    return res.json({
      name: validated.name,
      container_details: validated.container_details,
      category_id: categoryMatch.id,
      location_id: locationMatch.id,
      suggested_category_name: categoryMatch.suggested_name,
      similar_category: categoryMatch.similar,
      suggested_location_name: locationMatch.suggested_name,
      similar_location: locationMatch.similar
    });
  } catch (err) {
    console.error("[Label Parser Exception]", err);
    return res.json(fallbackObject);
  } finally {
    if (req.file) {
      fs.unlink(req.file.path, () => {});
    }
  }
});
app.post('/api/invoices/parse', invoiceUpload.single('invoice'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No invoice uploaded' });
  }
  const llmApiUrl = process.env.LLM_API_URL || 'http://192.168.0.10:11434/v1/chat/completions';
  const llmModel = process.env.LLM_MODEL || 'ibm/granite3.3-vision:2b';
  try {
    const dataBuffer = fs.readFileSync(req.file.path);
    const pdfData = await pdfParse(dataBuffer);
    const rawText = pdfData.text;
    const payload = {
      model: llmModel,
      messages: [
        {
          role: "user",
          content: `Parse the following supermarket invoice text. Extract items and return a JSON object with a single key "items" containing an array of objects. Each object must have keys: "name" (string, cleaned title), "container_details" (string), "quantity" (number, strict Supplied/Picked only, ignore Ordered/Out of Stock), "price" (number, unit price), "vendor" (string). Output strictly as JSON.\n\n${rawText}`
        }
      ],
      response_format: { type: "json_object" }
    };
    const response = await fetchWithOllamaFallback(llmApiUrl, payload);
    const data = await response.json();
    const content = data.choices[0].message.content;
    let parsedJson;
    try {
      parsedJson = extractJsonFromText(content);
    } catch (e) {
      parsedJson = { items: [] };
    }
    const { items, errors } = validateInvoiceItems(parsedJson);
    if (errors.length) console.warn('[Invoice Parser] Dropped LLM items failing schema validation:', errors);
    res.json(items);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to parse invoice: ' + err.message });
  } finally {
    if (req.file) fs.unlink(req.file.path, () => {});
  }
});
app.post('/api/invoices/commit', (req, res) => {
  const itemsToCommit = req.body.items;
  if (!Array.isArray(itemsToCommit)) {
    return res.status(400).json({ error: 'Expected an array of items' });
  }
  const existingItems = db.prepare('SELECT id, name, barcode, lowest_price FROM items').all();
  const fuse = new Fuse(existingItems, {
    keys: ['name'],
    threshold: 0.3
  });
  const insertItem = db.prepare(`
    INSERT INTO items (name, barcode, container_details, last_price, lowest_price)
    VALUES (?, ?, ?, ?, ?)
  `);
  const touchItem = db.prepare('UPDATE items SET last_price = ?, lowest_price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
  const insertPriceHistory = db.prepare(`
    INSERT INTO price_history (item_id, price, vendor)
    VALUES (?, ?, ?)
  `);
  try {
    db.transaction(() => {
      for (const item of itemsToCommit) {
        // Match hierarchy: barcode > exact normalised name > user-confirmed (matchDecision) >
        // fuzzy (suggestion only, never auto-applied). See item-matching.js.
        let matchedItem = null;
        if (item.matchDecision && item.matchDecision !== 'new') {
          matchedItem = existingItems.find((i) => i.id === Number(item.matchDecision)) || null;
        } else if (item.matchDecision !== 'new') {
          const match = findMatch(existingItems, { barcode: item.barcode || null, name: item.name }, fuse);
          if (match.type === 'barcode' || match.type === 'exact_name') matchedItem = match.item;
        }

        const locationId = item.location_id ? parseInt(item.location_id) : null;
        let itemId;
        if (matchedItem) {
          itemId = matchedItem.id;
          let newLowest = matchedItem.lowest_price;
          if (newLowest === 0 || item.price < newLowest) {
            newLowest = item.price;
          }
          touchItem.run(item.price, newLowest, itemId);
          matchedItem.lowest_price = newLowest;
          upsertItemLocationQuantity(itemId, locationId, 'add', item.quantity);
        } else {
          const info = insertItem.run(
            item.name,
            item.barcode || null,
            item.container_details || '',
            item.price,
            item.price
          );
          itemId = info.lastInsertRowid;
          upsertItemLocationQuantity(itemId, locationId, 'add', item.quantity);
          // Update the in-memory match set so later line items in this same commit can
          // match against items just inserted, without re-querying the database.
          existingItems.push({ id: itemId, name: item.name, barcode: item.barcode || null, lowest_price: item.price });
          fuse.setCollection(existingItems);
        }
        insertPriceHistory.run(itemId, item.price, item.vendor);
      }
    })();
    broadcastUpdate('invoice_commit', {});
    res.json({ message: 'Invoice items committed successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to commit invoice: ' + err.message });
  }
});

// --- INVOICE IMPORT (Coles/Woolworths deterministic parsers + review staging) ---
function getImportWithLines(importId) {
  const importRow = db.prepare('SELECT * FROM invoice_imports WHERE id = ?').get(importId);
  if (!importRow) return null;
  const lines = db.prepare('SELECT * FROM invoice_import_lines WHERE import_id = ? ORDER BY id').all(importId);
  return { import: importRow, lines };
}

// Text-only classification for a line with no deterministic item match. Reuses the same
// granite vision model in text mode (non-negotiable #6) and the same response_format /
// validation pattern as /api/parse-label-llm. Never blocks the import: any failure (network,
// timeout, malformed response) just leaves the suggestion null for the user to fill in.
async function classifyLineWithLLM(rawName, cats, locs) {
  const llmApiUrl = process.env.LLM_API_URL || 'http://192.168.0.10:11434/v1/chat/completions';
  const llmModel = process.env.LLM_MODEL || 'ibm/granite3.3-vision:2b';
  const catNames = cats.map((c) => c.name).join(', ');
  const locNames = locs.map((l) => l.name).join(', ');
  const promptText = `A supermarket invoice line item is named "${rawName}".
"category_name": Select the most appropriate category strictly from this list: [${catNames}]. If no category is a good fit, leave it empty.
"location_name": Select the most logical physical storage location for this product strictly from this list: [${locNames}].`;
  try {
    const response = await fetchWithTimeout(llmApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: llmModel,
        messages: [{ role: 'user', content: promptText }],
        temperature: 0.1,
        max_tokens: 256,
        stream: false,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'classify_result',
            schema: {
              type: 'object',
              properties: {
                category_name: { type: 'string' },
                location_name: { type: 'string' },
              },
              required: ['category_name', 'location_name'],
            },
          },
        },
      }),
    }, 15000);
    if (!response.ok) throw new Error(`LLM API returned HTTP ${response.status}`);
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '{}';
    const validated = validateClassifyResult(extractJsonFromText(content));
    if (validated.errors.length) console.warn('[Invoice Import Classify] LLM response failed schema validation:', validated.errors);
    const categoryMatch = resolveNamedMatch(cats, validated.category_name, new Fuse(cats, { keys: ['name'], threshold: 0.3 }));
    const locationMatch = resolveNamedMatch(locs, validated.location_name, new Fuse(locs, { keys: ['name'], threshold: 0.3 }));
    return { category_id: categoryMatch.id, location_id: locationMatch.id };
  } catch (err) {
    console.warn(`[Invoice Import Classify] LLM classification failed for "${rawName}":`, err.message);
    return { category_id: null, location_id: null };
  }
}

app.post('/api/invoices/import', invoiceUpload.single('invoice'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No invoice uploaded' });
  try {
    const pdfParser = new PDFParse({ data: fs.readFileSync(req.file.path) });
    const { text } = await pdfParser.getText();
    await pdfParser.destroy();

    const parsed = parseInvoice(text);
    if (!parsed.retailer) {
      return res.status(422).json({ error: parsed.error || 'Could not detect retailer from this PDF.' });
    }

    // items.location_id is a vestigial column POST /api/items deliberately never writes —
    // item_locations is the real source of truth. Only offer a location suggestion when an
    // item lives in exactly one location; split across several, it's ambiguous, so leave it
    // for the review screen.
    const singleLocationByItem = new Map(
      db.prepare(`
        SELECT item_id, location_id FROM item_locations
        WHERE item_id IN (SELECT item_id FROM item_locations GROUP BY item_id HAVING COUNT(*) = 1)
      `).all().map((r) => [r.item_id, r.location_id])
    );
    const existingItems = db.prepare('SELECT id, name, barcode, category_id FROM items').all()
      .map((item) => ({ ...item, location_id: singleLocationByItem.get(item.id) ?? null }));
    const fuse = new Fuse(existingItems, { keys: ['name'], threshold: 0.3 });
    const cats = db.prepare('SELECT id, name FROM categories').all();
    const locs = db.prepare('SELECT id, name FROM locations').all();

    const importInfo = db.prepare(`
      INSERT INTO invoice_imports (retailer, invoice_number, invoice_date, source_filename)
      VALUES (?, ?, ?, ?)
    `).run(parsed.retailer, parsed.invoice_number || null, parsed.invoice_date || null, req.file.originalname);
    const importId = Number(importInfo.lastInsertRowid);

    const insertLine = db.prepare(`
      INSERT INTO invoice_import_lines
        (import_id, raw_name, qty_ordered, qty_supplied, unit_price, line_total, gst_applicable,
         matched_item_id, suggested_category_id, suggested_location_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Deterministic match first: an exact (or barcode) hit is confident enough to inherit
    // its item's category/location as the suggestion and record matched_item_id outright.
    // A fuzzy hit is suggestion-only — its category/location still pre-fill the review
    // screen, but matched_item_id stays null (never auto-applied — see item-matching.js).
    // Only lines with neither get an LLM classify call, and those run in parallel — with a
    // 32-line invoice, awaiting them one at a time would mean worst-case minutes of serial
    // network latency for something the UI is waiting on.
    const resolved = parsed.lines.map((line) => {
      const match = findMatch(existingItems, { barcode: null, name: line.raw_name }, fuse);
      if (match.type === 'barcode' || match.type === 'exact_name') {
        return { line, matchedItemId: match.item.id, suggestedCategoryId: match.item.category_id, suggestedLocationId: match.item.location_id };
      }
      if (match.type === 'fuzzy') {
        return { line, matchedItemId: null, suggestedCategoryId: match.candidates[0].category_id, suggestedLocationId: match.candidates[0].location_id };
      }
      return { line, matchedItemId: null, needsClassify: true };
    });

    await Promise.all(resolved.filter((r) => r.needsClassify).map(async (r) => {
      const classified = await classifyLineWithLLM(r.line.raw_name, cats, locs);
      r.suggestedCategoryId = classified.category_id;
      r.suggestedLocationId = classified.location_id;
    }));

    for (const r of resolved) {
      insertLine.run(
        importId, r.line.raw_name, r.line.qty_ordered, r.line.qty_supplied, r.line.unit_price, r.line.line_total,
        r.line.gst_applicable ? 1 : 0, r.matchedItemId, r.suggestedCategoryId, r.suggestedLocationId
      );
    }

    res.json(getImportWithLines(importId));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to import invoice: ' + err.message });
  } finally {
    if (req.file) fs.unlink(req.file.path, () => {});
  }
});

app.get('/api/invoices/import/:id', (req, res) => {
  const result = getImportWithLines(Number(req.params.id));
  if (!result) return res.status(404).json({ error: 'Import not found' });
  res.json(result);
});

const INVOICE_LINE_PATCH_FIELDS = {
  final_category_id: (v) => validForeignId('categories', v, 'Category'),
  final_location_id: (v) => validForeignId('locations', v, 'Location'),
  qty_confirmed: (v) => finiteNumber(v, { name: 'Confirmed quantity', min: 0, allowNull: true }),
  barcode_scanned: (v) => cleanText(v, { max: 128 }) || null,
  line_status: (v) => {
    if (!['pending', 'reviewed', 'skipped'].includes(v)) throw new Error('Invalid line_status');
    return v;
  },
};

app.patch('/api/invoices/import/:id/lines/:lineId', (req, res) => {
  const importId = Number(req.params.id);
  const lineId = Number(req.params.lineId);
  const line = db.prepare('SELECT id FROM invoice_import_lines WHERE id = ? AND import_id = ?').get(lineId, importId);
  if (!line) return res.status(404).json({ error: 'Import line not found' });
  const importRow = db.prepare('SELECT status FROM invoice_imports WHERE id = ?').get(importId);
  if (importRow.status === 'committed') return res.status(409).json({ error: 'This import has already been committed' });

  const updates = [];
  const values = [];
  try {
    for (const [field, validate] of Object.entries(INVOICE_LINE_PATCH_FIELDS)) {
      if (field in req.body) {
        updates.push(`${field} = ?`);
        values.push(validate(req.body[field]));
      }
    }
  } catch (err) {
    return sendMutationError(res, err);
  }
  if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });

  updates.push('updated_at = CURRENT_TIMESTAMP');
  values.push(lineId);
  db.prepare(`UPDATE invoice_import_lines SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  res.json(db.prepare('SELECT * FROM invoice_import_lines WHERE id = ?').get(lineId));
});

app.post('/api/invoices/import/:id/commit', (req, res) => {
  const importId = Number(req.params.id);
  const importRow = db.prepare('SELECT * FROM invoice_imports WHERE id = ?').get(importId);
  if (!importRow) return res.status(404).json({ error: 'Import not found' });
  if (importRow.status === 'committed') return res.status(409).json({ error: 'This import has already been committed' });

  const lines = db.prepare('SELECT * FROM invoice_import_lines WHERE import_id = ?').all(importId);
  if (lines.some((l) => l.line_status === 'pending')) {
    return res.status(400).json({ error: 'All lines must be reviewed or skipped before committing' });
  }

  const existingItems = db.prepare('SELECT id, name, barcode, lowest_price FROM items').all();
  const fuse = new Fuse(existingItems, { keys: ['name'], threshold: 0.3 });
  const insertItem = db.prepare(`
    INSERT INTO items (name, barcode, category_id, last_price, lowest_price)
    VALUES (?, ?, ?, ?, ?)
  `);
  const touchItem = db.prepare('UPDATE items SET last_price = ?, lowest_price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
  const insertPriceHistory = db.prepare('INSERT INTO price_history (item_id, price, vendor) VALUES (?, ?, ?)');
  const markLineMatched = db.prepare('UPDATE invoice_import_lines SET matched_item_id = ? WHERE id = ?');

  let itemsAdded = 0;
  let itemsMatched = 0;
  let totalValue = 0;

  try {
    db.transaction(() => {
      for (const line of lines) {
        if (line.line_status === 'skipped') continue;

        const categoryId = line.final_category_id ?? line.suggested_category_id;
        const locationId = line.final_location_id ?? line.suggested_location_id;
        const qty = line.qty_confirmed ?? line.qty_supplied ?? 0;
        const price = line.unit_price ?? 0;

        // Reusing findMatch (rather than just trusting the staged matched_item_id) covers
        // two new lines in the same import sharing a name — the first one's just-created
        // item is picked up as an exact match for the second, same as the existing
        // /api/invoices/commit endpoint.
        let matchedItem = line.matched_item_id
          ? existingItems.find((i) => i.id === line.matched_item_id) || null
          : null;
        if (!matchedItem) {
          const match = findMatch(existingItems, { barcode: line.barcode_scanned || null, name: line.raw_name }, fuse);
          if (match.type === 'barcode' || match.type === 'exact_name') matchedItem = match.item;
        }

        let itemId;
        if (matchedItem) {
          itemId = matchedItem.id;
          let newLowest = matchedItem.lowest_price;
          if (!newLowest || price < newLowest) newLowest = price;
          touchItem.run(price, newLowest, itemId);
          matchedItem.lowest_price = newLowest;
          upsertItemLocationQuantity(itemId, locationId, 'add', qty);
          itemsMatched += 1;
        } else {
          const info = insertItem.run(line.raw_name, line.barcode_scanned || null, categoryId, price, price);
          itemId = Number(info.lastInsertRowid);
          upsertItemLocationQuantity(itemId, locationId, 'add', qty);
          existingItems.push({ id: itemId, name: line.raw_name, barcode: line.barcode_scanned || null, lowest_price: price });
          fuse.setCollection(existingItems);
          itemsAdded += 1;
        }
        insertPriceHistory.run(itemId, price, importRow.retailer);
        markLineMatched.run(itemId, line.id);
        totalValue += line.line_total || 0;
      }
      db.prepare("UPDATE invoice_imports SET status = 'committed' WHERE id = ?").run(importId);
    })();

    broadcastUpdate('invoice_commit', {});
    res.json({ items_added: itemsAdded, items_matched: itemsMatched, total_value: Math.round(totalValue * 100) / 100 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to commit invoice import: ' + err.message });
  }
});

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
const duplicateBarcodes = db.prepare(`
  SELECT barcode, COUNT(*) AS count FROM items
  WHERE barcode IS NOT NULL AND barcode <> ''
  GROUP BY barcode HAVING COUNT(*) > 1
`).all();
if (duplicateBarcodes.length) {
  console.warn(`[Startup] ${duplicateBarcodes.length} duplicate barcode value(s) already exist. Resolve these before enforcing a database-level unique index.`);
}

let shutdownInProgress = false;

function closeDatabaseAndExit(exitCode) {
  try {
    if (db.open) {
      db.close();
      console.log('[Shutdown] SQLite database closed.');
    }
  } catch (err) {
    console.error('[Shutdown] Failed to close SQLite database:', err);
    exitCode = 1;
  }

  process.exit(exitCode);
}

function gracefulShutdown(signal) {
  if (shutdownInProgress) {
    console.log(`[Shutdown] ${signal} received while shutdown is already in progress.`);
    return;
  }

  shutdownInProgress = true;
  console.log(`[Shutdown] Received ${signal}. Closing Terrible Butler.`);

  const forceExitTimer = setTimeout(() => {
    console.error('[Shutdown] Graceful shutdown exceeded 5 seconds. Forcing exit.');
    process.exit(1);
  }, 5000);

  forceExitTimer.unref();

  const finishShutdown = (exitCode = 0) => {
    clearTimeout(forceExitTimer);
    closeDatabaseAndExit(exitCode);
  };

  try {
    io.close(() => {
      console.log('[Shutdown] Socket.io closed.');

      server.close((err) => {
        if (err && err.code !== 'ERR_SERVER_NOT_RUNNING') {
          console.error('[Shutdown] Failed to close HTTP server:', err);
          finishShutdown(1);
          return;
        }

        console.log('[Shutdown] HTTP server closed.');
        finishShutdown(0);
      });
    });
  } catch (err) {
    console.error('[Shutdown] Failed while closing Socket.io:', err);

    server.close((serverErr) => {
      if (serverErr && serverErr.code !== 'ERR_SERVER_NOT_RUNNING') {
        console.error('[Shutdown] Failed to close HTTP server:', serverErr);
      }

      finishShutdown(1);
    });
  }
}

process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.once('SIGINT', () => gracefulShutdown('SIGINT'));

// Start Server
const PORT = process.env.PORT || 2626;
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Terrible Butler server listening on port ${PORT}`);
  });
  scheduleNightlyBackup(db, path.join(path.dirname(dbPath), 'backups'));
}
module.exports = { app, server, db };

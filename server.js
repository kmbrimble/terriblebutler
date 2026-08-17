const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const Fuse = require('fuse.js');
const { findMatch, resolveNamedMatch } = require('./item-matching');
const { validateLabelResult, validateInvoiceItems } = require('./llm-schema');
const sharp = require('sharp');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
// Initialise App and Server
const APP_VERSION = '0.15';
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
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

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
    FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE,
    FOREIGN KEY(location_id) REFERENCES locations(id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_item_locations_unique ON item_locations(item_id, location_id) WHERE location_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_item_locations_unique_null ON item_locations(item_id) WHERE location_id IS NULL;
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
  if (!token) {
    return next(new Error('Unauthorized'));
  }
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    next(new Error('Unauthorized'));
  }
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
    SELECT json_group_array(json_object('location_id', il.location_id, 'location_name', l.name, 'quantity', il.quantity))
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

function requireAuth(req, res, next) {
  const [scheme, token] = (req.headers['authorization'] || '').split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

app.use('/api', requireAuth);

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
    db.prepare('UPDATE item_locations SET quantity = quantity - ? WHERE id = ?').run(amount, existing.id);
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
}
module.exports = { app, server, db };

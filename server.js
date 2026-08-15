const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const Fuse = require('fuse.js');
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
const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'inventory.db');
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
`);
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
// Helper query to retrieve full item details
const getItem = db.prepare(`
  SELECT items.*, locations.name as location_name, categories.name as category_name
  FROM items
  LEFT JOIN locations ON items.location_id = locations.id
  LEFT JOIN categories ON items.category_id = categories.id
  WHERE items.id = ?
`);
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
      db.prepare('UPDATE items SET location_id = NULL WHERE location_id = ?').run(req.params.id);
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
    SELECT items.*, locations.name as location_name, categories.name as category_name
    FROM items
    LEFT JOIN locations ON items.location_id = locations.id
    LEFT JOIN categories ON items.category_id = categories.id
  `);
  res.json(stmt.all());
});
app.get('/api/grocery-list', (req, res) => {
  const stmt = db.prepare(`
    SELECT items.*, locations.name as location_name, categories.name as category_name
    FROM items
    LEFT JOIN locations ON items.location_id = locations.id
    LEFT JOIN categories ON items.category_id = categories.id
    WHERE quantity <= reorder_threshold AND is_ignored_grocery = 0
  `);
  res.json(stmt.all());
});
app.get('/api/out-of-stock-ignored', (req, res) => {
  const stmt = db.prepare(`
    SELECT items.*, locations.name as location_name, categories.name as category_name
    FROM items
    LEFT JOIN locations ON items.location_id = locations.id
    LEFT JOIN categories ON items.category_id = categories.id
    WHERE is_ignored_grocery = 1
  `);
  res.json(stmt.all());
});
app.get('/api/items/search', (req, res) => {
  const query = req.query.q;
  if (!query) {
    return res.json([]);
  }
  const itemsList = db.prepare(`
    SELECT items.*, locations.name as location_name, categories.name as category_name
    FROM items
    LEFT JOIN locations ON items.location_id = locations.id
    LEFT JOIN categories ON items.category_id = categories.id
  `).all();
  const fuse = new Fuse(itemsList, {
    keys: ['name', 'barcode', 'category_name'],
    threshold: 0.3
  });
  const results = fuse.search(query).map(result => result.item);
  res.json(results);
});
app.get('/api/items/barcode/:barcode', (req, res) => {
  const stmt = db.prepare(`
    SELECT items.*, locations.name as location_name, categories.name as category_name
    FROM items
    LEFT JOIN locations ON items.location_id = locations.id
    LEFT JOIN categories ON items.category_id = categories.id
    WHERE barcode = ?
  `);
  const item = stmt.get(req.params.barcode);
  if (item) {
    res.json(item);
  } else {
    res.status(404).json({ error: 'Item not found' });
  }
});
app.get('/api/items/:id/details', (req, res) => {
  const item = getItem.get(req.params.id);
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
        (barcode, name, location_id, category_id, container_details, quantity, reorder_threshold)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(barcode, name, locationId, categoryId, details, quantity, threshold);
      const id = Number(info.lastInsertRowid);
      if (price && price > 0) {
        if (purchaseDate) db.prepare('INSERT INTO price_history (item_id, price, vendor, recorded_at) VALUES (?, ?, ?, ?)').run(id, price, vendor, purchaseDate);
        else db.prepare('INSERT INTO price_history (item_id, price, vendor) VALUES (?, ?, ?)').run(id, price, vendor);
        recalculateItemPrices(id);
      }
      return getItem.get(id);
    });
    const item = create();
    broadcastUpdate('add', item);
    res.status(201).json(item);
  } catch (err) { sendMutationError(res, err); }
});
app.put('/api/items/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = getItem.get(id);
  if (!existing) return res.status(404).json({ error: 'Item not found' });
  try {
    const barcode = req.body.barcode === undefined ? existing.barcode : normaliseBarcode(req.body.barcode);
    const name = cleanText(req.body.name, { required: true, max: 200 });
    const locationId = validForeignId('locations', req.body.location_id, 'Location');
    const categoryId = validForeignId('categories', req.body.category_id, 'Category');
    const details = cleanText(req.body.container_details, { max: 500 });
    const quantity = finiteNumber(req.body.quantity, { name: 'Quantity', min: 0 });
    const threshold = finiteNumber(req.body.reorder_threshold, { name: 'Reorder threshold', min: 0 });
    const price = finiteNumber(req.body.price, { name: 'Price', min: 0, allowNull: true });
    const vendor = cleanText(req.body.vendor || 'Manual entry', { max: 200 });
    const purchaseDate = req.body.purchase_date ? cleanText(req.body.purchase_date, { max: 40 }) : null;
    if (barcodeBelongsToAnotherItem(barcode, id)) throw new Error('This barcode is already assigned to another item');
    const update = db.transaction(() => {
      db.prepare(`UPDATE items SET barcode = ?, name = ?, location_id = ?, category_id = ?,
        container_details = ?, quantity = ?, reorder_threshold = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(barcode, name, locationId, categoryId, details, quantity, threshold, id);
      if (price && price > 0) {
        if (purchaseDate) db.prepare('INSERT INTO price_history (item_id, price, vendor, recorded_at) VALUES (?, ?, ?, ?)').run(id, price, vendor, purchaseDate);
        else db.prepare('INSERT INTO price_history (item_id, price, vendor) VALUES (?, ?, ?)').run(id, price, vendor);
        recalculateItemPrices(id);
      }
      return getItem.get(id);
    });
    const item = update();
    broadcastUpdate('update', item);
    res.json(item);
  } catch (err) { sendMutationError(res, err); }
});
app.patch('/api/items/:id/quantity', (req, res) => {
  const id = Number(req.params.id);
  if (!getItem.get(id)) return res.status(404).json({ error: 'Item not found' });
  try {
    const amount = finiteNumber(req.body.amount, { name: 'Amount', min: 0 });
    const action = req.body.action;
    let info;
    if (action === 'add') info = db.prepare('UPDATE items SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(amount, id);
    else if (action === 'subtract') info = db.prepare('UPDATE items SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND quantity >= ?').run(amount, id, amount);
    else if (action === 'set') info = db.prepare('UPDATE items SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(amount, id);
    else return res.status(400).json({ error: 'Invalid quantity action' });
    if (!info.changes) return res.status(409).json({ error: 'Insufficient quantity or item not found' });
    const item = getItem.get(id);
    broadcastUpdate('update_quantity', item);
    res.json(item);
  } catch (err) { sendMutationError(res, err); }
});
app.post('/api/items/:id/deduct', (req, res) => {
  const id = Number(req.params.id);
  try {
    const amount = finiteNumber(req.body.amount, { name: 'Amount', min: 0.000001 });
    const info = db.prepare('UPDATE items SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND quantity >= ?').run(amount, id, amount);
    if (!info.changes) {
      if (!getItem.get(id)) return res.status(404).json({ error: 'Item not found' });
      return res.status(409).json({ error: 'Insufficient quantity' });
    }
    const item = getItem.get(id);
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
    const updatedItem = getItem.get(req.params.id);
    broadcastUpdate('update_ignore', updatedItem);
    res.json(updatedItem);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.delete('/api/items/:id', (req, res) => {
  const id = Number(req.params.id);
  const item = getItem.get(id);
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
  broadcastUpdate('price_history_updated', getItem.get(row.item_id));
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
      format: {
        type: "object",
        properties: {
          name: { type: "string" },
          category_name: { type: "string" },
          location_name: { type: "string" },
          container_details: { type: "string" }
        },
        required: ["name", "category_name", "location_name", "container_details"]
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
    let containerDetailsStr = '';
    if (typeof parsedData.container_details === 'object' && parsedData.container_details !== null) {
      const values = Object.values(parsedData.container_details).filter(Boolean);
      containerDetailsStr = values.join('');
    } else if (parsedData.container_details) {
      containerDetailsStr = String(parsedData.container_details);
    }
    let matchedCategoryId = null;
    if (parsedData.category_name) {
      const cat = cats.find(c => c.name.toLowerCase() === String(parsedData.category_name).toLowerCase().trim());
      if (cat) matchedCategoryId = cat.id;
    }
    let matchedLocationId = null;
    if (parsedData.location_name) {
      const loc = locs.find(l => l.name.toLowerCase() === String(parsedData.location_name).toLowerCase().trim());
      if (loc) matchedLocationId = loc.id;
    }
    return res.json({
      name: typeof parsedData.name === 'string' ? parsedData.name : '',
      container_details: containerDetailsStr,
      category_id: matchedCategoryId,
      location_id: matchedLocationId
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
    const items = parsedJson.items || parsedJson;
    res.json(Array.isArray(items) ? items : []);
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
  const existingItems = db.prepare('SELECT id, name, quantity, lowest_price FROM items').all();
  const fuse = new Fuse(existingItems, {
    keys: ['name'],
    threshold: 0.3
  });
  const insertItem = db.prepare(`
    INSERT INTO items (name, location_id, container_details, quantity, last_price, lowest_price)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const updateItem = db.prepare(`
    UPDATE items
    SET quantity = quantity + ?,
        last_price = ?,
        lowest_price = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  const insertPriceHistory = db.prepare(`
    INSERT INTO price_history (item_id, price, vendor)
    VALUES (?, ?, ?)
  `);
  try {
    db.transaction(() => {
      for (const item of itemsToCommit) {
        const results = fuse.search(item.name);
        let itemId;
        if (results.length > 0) {
          const matchedItem = results[0].item;
          itemId = matchedItem.id;
          let newLowest = matchedItem.lowest_price;
          if (newLowest === 0 || item.price < newLowest) {
            newLowest = item.price;
          }
          updateItem.run(item.quantity, item.price, newLowest, itemId);
        } else {
          const locationId = item.location_id ? parseInt(item.location_id) : null;
          const info = insertItem.run(
            item.name,
            locationId,
            item.container_details || '',
            item.quantity,
            item.price,
            item.price
          );
          itemId = info.lastInsertRowid;
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

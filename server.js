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

// Initialise App and Server
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// Middleware setup
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

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
const upload = multer({ storage: storage });

// Initialise Database
const db = new Database(path.join(__dirname, 'data', 'inventory.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = FULL');

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
}

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

// Helper for safe JSON extraction from LLM output
function extractJsonFromText(text) {
  const codeBlockRegex = /\`\`\`(?:json)?\s*([\s\S]*?)\s*\`\`\`/i;
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

// Helper for LLM API fetching with fallback
async function fetchWithOllamaFallback(llmApiUrl, payload) {
  let response = await fetch(llmApiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (response.status === 500 && payload.response_format) {
    delete payload.response_format;
    response = await fetch(llmApiUrl, {
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
    db.prepare('UPDATE locations SET name = ? WHERE id = ?').run(name, req.params.id);
    broadcastUpdate('locations_updated', {});
    res.json({ id: req.params.id, name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/locations/:id', (req, res) => {
  try {
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
    db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name, req.params.id);
    broadcastUpdate('categories_updated', {});
    res.json({ id: req.params.id, name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/categories/:id', (req, res) => {
  try {
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
  const { barcode, name, location_id, category_id, container_details, quantity, reorder_threshold, is_ignored_grocery, image_path, last_price, lowest_price, price, vendor, purchase_date } = req.body;
  
  const parsedLocId = parseIntOrNull(location_id);
  const parsedCatId = parseIntOrNull(category_id);

  const stmt = db.prepare(`
    INSERT INTO items (barcode, name, location_id, category_id, container_details, quantity, reorder_threshold, is_ignored_grocery, image_path, last_price, lowest_price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  try {
    const info = stmt.run(barcode, name, parsedLocId, parsedCatId, container_details, quantity || 0, reorder_threshold || 0, is_ignored_grocery || 0, image_path, last_price || 0, lowest_price || 0);
    const newItemId = info.lastInsertRowid;
    
    if (price && parseFloat(price) > 0) {
      if (purchase_date) {
        db.prepare('INSERT INTO price_history (item_id, price, vendor, recorded_at) VALUES (?, ?, ?, ?)').run(newItemId, parseFloat(price), vendor || 'Manual entry', purchase_date);
      } else {
        db.prepare('INSERT INTO price_history (item_id, price, vendor) VALUES (?, ?, ?)').run(newItemId, parseFloat(price), vendor || 'Manual entry');
      }
    }
    
    const newItem = getItem.get(newItemId);
    broadcastUpdate('add', newItem);
    res.status(201).json(newItem);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/items/:id', (req, res) => {
  const { barcode, name, location_id, category_id, container_details, quantity, reorder_threshold, is_ignored_grocery, image_path, last_price, lowest_price, price, vendor, purchase_date } = req.body;
  const id = req.params.id;
  
  const parsedLocId = parseIntOrNull(location_id);
  const parsedCatId = parseIntOrNull(category_id);

  const stmt = db.prepare(`
    UPDATE items
    SET barcode = ?, name = ?, location_id = ?, category_id = ?, container_details = ?, quantity = ?, reorder_threshold = ?, is_ignored_grocery = ?, image_path = ?, last_price = ?, lowest_price = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  
  try {
    stmt.run(barcode, name, parsedLocId, parsedCatId, container_details, quantity, reorder_threshold, is_ignored_grocery, image_path, last_price, lowest_price, id);
    
    if (price && parseFloat(price) > 0) {
      if (purchase_date) {
        db.prepare('INSERT INTO price_history (item_id, price, vendor, recorded_at) VALUES (?, ?, ?, ?)').run(id, parseFloat(price), vendor || 'Manual entry', purchase_date);
      } else {
        db.prepare('INSERT INTO price_history (item_id, price, vendor) VALUES (?, ?, ?)').run(id, parseFloat(price), vendor || 'Manual entry');
      }
    }
    
    const updatedItem = getItem.get(id);
    broadcastUpdate('update', updatedItem);
    res.json(updatedItem);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/items/:id/quantity', (req, res) => {
  const { amount, action } = req.body; 
  let stmt;
  
  if (action === 'add') {
    stmt = db.prepare("UPDATE items SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
  } else if (action === 'subtract') {
    stmt = db.prepare("UPDATE items SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
  } else {
    stmt = db.prepare("UPDATE items SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
  }

  try {
    stmt.run(amount, req.params.id);
    const updatedItem = getItem.get(req.params.id);
    broadcastUpdate('update_quantity', updatedItem);
    res.json(updatedItem);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/items/:id/deduct', (req, res) => {
  const { amount } = req.body;
  const stmt = db.prepare("UPDATE items SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
  
  try {
    stmt.run(amount, req.params.id);
    const updatedItem = getItem.get(req.params.id);
    broadcastUpdate('update_quantity', updatedItem);
    res.json(updatedItem);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/items/:id/ignore-grocery', (req, res) => {
  const { is_ignored_grocery } = req.body;
  const stmt = db.prepare("UPDATE items SET is_ignored_grocery = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
  try {
    stmt.run(is_ignored_grocery, req.params.id);
    const updatedItem = getItem.get(req.params.id);
    broadcastUpdate('update_ignore', updatedItem);
    res.json(updatedItem);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/items/:id', (req, res) => {
  const id = req.params.id;
  const itemToDelete = getItem.get(id);
  const stmt = db.prepare("DELETE FROM items WHERE id = ?");
  try {
    stmt.run(id);
    broadcastUpdate('delete', itemToDelete);
    res.json({ message: 'Item deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/price-history/:id', (req, res) => {
  const stmt = db.prepare("DELETE FROM price_history WHERE id = ?");
  try {
    stmt.run(req.params.id);
    res.json({ message: 'Price history entry deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- IMAGE AND LLM ENDPOINTS ---
app.post('/api/upload-image', upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image uploaded' });
  }
  const imagePath = `/uploads/${req.file.filename}`;
  res.json({ image_path: imagePath });
});

app.post('/api/parse-label-llm', upload.single('image'), async (req, res) => {
  const fallbackObject = { name: "", container_details: "", category_id: null, location_id: null };

  if (!req.file) {
    console.error("[Label Parser] No image file received in upload request.");
    return res.status(400).json({ error: 'No image uploaded' });
  }

  const llmApiUrl = process.env.LLM_API_URL || 'http://localhost:11434/v1/chat/completions';
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

    const response = await fetch(llmApiUrl, {
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

app.post('/api/invoices/parse', upload.single('invoice'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No invoice uploaded' });
  }

  const llmApiUrl = process.env.LLM_API_URL || 'http://localhost:11434/v1/chat/completions';
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

// Start Server
const PORT = process.env.PORT || 2626;
server.listen(PORT, () => {
 console.log(`Terrible Butler server listening on port ${PORT}`);
});

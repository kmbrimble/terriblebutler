const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

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

// Configure Multer for image uploads
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
const db = new Database('inventory.db');
db.pragma('journal_mode = WAL');

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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(location_id) REFERENCES locations(id),
    FOREIGN KEY(category_id) REFERENCES categories(id)
  );
`);

// Seed default locations
const insertLocation = db.prepare('INSERT OR IGNORE INTO locations (name) VALUES (?)');
const defaultLocations = ['Freezer', 'Fridge', 'Pantry'];
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

// GET /api/items
app.get('/api/items', (req, res) => {
  const stmt = db.prepare(`
    SELECT items.*, locations.name as location_name, categories.name as category_name
    FROM items
    LEFT JOIN locations ON items.location_id = locations.id
    LEFT JOIN categories ON items.category_id = categories.id
  `);
  res.json(stmt.all());
});

// GET /api/grocery-list
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

// GET /api/out-of-stock-ignored
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

// GET /api/items/barcode/:barcode
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

// POST /api/items
app.post('/api/items', (req, res) => {
  const { barcode, name, location_id, category_id, container_details, quantity, reorder_threshold, is_ignored_grocery, image_path } = req.body;
  const stmt = db.prepare(`
    INSERT INTO items (barcode, name, location_id, category_id, container_details, quantity, reorder_threshold, is_ignored_grocery, image_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  try {
    const info = stmt.run(barcode, name, location_id, category_id, container_details, quantity || 0, reorder_threshold || 0, is_ignored_grocery || 0, image_path);
    const newItem = getItem.get(info.lastInsertRowid);
    broadcastUpdate('add', newItem);
    res.status(201).json(newItem);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/items/:id
app.put('/api/items/:id', (req, res) => {
  const { barcode, name, location_id, category_id, container_details, quantity, reorder_threshold, is_ignored_grocery, image_path } = req.body;
  const stmt = db.prepare(`
    UPDATE items
    SET barcode = ?, name = ?, location_id = ?, category_id = ?, container_details = ?, quantity = ?, reorder_threshold = ?, is_ignored_grocery = ?, image_path = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  try {
    stmt.run(barcode, name, location_id, category_id, container_details, quantity, reorder_threshold, is_ignored_grocery, image_path, req.params.id);
    const updatedItem = getItem.get(req.params.id);
    broadcastUpdate('update', updatedItem);
    res.json(updatedItem);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/items/:id/quantity
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

// PATCH /api/items/:id/ignore-grocery
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

// DELETE /api/items/:id
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

// POST /api/upload-image
app.post('/api/upload-image', upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image uploaded' });
  }
  const imagePath = `/uploads/${req.file.filename}`;
  res.json({ image_path: imagePath });
});

// POST /api/parse-label-llm
app.post('/api/parse-label-llm', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image uploaded' });
  }

  const llmApiUrl = process.env.LLM_API_URL || 'http://192.168.0.10:11434/v1/chat/completions';
  const llmModel = process.env.LLM_MODEL || 'llava';
  
  try {
    const imageBuffer = fs.readFileSync(req.file.path);
    const base64Image = imageBuffer.toString('base64');
    const mimeType = req.file.mimetype;

    const payload = {
      model: llmModel,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Analyze this product label. Extract the name, category, and container_details (size, weight, or container type). Output strictly as JSON." },
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64Image}` } }
          ]
        }
      ],
      response_format: { type: "json_object" }
    };

    const response = await fetch(llmApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`HTTP error status: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices[0].message.content;
    
    res.json(JSON.parse(content));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to parse image with LLM: ' + err.message });
  }
});

// Start Server
const PORT = process.env.PORT || 2626;
server.listen(PORT, () => {
  console.log(`Terrible Butler server listening on port ${PORT}`);
});

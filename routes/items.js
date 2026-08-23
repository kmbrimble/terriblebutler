const Fuse = require('fuse.js');
const { findMatch } = require('../item-matching');
const {
  TOTAL_QUANTITY_SQL,
  LOCATIONS_BREAKDOWN_SQL,
  parseItemLocations,
  cleanText,
  finiteNumber,
  normaliseBarcode,
  sendMutationError,
} = require('../lib/domain-helpers');

function registerItemRoutes(app, { db, broadcastUpdate, getItem, barcodeBelongsToAnotherItem, validForeignId, recalculateItemPrices, resolveTargetLocation, upsertItemLocationQuantity }) {
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
}

module.exports = { registerItemRoutes };

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

function sendMutationError(res, err) {
  const status = /already assigned/i.test(err.message) ? 409 : 400;
  return res.status(status).json({ error: err.message });
}

function checkDuplicateBarcodes(db) {
  const duplicateBarcodes = db.prepare(`
    SELECT barcode, COUNT(*) AS count FROM items
    WHERE barcode IS NOT NULL AND barcode <> ''
    GROUP BY barcode HAVING COUNT(*) > 1
  `).all();
  if (duplicateBarcodes.length) {
    console.warn(`[Startup] ${duplicateBarcodes.length} duplicate barcode value(s) already exist. Resolve these before enforcing a database-level unique index.`);
  }
}

function createDomainHelpers(db) {
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

  return {
    getItem,
    barcodeBelongsToAnotherItem,
    validForeignId,
    recalculateItemPrices,
    resolveTargetLocation,
    upsertItemLocationQuantity,
  };
}

module.exports = {
  TOTAL_QUANTITY_SQL,
  LOCATIONS_BREAKDOWN_SQL,
  parseItemLocations,
  parseIntOrNull,
  cleanText,
  finiteNumber,
  normaliseBarcode,
  sendMutationError,
  createDomainHelpers,
  checkDuplicateBarcodes,
};

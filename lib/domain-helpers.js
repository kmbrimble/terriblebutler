const crypto = require('crypto');
const { withSignedImage } = require('./uploads');
const { QUANTITY_MAX } = require('../db-migrations');

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
  // Every item response and broadcast payload passes through here, so this is the one place
  // the stored image identifier is turned into a signed, expiring URL.
  return withSignedImage(row);
}

// The only errors whose message may reach the client: deliberate input-validation failures.
// Anything else thrown in a mutation (SQLite, library or logic errors) is unexpected and goes
// through sendServerError, so its text never leaves the server.
class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ValidationError';
    this.status = status;
  }
}

// Free text is a string or absent (undefined/null read as empty). Arrays, objects, numbers and
// booleans are errors, never coerced ("x", "[object Object]"). Control characters (NUL, newlines,
// escapes, C1) become spaces, so one stored value can never carry a line break into a log line,
// a prompt or a header.
const CONTROL_CHARACTERS = /\p{Cc}/gu;
function cleanText(value, { required = false, max = 500 } = {}) {
  if (value !== undefined && value !== null && typeof value !== 'string') throw new ValidationError('A text value must be text');
  const text = (value ?? '').replace(CONTROL_CHARACTERS, ' ').trim();
  if (required && !text) throw new ValidationError('A required text value is missing');
  if (text.length > max) throw new ValidationError(`Text exceeds the ${max} character limit`);
  return text;
}

// QUANTITY_MAX (largest stock quantity accepted anywhere: item create/adjust, invoice lines,
// and the running total of a location) lives in db-migrations.js beside the triggers that
// enforce it in the database. Far beyond any household need, but small enough that sums stay
// exact in a REAL column.
// Largest price for one unit, in dollars, and for one invoice line's total.
const PRICE_MAX = 100000;
const LINE_TOTAL_MAX = 10000000;

// Unambiguous alternatives (digits, then an optional fraction; or a bare fraction): a pattern such as
// \d+\.?\d* can backtrack quadratically on a long digit string that ends in a non-digit. The
// length check keeps even a linear scan off megabyte strings.
const PLAIN_DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const NUMBER_TEXT_MAX = 64;

// The one rule for numeric input. A value must be a number (or numeric string) within
// [min, max]; booleans, arrays and objects are not numbers. A missing value (undefined, null,
// '' or whitespace) is an error ("<name> is required") unless the caller says what a missing
// value means: allowNull (the field is nullable) or defaultValue (the field is optional with
// that explicit default). Nothing is ever silently read as 0.
function finiteNumber(value, { name = 'Value', min = 0, max = Infinity, allowNull = false, defaultValue } = {}) {
  const blank = value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
  if (blank) {
    if (allowNull) return null;
    if (defaultValue !== undefined) return defaultValue;
    throw new ValidationError(`${name} is required`);
  }
  // Plain decimals only: Number() would also accept "0x10" (16), "1e3", "0b1" and "Infinity".
  const plain = typeof value === 'number' || (typeof value === 'string' && value.length <= NUMBER_TEXT_MAX && PLAIN_DECIMAL.test(value.trim()));
  const number = plain ? Number(value) : NaN;
  if (!Number.isFinite(number) || number < min) throw new ValidationError(`${name} must be a finite number not less than ${min}`);
  if (number > max) throw new ValidationError(`${name} must not be greater than ${max}`);
  return number;
}

const EARLIEST_PURCHASE_DATE = '2000-01-01';

// A purchase date is stored as price_history.recorded_at, which the history list and the
// "last price" lookup sort on, so it must be a real calendar date as YYYY-MM-DD (what
// <input type="date"> sends): not 2026-02-30, not free text, not before 2000, not in the future.
// Blank means "no date" (the row gets the current timestamp). Returns 'YYYY-MM-DD 00:00:00'. `now` is injectable for tests.
// ponytail: "future" is judged against tomorrow's UTC date, so a client up to 14 h ahead of UTC
// can still enter its own today; one day of slack is the ceiling on what slips through.
function cleanPurchaseDate(value, now = new Date()) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new ValidationError('Purchase date must be a date as YYYY-MM-DD');
  const text = value.trim();
  if (!text) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const real = match && new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
  if (!real || real.toISOString().slice(0, 10) !== text) throw new ValidationError('Purchase date must be a real date as YYYY-MM-DD');
  if (text < EARLIEST_PURCHASE_DATE) throw new ValidationError(`Purchase date must not be before ${EARLIEST_PURCHASE_DATE}`);
  const latest = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (text > latest) throw new ValidationError('Purchase date must not be in the future');
  // Stored in the column's own format (what CURRENT_TIMESTAMP writes) so rows sort consistently.
  return `${text} 00:00:00`;
}

// Boolean flags are exactly true/false/0/1 (JSON); "yes", "false" (a string), 2, [] and {} are
// errors rather than being read as truthy. Returns 0 or 1 for the INTEGER columns.
function strictFlag(value, name) {
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  throw new ValidationError(`${name} must be true, false, 1 or 0`);
}

function normaliseBarcode(value) {
  const barcode = cleanText(value, { max: 128 });
  return barcode || null;
}

// Unexpected failures: log the full error server-side under a correlation id and tell the
// client only that something went wrong plus that id (#61), so SQLite and library internals
// never reach the response. Deliberate 4xx validation messages do not come through here.
function sendServerError(res, err, context) {
  const id = crypto.randomUUID();
  console.error('[Error %s] %s:', id, context, err);
  return res.status(500).json({ error: `${context}. Reference: ${id.slice(0, 8)}`, correlation_id: id });
}

// Deliberate validation failures carry their own message and status; anything else is a 500.
function sendMutationError(res, err, context = 'Failed to save changes') {
  if (err instanceof ValidationError) return res.status(err.status).json({ error: err.message });
  return sendServerError(res, err, context);
}

// Category and location names are interpolated into every label/invoice LLM prompt, so they
// are bounded here rather than left to the 1 MB body limit.
const NAME_MAX_LENGTH = 100;
// ...and so is how many there can be: every label scan and every invoice classification batch sends
// the whole list, so the prompt must have a ceiling. Far above any household's real need.
const NAME_LIST_MAX = 500;

function cleanName(value) {
  if (typeof value !== 'string') throw new ValidationError('Name must be text');
  const name = cleanText(value, { max: NAME_MAX_LENGTH });
  if (!name) throw new ValidationError('Name is required');
  return name;
}

// Write failures on the name-keyed tables: a duplicate name is the caller's mistake (409);
// anything else is ours.
function sendNameWriteError(res, err, label) {
  if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    return res.status(409).json({ error: `A ${label.toLowerCase()} with that name already exists` });
  }
  return sendServerError(res, err, `Failed to save ${label.toLowerCase()}`);
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
    if (value === '' || value === undefined || value === null) return null;
    // "1abc", "1.9" and "1e2" must not quietly resolve to row 1.
    const id = /^[1-9]\d{0,15}$/.test(String(value).trim()) ? Number(String(value).trim()) : NaN;
    if (!Number.isSafeInteger(id)) throw new ValidationError(`${fieldName} is not a valid id`);
    if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)) throw new ValidationError(`${fieldName} does not exist`);
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
      throw new ValidationError('This item is stocked in more than one location — choose which one first');
    }
    if (rawLocationId === null || rawLocationId === '') return null;
    return validForeignId('locations', rawLocationId, 'Location');
  }

  function upsertItemLocationQuantity(id, locationId, action, amount) {
    const existing = locationId === null
      ? db.prepare('SELECT id, quantity FROM item_locations WHERE item_id = ? AND location_id IS NULL').get(id)
      : db.prepare('SELECT id, quantity FROM item_locations WHERE item_id = ? AND location_id = ?').get(id, locationId);
    if (action === 'add') {
      // A location's running total is capped like a single entry; the database triggers
      // (QUANTITY_GUARD_SQL) enforce the same ceiling for any other writer.
      if ((existing ? existing.quantity : 0) + amount > QUANTITY_MAX) {
        throw new ValidationError(`That would take this location above the maximum quantity of ${QUANTITY_MAX.toLocaleString('en-AU')}`);
      }
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
      if (amount > QUANTITY_MAX) throw new ValidationError(`Quantity must not be greater than ${QUANTITY_MAX.toLocaleString('en-AU')}`);
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
  ValidationError,
  QUANTITY_MAX,
  PRICE_MAX,
  LINE_TOTAL_MAX,
  TOTAL_QUANTITY_SQL,
  LOCATIONS_BREAKDOWN_SQL,
  parseItemLocations,
  cleanText,
  finiteNumber,
  cleanPurchaseDate,
  strictFlag,
  normaliseBarcode,
  sendMutationError,
  sendServerError,
  cleanName,
  NAME_LIST_MAX,
  sendNameWriteError,
  createDomainHelpers,
  checkDuplicateBarcodes,
};

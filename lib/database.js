const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { ensurePrivateDir, makePrivate } = require('./private-fs');
const { runMigrations, migrations, QUANTITY_GUARD_SQL, INVOICE_DEDUPE_INDEX_SQL, ITEM_LOCATIONS_LOOKUP_INDEX_SQL } = require('../db-migrations');

// Opens the DB, applies schema/migrations/seed data, and returns the ready connection.
// DB_PATH must be resolved and the DB opened at module-load time (test/setup.js sets
// process.env.DB_PATH before requiring server.js and relies on that ordering).
function openDatabase() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'inventory.db');
  // Only the directory the database actually lives in: a DB_PATH elsewhere must not also leave
  // an empty <repo>/data behind.
  ensurePrivateDir(path.dirname(dbPath));
  const isFreshDb = !fs.existsSync(dbPath);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

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
      dedupe_key TEXT,
      status TEXT NOT NULL DEFAULT 'in_progress',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS device_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT NOT NULL UNIQUE,
      device_label TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      revoked INTEGER NOT NULL DEFAULT 0,
      issued_by_jti TEXT
    );
    CREATE TABLE IF NOT EXISTS auth_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      token_epoch INTEGER NOT NULL DEFAULT 1,
      credential_fingerprint TEXT
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
      final_name TEXT,
      final_container_details TEXT,
      barcode_scanned TEXT,
      qty_confirmed REAL,
      category_cleared INTEGER NOT NULL DEFAULT 0,
      location_cleared INTEGER NOT NULL DEFAULT 0,
      line_status TEXT NOT NULL DEFAULT 'pending',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS invoice_line_match_memory (
      raw_name_key TEXT PRIMARY KEY,
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  runMigrations(db, migrations, isFreshDb);
  db.exec(QUANTITY_GUARD_SQL); // after migrations: migration 1's backfill must not be blocked by legacy rows
  db.exec(INVOICE_DEDUPE_INDEX_SQL);
  db.exec(ITEM_LOCATIONS_LOOKUP_INDEX_SQL);

  const insertLocation = db.prepare('INSERT OR IGNORE INTO locations (name) VALUES (?)');
  const defaultLocations = ['Chest Freezer', 'Fridge Freezer', 'Fridge', 'Pantry', 'HP Cupboard'];
  defaultLocations.forEach(loc => {
    insertLocation.run(loc);
  });

  // The database and its WAL/shm sidecars are owner-only (they exist by now: journal_mode=WAL and the
  // schema work above created them), whatever their previous modes were.
  for (const suffix of ['', '-wal', '-shm']) makePrivate(dbPath + suffix);

  return { db, dbPath };
}

module.exports = { openDatabase };

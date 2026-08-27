// Migrations runner using SQLite's native PRAGMA user_version — no migrations table needed.
// Add future ad-hoc schema changes here instead of hand-editing the live DB.
function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

function hasTable(db, table) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

// On a fresh DB, server.js's CREATE TABLE already reflects the latest schema, so nothing
// needs replaying — just mark it caught up. On an existing DB, run pending migrations in
// order, each in its own transaction. Migrations should guard themselves with hasColumn()
// before altering, so they stay safe to apply to an already-populated database.
function runMigrations(db, migrations, isFreshDb) {
  if (isFreshDb) {
    db.pragma(`user_version = ${migrations.length}`);
    return;
  }
  const currentVersion = db.pragma('user_version', { simple: true });
  for (let i = currentVersion; i < migrations.length; i++) {
    db.transaction(() => migrations[i](db))();
    db.pragma(`user_version = ${i + 1}`);
  }
}

// Append new migrations here, in order. Never edit or remove a migration once it has
// shipped — add a new one instead.
const migrations = [
  // #1: item_locations (multi-location stock). The table + indexes also live in
  // server.js's base CREATE TABLE block for fresh installs; this migration creates them
  // for an existing DB and backfills one row per item from its current
  // location_id/quantity. The WHERE NOT IN guard makes the backfill safe to re-run.
  (db) => {
    db.exec(`
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
    db.exec(`
      INSERT INTO item_locations (item_id, location_id, quantity)
      SELECT id, location_id, quantity FROM items
      WHERE id NOT IN (SELECT item_id FROM item_locations)
    `);
  },
  // #2: item_locations.is_open — per-location "there's an open pack here" flag. Also in
  // server.js's base CREATE TABLE block for fresh installs.
  (db) => {
    if (!hasColumn(db, 'item_locations', 'is_open')) {
      db.exec('ALTER TABLE item_locations ADD COLUMN is_open INTEGER NOT NULL DEFAULT 0');
    }
  },
  // #3: invoice_import_lines.final_name / final_container_details — editable overrides of
  // raw_name/container during import review (fixes #40). Also in server.js's base CREATE
  // TABLE block for fresh installs. Guarded by hasTable() too, not just hasColumn(): some
  // migration-test fixtures (and any real DB older than the staged-import feature) simulate
  // a state where invoice_import_lines doesn't exist yet at all.
  (db) => {
    if (!hasTable(db, 'invoice_import_lines')) return;
    if (!hasColumn(db, 'invoice_import_lines', 'final_name')) {
      db.exec('ALTER TABLE invoice_import_lines ADD COLUMN final_name TEXT');
    }
    if (!hasColumn(db, 'invoice_import_lines', 'final_container_details')) {
      db.exec('ALTER TABLE invoice_import_lines ADD COLUMN final_container_details TEXT');
    }
  },
  // #4: invoice_line_match_memory — learned raw invoice text -> item match, consulted before
  // the deterministic and LLM matching passes in POST /api/invoices/import. A brand-new table
  // (not an ALTER on an existing one), so CREATE TABLE IF NOT EXISTS alone is enough to be
  // idempotent — no hasTable/hasColumn guard needed. Also in server.js's base CREATE TABLE
  // block for fresh installs.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS invoice_line_match_memory (
        raw_name_key TEXT PRIMARY KEY,
        item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  },
];

module.exports = { runMigrations, hasColumn, hasTable, migrations };

const { numberKey } = require('./lib/invoice-dedupe');

// Migrations runner using SQLite's native PRAGMA user_version — no migrations table needed.
// Add future ad-hoc schema changes here instead of hand-editing the live DB.
function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

function hasTable(db, table) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

// SQLite cannot add a CHECK constraint to an existing table without rebuilding it, so the
// non-negative stock rule is enforced with triggers (identical on fresh and migrated DBs).
// UPDATE OF quantity means writes that leave quantity alone (e.g. is_open) are never blocked
// by a legacy negative row.
// Largest quantity one item_locations row may hold (also the cap on any single quantity input;
// lib/domain-helpers.js re-exports it). Baked into the triggers below, which are created once
// (IF NOT EXISTS): changing it needs a new migration that drops and recreates them.
const QUANTITY_MAX = 1000000;

const QUANTITY_GUARD_SQL = `
  CREATE TRIGGER IF NOT EXISTS item_locations_quantity_nonneg_insert
  BEFORE INSERT ON item_locations WHEN NEW.quantity < 0
  BEGIN SELECT RAISE(ABORT, 'item_locations.quantity must not be negative'); END;
  CREATE TRIGGER IF NOT EXISTS item_locations_quantity_nonneg_update
  BEFORE UPDATE OF quantity ON item_locations WHEN NEW.quantity < 0
  BEGIN SELECT RAISE(ABORT, 'item_locations.quantity must not be negative'); END;
  CREATE TRIGGER IF NOT EXISTS item_locations_quantity_max_insert
  BEFORE INSERT ON item_locations WHEN NEW.quantity > ${QUANTITY_MAX}
  BEGIN SELECT RAISE(ABORT, 'item_locations.quantity must not exceed ${QUANTITY_MAX}'); END;
  CREATE TRIGGER IF NOT EXISTS item_locations_quantity_max_update
  BEFORE UPDATE OF quantity ON item_locations WHEN NEW.quantity > ${QUANTITY_MAX} AND NEW.quantity > OLD.quantity
  BEGIN SELECT RAISE(ABORT, 'item_locations.quantity must not exceed ${QUANTITY_MAX}'); END;
`;

// Duplicate-invoice enforcement (#44). Run after the migrations on every start: on an existing
// DB the column only exists once migration 6 has run, so the base CREATE TABLE block cannot
// create it.
const INVOICE_DEDUPE_INDEX_SQL =
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_imports_dedupe_key ON invoice_imports(dedupe_key)';

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
  // #5: session revocation (#49/#54). auth_state holds the token epoch + credential
  // fingerprint; device_tokens.issued_by_jti records which household JWT minted each
  // device token. Both also live in lib/database.js's base CREATE TABLE block for fresh
  // installs. Existing device tokens get a NULL issued_by_jti (provenance unknown).
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS auth_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        token_epoch INTEGER NOT NULL DEFAULT 1,
        credential_fingerprint TEXT
      );
    `);
    if (hasTable(db, 'device_tokens') && !hasColumn(db, 'device_tokens', 'issued_by_jti')) {
      db.exec('ALTER TABLE device_tokens ADD COLUMN issued_by_jti TEXT');
    }
  },
  // #6: invoice integrity.
  //  - invoice_imports.dedupe_key + UNIQUE index (#44): one import per invoice. Existing rows
  //    with an invoice number are keyed retailer|no:<number>; where several already share one
  //    key, the committed row (else the oldest) keeps it and the rest stay NULL (NULLs never
  //    collide), so history is untouched and the index can always be built. Rows without a
  //    number stay NULL — the hash fallback applies to future imports only.
  //  - invoice_import_lines.category_cleared / location_cleared (#46): an explicitly cleared
  //    category/location is distinct from "not overridden", so commit no longer reverts it to
  //    the suggestion. Existing rows default to 0 (not cleared), which is their old behaviour.
  //  - item_locations non-negative quantity triggers (#42), see QUANTITY_GUARD_SQL.
  // All also live in lib/database.js's base CREATE TABLE block for fresh installs.
  (db) => {
    if (hasTable(db, 'invoice_imports')) {
      if (!hasColumn(db, 'invoice_imports', 'dedupe_key')) {
        db.exec('ALTER TABLE invoice_imports ADD COLUMN dedupe_key TEXT');
        const rows = db.prepare(`
          SELECT id, retailer, invoice_number FROM invoice_imports
          ORDER BY (status = 'committed') DESC, id ASC
        `).all();
        const setKey = db.prepare('UPDATE invoice_imports SET dedupe_key = ? WHERE id = ?');
        const seen = new Set();
        for (const row of rows) {
          const key = numberKey(row.retailer, row.invoice_number);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          setKey.run(key, row.id);
        }
      }
      db.exec(INVOICE_DEDUPE_INDEX_SQL);
    }
    if (hasTable(db, 'invoice_import_lines')) {
      if (!hasColumn(db, 'invoice_import_lines', 'category_cleared')) {
        db.exec('ALTER TABLE invoice_import_lines ADD COLUMN category_cleared INTEGER NOT NULL DEFAULT 0');
      }
      if (!hasColumn(db, 'invoice_import_lines', 'location_cleared')) {
        db.exec('ALTER TABLE invoice_import_lines ADD COLUMN location_cleared INTEGER NOT NULL DEFAULT 0');
      }
    }
    if (hasTable(db, 'item_locations')) db.exec(QUANTITY_GUARD_SQL);
  },
];

module.exports = { QUANTITY_MAX, runMigrations, hasColumn, hasTable, migrations, QUANTITY_GUARD_SQL, INVOICE_DEDUPE_INDEX_SQL };

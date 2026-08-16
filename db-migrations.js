// Migrations runner using SQLite's native PRAGMA user_version — no migrations table needed.
// Add future ad-hoc schema changes here instead of hand-editing the live DB.
function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
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
];

module.exports = { runMigrations, hasColumn, migrations };

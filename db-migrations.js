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
const migrations = [];

module.exports = { runMigrations, hasColumn, migrations };

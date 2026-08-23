import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { migrations, runMigrations } from '../db-migrations.js';

// Builds a DB shaped like the pre-#1 schema: items has location_id/quantity directly,
// item_locations doesn't exist yet, user_version is 0 (an "existing live DB" scenario).
function legacyDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE locations (id INTEGER PRIMARY KEY, name TEXT UNIQUE);
    CREATE TABLE items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      barcode TEXT,
      name TEXT NOT NULL,
      location_id INTEGER,
      quantity REAL DEFAULT 0,
      reorder_threshold REAL DEFAULT 0
    );
  `);
  return db;
}

describe('item_locations migration', () => {
  it('backfills one item_locations row per existing item, preserving its location and quantity', () => {
    const db = legacyDb();
    db.prepare("INSERT INTO locations (id, name) VALUES (1, 'Pantry')").run();
    db.prepare("INSERT INTO items (id, name, location_id, quantity) VALUES (1, 'Beans', 1, 5)").run();
    db.prepare("INSERT INTO items (id, name, location_id, quantity) VALUES (2, 'Unassigned Item', NULL, 3)").run();

    expect(migrations.length).toBeGreaterThan(0);
    runMigrations(db, migrations, false);

    const rows = db.prepare('SELECT * FROM item_locations ORDER BY item_id').all();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ item_id: 1, location_id: 1, quantity: 5 });
    expect(rows[1]).toMatchObject({ item_id: 2, location_id: null, quantity: 3 });
  });

  it('is safe to run twice — does not duplicate rows for items already backfilled', () => {
    const db = legacyDb();
    db.prepare("INSERT INTO items (id, name, location_id, quantity) VALUES (1, 'Beans', NULL, 5)").run();

    runMigrations(db, migrations, false);
    // Simulate a second application attempt (e.g. re-running a migration defensively).
    for (const migration of migrations) migration(db);

    const rows = db.prepare('SELECT * FROM item_locations WHERE item_id = 1').all();
    expect(rows).toHaveLength(1);
  });

  it('a fresh database (server.js base schema) needs no backfill — item_locations starts empty', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE locations (id INTEGER PRIMARY KEY, name TEXT UNIQUE);
      CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, location_id INTEGER, quantity REAL DEFAULT 0, reorder_threshold REAL DEFAULT 0);
      CREATE TABLE item_locations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL,
        location_id INTEGER,
        quantity REAL NOT NULL DEFAULT 0,
        is_open INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE,
        FOREIGN KEY(location_id) REFERENCES locations(id)
      );
      CREATE UNIQUE INDEX idx_item_locations_unique ON item_locations(item_id, location_id) WHERE location_id IS NOT NULL;
      CREATE UNIQUE INDEX idx_item_locations_unique_null ON item_locations(item_id) WHERE location_id IS NULL;
    `);
    runMigrations(db, migrations, true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM item_locations').get().n).toBe(0);
    expect(db.pragma('user_version', { simple: true })).toBe(migrations.length);
  });
});

describe('item_locations.is_open migration', () => {
  // Simulates a DB already at migration #1 (item_locations exists, no is_open column yet) —
  // the "existing live DB, mid-history" scenario migration #2 has to run safely against.
  function dbAtMigration1() {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE locations (id INTEGER PRIMARY KEY, name TEXT UNIQUE);
      CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, location_id INTEGER, quantity REAL DEFAULT 0, reorder_threshold REAL DEFAULT 0);
      CREATE TABLE item_locations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL,
        location_id INTEGER,
        quantity REAL NOT NULL DEFAULT 0,
        FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE,
        FOREIGN KEY(location_id) REFERENCES locations(id)
      );
      CREATE UNIQUE INDEX idx_item_locations_unique ON item_locations(item_id, location_id) WHERE location_id IS NOT NULL;
      CREATE UNIQUE INDEX idx_item_locations_unique_null ON item_locations(item_id) WHERE location_id IS NULL;
    `);
    db.prepare("INSERT INTO items (id, name, quantity) VALUES (1, 'Beans', 5)").run();
    db.prepare("INSERT INTO item_locations (item_id, location_id, quantity) VALUES (1, NULL, 5)").run();
    db.pragma('user_version = 1');
    return db;
  }

  it('adds is_open defaulted to 0, preserving existing rows', () => {
    const db = dbAtMigration1();
    runMigrations(db, migrations, false);

    const row = db.prepare('SELECT * FROM item_locations WHERE item_id = 1').get();
    expect(row.is_open).toBe(0);
    expect(row.quantity).toBe(5);
    expect(db.pragma('user_version', { simple: true })).toBe(migrations.length);
  });

  it('is safe to run twice — does not error on an already-migrated DB', () => {
    const db = dbAtMigration1();
    runMigrations(db, migrations, false);
    for (const migration of migrations) migration(db);

    const row = db.prepare('SELECT * FROM item_locations WHERE item_id = 1').get();
    expect(row.is_open).toBe(0);
  });
});

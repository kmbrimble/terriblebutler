import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { runMigrations, hasColumn, migrations } from '../db-migrations.js';
import { invoiceDedupeKey } from '../lib/invoice-dedupe.js';

// A populated pre-#6 database: invoice tables without dedupe/cleared columns, item_locations
// without the quantity guard, including duplicate invoices that predate the UNIQUE index.
function legacyDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE item_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL, location_id INTEGER,
      quantity REAL NOT NULL DEFAULT 0, is_open INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE invoice_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT, retailer TEXT NOT NULL, invoice_number TEXT, invoice_date TEXT,
      source_filename TEXT, status TEXT NOT NULL DEFAULT 'in_progress', created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE invoice_import_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT, import_id INTEGER NOT NULL, raw_name TEXT NOT NULL,
      final_category_id INTEGER, line_status TEXT NOT NULL DEFAULT 'pending'
    );
    INSERT INTO items (id, name) VALUES (1, 'Milk');
    INSERT INTO item_locations (item_id, location_id, quantity) VALUES (1, NULL, -3);
    INSERT INTO invoice_imports (retailer, invoice_number, status) VALUES
      ('woolworths', '100', 'in_progress'),   -- 1: older duplicate of 2
      ('woolworths', ' 100 ', 'committed'),   -- 2: committed, so it keeps the key
      ('coles', '100', 'in_progress'),        -- 3: same number, different retailer
      ('coles', NULL, 'in_progress'),         -- 4: no number
      ('coles', '', 'in_progress');           -- 5: blank number
    INSERT INTO invoice_import_lines (import_id, raw_name) VALUES (1, 'Milk 2L');
  `);
  db.pragma('user_version = 5');
  return db;
}

describe('invoice integrity migration (#42, #44, #46)', () => {
  it('is migration 6', () => {
    expect(migrations.length).toBe(6);
  });

  it('keys existing numbered invoices, de-keying older duplicates (committed wins), keeping every row', () => {
    const db = legacyDb();
    runMigrations(db, migrations, false);

    expect(db.pragma('user_version', { simple: true })).toBe(6);
    const keys = db.prepare('SELECT id, dedupe_key FROM invoice_imports ORDER BY id').all().map((r) => r.dedupe_key);
    expect(keys).toEqual([null, 'woolworths|no:100', 'coles|no:100', null, null]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM invoice_imports').get().n).toBe(5);
    expect(() => db.prepare("INSERT INTO invoice_imports (retailer, invoice_number, dedupe_key) VALUES ('woolworths', '100', 'woolworths|no:100')").run())
      .toThrow(/UNIQUE/);
  });

  it('adds not-cleared flags that default to 0 on existing lines', () => {
    const db = legacyDb();
    runMigrations(db, migrations, false);
    const line = db.prepare('SELECT * FROM invoice_import_lines').get();
    expect(line.category_cleared).toBe(0);
    expect(line.location_cleared).toBe(0);
    expect(line.raw_name).toBe('Milk 2L');
  });

  it('rejects negative stock on insert and update, but not writes that leave quantity alone', () => {
    const db = legacyDb();
    runMigrations(db, migrations, false);
    expect(() => db.prepare('INSERT INTO item_locations (item_id, location_id, quantity) VALUES (1, 5, -1)').run()).toThrow(/negative/);
    expect(() => db.prepare('UPDATE item_locations SET quantity = -2 WHERE location_id IS NULL').run()).toThrow(/negative/);
    // The legacy negative row can still be flagged open, and corrected upwards.
    expect(() => db.prepare('UPDATE item_locations SET is_open = 1 WHERE location_id IS NULL').run()).not.toThrow();
    db.prepare('UPDATE item_locations SET quantity = quantity + 5 WHERE location_id IS NULL').run();
    expect(db.prepare('SELECT quantity FROM item_locations').get().quantity).toBe(2);
  });

  it('is idempotent', () => {
    const db = legacyDb();
    runMigrations(db, migrations, false);
    db.pragma('user_version = 5');
    expect(() => runMigrations(db, migrations, false)).not.toThrow();
    expect(hasColumn(db, 'invoice_imports', 'dedupe_key')).toBe(true);
  });

  it('is a no-op on databases that predate the invoice and stock tables', () => {
    const db = new Database(':memory:');
    db.pragma('user_version = 5');
    expect(() => runMigrations(db, migrations, false)).not.toThrow();
  });
});

describe('invoiceDedupeKey', () => {
  it('uses retailer + normalised number when there is one', () => {
    expect(invoiceDedupeKey('Woolworths', ' ab  12 ', 'text')).toBe('woolworths|no:ab 12');
  });
  it('falls back to a whitespace-insensitive content hash when there is no number', () => {
    const a = invoiceDedupeKey('coles', null, 'Milk  2L\n$3.00');
    expect(a).toMatch(/^coles\|sha256:[0-9a-f]{64}$/);
    expect(invoiceDedupeKey('coles', '', 'Milk 2L $3.00')).toBe(a);
    expect(invoiceDedupeKey('coles', null, 'Milk 2L $4.00')).not.toBe(a);
  });
});

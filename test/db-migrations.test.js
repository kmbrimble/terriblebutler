import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { runMigrations, hasColumn } from '../db-migrations.js';

function freshDb() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT)');
  return db;
}

describe('runMigrations', () => {
  it('on a fresh database, jumps straight to the top version without running any migration', () => {
    const db = freshDb();
    let ran = 0;
    const migrations = [
      () => { ran++; },
      () => { ran++; },
      () => { ran++; },
    ];

    runMigrations(db, migrations, true);

    expect(ran).toBe(0);
    expect(db.pragma('user_version', { simple: true })).toBe(3);
  });

  it('on an existing database at version 0, runs every pending migration once, in order', () => {
    const db = freshDb();
    const order = [];
    const migrations = [
      () => order.push('one'),
      () => order.push('two'),
    ];

    runMigrations(db, migrations, false);

    expect(order).toEqual(['one', 'two']);
    expect(db.pragma('user_version', { simple: true })).toBe(2);
  });

  it('does not replay already-applied migrations on a second call (idempotent across restarts)', () => {
    const db = freshDb();
    let ran = 0;
    const migrations = [() => { ran++; }, () => { ran++; }];

    runMigrations(db, migrations, false);
    expect(ran).toBe(2);

    runMigrations(db, migrations, false);
    expect(ran).toBe(2);
  });

  it('only runs migrations added after the current version', () => {
    const db = freshDb();
    db.pragma('user_version = 1');
    const order = [];
    const migrations = [
      () => order.push('one'),
      () => order.push('two'),
      () => order.push('three'),
    ];

    runMigrations(db, migrations, false);

    expect(order).toEqual(['two', 'three']);
    expect(db.pragma('user_version', { simple: true })).toBe(3);
  });

  it('rolls back a migration that throws, and leaves the version unbumped', () => {
    const db = freshDb();
    const migrations = [
      (db) => db.exec("ALTER TABLE widgets ADD COLUMN size TEXT"),
      () => { throw new Error('boom'); },
    ];

    expect(() => runMigrations(db, migrations, false)).toThrow('boom');
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    expect(hasColumn(db, 'widgets', 'size')).toBe(true);
  });
});

describe('hasColumn', () => {
  it('returns true for a column that exists', () => {
    const db = freshDb();
    expect(hasColumn(db, 'widgets', 'name')).toBe(true);
  });

  it('returns false for a column that does not exist', () => {
    const db = freshDb();
    expect(hasColumn(db, 'widgets', 'nonexistent')).toBe(false);
  });
});

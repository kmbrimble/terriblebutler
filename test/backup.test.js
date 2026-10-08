import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { runBackup, pruneOldBackups } from '../backup.js';

let tmpDir;
let dbPath;
let backupDir;
let db;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `butler-backup-test-${crypto.randomBytes(4).toString('hex')}-`));
  dbPath = path.join(tmpDir, 'inventory.db');
  backupDir = path.join(tmpDir, 'backups');
  db = new Database(dbPath);
  db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO items (name) VALUES (?)').run('Test Item');
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('runBackup', () => {
  it('writes a restorable, integrity-checked copy of the database', async () => {
    const dest = await runBackup(db, backupDir);
    expect(fs.existsSync(dest)).toBe(true);

    const copy = new Database(dest, { readonly: true });
    expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(copy.prepare('SELECT name FROM items').get().name).toBe('Test Item');
    copy.close();
  });

  it('names the backup file with a UTC timestamp to the millisecond', async () => {
    const dest = await runBackup(db, backupDir);
    expect(path.basename(dest)).toMatch(/^inventory-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.db$/);
    expect(path.basename(dest).slice(10, 20)).toBe(new Date().toISOString().slice(0, 10));
  });

  it('keeps every backup taken on the same day, each with its own contents', async () => {
    const first = await runBackup(db, backupDir);
    db.prepare('INSERT INTO items (name) VALUES (?)').run('Second Item');
    const second = await runBackup(db, backupDir);

    expect(second).not.toBe(first);
    expect(fs.readdirSync(backupDir).filter((f) => f.startsWith('inventory-'))).toHaveLength(2);
    const count = (file) => {
      const copy = new Database(file, { readonly: true });
      const n = copy.prepare('SELECT COUNT(*) AS n FROM items').get().n;
      copy.close();
      return n;
    };
    expect(count(first)).toBe(1);
    expect(count(second)).toBe(2);
  });

  it('never overwrites, even when two backups land in the same millisecond', async () => {
    const frozen = new Date('2026-10-09T06:37:12.123Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(frozen);
    try {
      const a = await runBackup(db, backupDir);
      const b = await runBackup(db, backupDir);
      expect(path.basename(a)).toBe('inventory-2026-10-09T06-37-12-123Z.db');
      expect(path.basename(b)).toBe('inventory-2026-10-09T06-37-12-123Z-1.db');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('pruneOldBackups', () => {
  it('deletes backup files older than the max age and keeps recent ones', () => {
    fs.mkdirSync(backupDir, { recursive: true });
    const oldFile = path.join(backupDir, 'inventory-2020-01-01.db');
    const recentFile = path.join(backupDir, 'inventory-2020-01-20.db');
    fs.writeFileSync(oldFile, 'x');
    fs.writeFileSync(recentFile, 'x');

    const oldTime = Date.now() - 20 * 24 * 60 * 60 * 1000;
    const recentTime = Date.now() - 1 * 24 * 60 * 60 * 1000;
    fs.utimesSync(oldFile, oldTime / 1000, oldTime / 1000);
    fs.utimesSync(recentFile, recentTime / 1000, recentTime / 1000);

    pruneOldBackups(backupDir, 14);

    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(recentFile)).toBe(true);
  });

  it('prunes old backups in both the legacy date-only and the timestamped formats, keeping recent ones', () => {
    fs.mkdirSync(backupDir, { recursive: true });
    const names = {
      oldLegacy: 'inventory-2020-01-01.db',
      oldStamped: 'inventory-2020-01-01T02-00-00-000Z.db',
      oldCounter: 'inventory-2020-01-01T02-00-00-000Z-1.db',
      recentLegacy: 'inventory-2026-10-01.db',
      recentStamped: 'inventory-2026-10-09T02-00-00-000Z.db',
    };
    const age = (days) => (Date.now() - days * 24 * 60 * 60 * 1000) / 1000;
    for (const [key, name] of Object.entries(names)) {
      const file = path.join(backupDir, name);
      fs.writeFileSync(file, 'x');
      fs.utimesSync(file, age(key.startsWith('old') ? 30 : 1), age(key.startsWith('old') ? 30 : 1));
    }
    pruneOldBackups(backupDir, 14);
    expect(fs.readdirSync(backupDir).sort()).toEqual([names.recentLegacy, names.recentStamped].sort());
  });

  it('ignores files that do not match the backup naming pattern', () => {
    fs.mkdirSync(backupDir, { recursive: true });
    const oldTime = Date.now() - 100 * 24 * 60 * 60 * 1000;
    const unrelated = ['notes.txt', 'inventory-2020-01-01T02-00-00-000Z.db.bak', 'inventory-latest.db'].map((n) => path.join(backupDir, n));
    for (const f of unrelated) {
      fs.writeFileSync(f, 'x');
      fs.utimesSync(f, oldTime / 1000, oldTime / 1000);
    }

    pruneOldBackups(backupDir, 14);

    for (const f of unrelated) expect(fs.existsSync(f)).toBe(true);
  });

  it('is a no-op when the backup directory does not exist yet', () => {
    expect(() => pruneOldBackups(path.join(tmpDir, 'never-created'), 14)).not.toThrow();
  });
});

describe('pruneOldBackups failures', () => {
  it('logs and keeps pruning when an old backup cannot be removed', () => {
    fs.mkdirSync(backupDir, { recursive: true });
    const stuck = path.join(backupDir, 'inventory-2020-01-01.db');
    const removable = path.join(backupDir, 'inventory-2020-01-02.db');
    fs.mkdirSync(stuck); // unlinkSync on a directory fails
    fs.writeFileSync(removable, 'x');
    const old = (Date.now() - 40 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(stuck, old, old);
    fs.utimesSync(removable, old, old);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => pruneOldBackups(backupDir, 14)).not.toThrow();

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('inventory-2020-01-01.db'), expect.any(String));
    expect(fs.existsSync(removable)).toBe(false);
    errSpy.mockRestore();
  });
});

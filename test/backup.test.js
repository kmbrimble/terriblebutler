import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

  it('names the backup file with today\'s date', async () => {
    const dest = await runBackup(db, backupDir);
    const today = new Date().toISOString().slice(0, 10);
    expect(path.basename(dest)).toBe(`inventory-${today}.db`);
  });

  it('overwrites same-day backup on a second run rather than accumulating duplicates', async () => {
    await runBackup(db, backupDir);
    db.prepare('INSERT INTO items (name) VALUES (?)').run('Second Item');
    await runBackup(db, backupDir);

    const files = fs.readdirSync(backupDir).filter((f) => f.startsWith('inventory-'));
    expect(files).toHaveLength(1);

    const copy = new Database(path.join(backupDir, files[0]), { readonly: true });
    expect(copy.prepare('SELECT COUNT(*) AS n FROM items').get().n).toBe(2);
    copy.close();
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

  it('ignores files that do not match the backup naming pattern', () => {
    fs.mkdirSync(backupDir, { recursive: true });
    const unrelated = path.join(backupDir, 'notes.txt');
    fs.writeFileSync(unrelated, 'x');
    const oldTime = Date.now() - 100 * 24 * 60 * 60 * 1000;
    fs.utimesSync(unrelated, oldTime / 1000, oldTime / 1000);

    pruneOldBackups(backupDir, 14);

    expect(fs.existsSync(unrelated)).toBe(true);
  });

  it('is a no-op when the backup directory does not exist yet', () => {
    expect(() => pruneOldBackups(path.join(tmpDir, 'never-created'), 14)).not.toThrow();
  });
});

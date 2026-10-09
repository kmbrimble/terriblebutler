// The app creates its persistent files owner-only whatever umask it inherited (the entrypoint sets
// umask 077 and repairs existing contents; this is the app's own guarantee, so it holds when started directly).
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import './setup.js';
import { api } from './setup.js';
import pkg from '../server.js';

const nodeRequire = createRequire(import.meta.url);
const { openDatabase } = nodeRequire('../lib/database');
const { ensurePrivateDir, makePrivate } = nodeRequire('../lib/private-fs');
const { runBackup } = nodeRequire('../backup');
const uploads = nodeRequire('../lib/uploads');
const logger = nodeRequire('../logger');
const mode = (file) => fs.statSync(file).mode & 0o777;

let sandbox;
let previousUmask;
beforeAll(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-modes-'));
  previousUmask = process.umask(0); // the worst case: nothing is masked off
});
afterAll(() => {
  process.umask(previousUmask);
  fs.rmSync(sandbox, { recursive: true, force: true });
});
afterEach(() => vi.restoreAllMocks());

describe('with umask 000 (nothing masked)', () => {
  it('openDatabase creates the directory 0700 and the database, WAL and shm files 0600', () => {
    const dbFile = path.join(sandbox, 'data', 'nested', 'inventory.db');
    const saved = process.env.DB_PATH;
    process.env.DB_PATH = dbFile;
    try {
      const { db } = openDatabase();
      db.prepare("INSERT INTO locations (name) VALUES ('mode test')").run(); // makes sure the WAL has content
      expect(mode(path.dirname(dbFile))).toBe(0o700);
      expect(mode(path.join(sandbox, 'data'))).toBe(0o700); // parents it had to create too
      expect(mode(dbFile)).toBe(0o600);
      for (const suffix of ['-wal', '-shm']) if (fs.existsSync(dbFile + suffix)) expect(mode(dbFile + suffix)).toBe(0o600);
      expect(fs.existsSync(`${dbFile}-wal`)).toBe(true);
      db.close();
    } finally {
      process.env.DB_PATH = saved;
    }
  });

  it('openDatabase repairs an existing world-readable database file', () => {
    const dbFile = path.join(sandbox, 'old.db');
    const saved = process.env.DB_PATH;
    process.env.DB_PATH = dbFile;
    try {
      openDatabase().db.close();
      fs.chmodSync(dbFile, 0o644);
      openDatabase().db.close();
      expect(mode(dbFile)).toBe(0o600);
    } finally {
      process.env.DB_PATH = saved;
    }
  });

  it('never changes the mode of a directory that already exists (DB_PATH may be in /tmp or a shared mount)', () => {
    const shared = path.join(sandbox, 'shared');
    fs.mkdirSync(shared, { mode: 0o755 });
    fs.chmodSync(shared, 0o755);
    ensurePrivateDir(shared);
    expect(mode(shared)).toBe(0o755);
    const saved = process.env.DB_PATH;
    process.env.DB_PATH = path.join(shared, 'inventory.db');
    try {
      openDatabase().db.close();
      expect(mode(shared)).toBe(0o755);
      expect(mode(path.join(shared, 'inventory.db'))).toBe(0o600);
    } finally {
      process.env.DB_PATH = saved;
    }
  });

  it('a backup is a 0600 file in a 0700 directory', async () => {
    const dbFile = path.join(sandbox, 'for-backup.db');
    const saved = process.env.DB_PATH;
    process.env.DB_PATH = dbFile;
    try {
      const { db } = openDatabase();
      const dest = await runBackup(db, path.join(sandbox, 'backups'));
      expect(mode(path.join(sandbox, 'backups'))).toBe(0o700);
      expect(mode(dest)).toBe(0o600);
      db.close();
    } finally {
      process.env.DB_PATH = saved;
    }
  });

  it('a stored image is 0600', async () => {
    const sharp = nodeRequire('sharp');
    const source = path.join(sandbox, 'in.png');
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fa0' } }).png().toFile(source);
    const name = await uploads.storeUploadedImage(source);
    const stored = path.join(nodeRequire('../lib/config').UPLOADS_DIR, name);
    expect(mode(stored)).toBe(0o600);
  });

  it('an action log file is created 0600', async () => {
    await api(pkg.app).post('/api/locations').send({ name: `Log mode ${Math.random()}` });
    await logger.flush();
    expect(mode(logger.currentLogFile())).toBe(0o600);
  });
});

describe('makePrivate', () => {
  it('tolerates a missing file and reports (does not throw on) one it cannot change', () => {
    expect(() => makePrivate(path.join(sandbox, 'does-not-exist'))).not.toThrow();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(fs, 'chmodSync').mockImplementation(() => { throw Object.assign(new Error('not permitted'), { code: 'EPERM' }); });
    expect(() => makePrivate(path.join(sandbox, 'x'))).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});

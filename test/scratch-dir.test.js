import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import './setup.js';
import uploads from '../lib/uploads.js';

const { prepareScratchDir } = uploads;
let base;
beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-scratch-')); });
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

describe('prepareScratchDir', () => {
  it('creates an absent directory (and parents) with mode 0700 whatever the umask', () => {
    const old = process.umask(0o000);
    try {
      const dir = path.join(base, 'a', 'scratch');
      prepareScratchDir(dir);
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    } finally {
      process.umask(old);
    }
  });

  it('accepts an existing private directory owned by the runtime user', () => {
    const dir = path.join(base, 'ok');
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    expect(() => prepareScratchDir(dir)).not.toThrow();
  });

  it('refuses a symlink, even one pointing at a good directory', () => {
    const real = path.join(base, 'real');
    fs.mkdirSync(real, { mode: 0o700 });
    const link = path.join(base, 'link');
    fs.symlinkSync(real, link);
    expect(() => prepareScratchDir(link)).toThrow(/symbolic link/);
  });

  it('refuses a directory that is group/other accessible', () => {
    const dir = path.join(base, 'open');
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o755);
    expect(() => prepareScratchDir(dir)).toThrow(/mode 0700/);
  });

  it('refuses a directory owned by another user', () => {
    const dir = path.join(base, 'theirs');
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    expect(() => prepareScratchDir(dir, { uid: process.getuid() + 1 })).toThrow(/owned by/);
  });

  it('refuses a regular file', () => {
    const file = path.join(base, 'file');
    fs.writeFileSync(file, 'x');
    expect(() => prepareScratchDir(file)).toThrow(/not a directory/);
  });

  it('is what runs at startup: lib/uploads.js no longer calls a bare mkdirSync on the scratch dir', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../lib/uploads.js'), 'utf8');
    expect(src).toMatch(/^prepareScratchDir\(UPLOAD_TMP_DIR\);$/m);
    expect(src).not.toMatch(/mkdirSync\(UPLOAD_TMP_DIR/);
  });
});

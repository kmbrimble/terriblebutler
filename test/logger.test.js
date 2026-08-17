import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

let tmpDir;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `butler-logger-test-${crypto.randomBytes(4).toString('hex')}-`));
  process.env.LOG_DIR = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.LOG_DIR;
});

describe('weekStartLabel', () => {
  it('returns the Monday of the given date\'s week', async () => {
    const { weekStartLabel } = await import('../logger.js');
    // Thursday 2026-08-20 -> Monday 2026-08-17
    expect(weekStartLabel(new Date('2026-08-20T12:00:00Z'))).toBe('2026-08-17');
    // Sunday 2026-08-16 -> Monday 2026-08-10
    expect(weekStartLabel(new Date('2026-08-16T12:00:00Z'))).toBe('2026-08-10');
  });
});

describe('logAction', () => {
  it('writes a JSON line to both the weekly log file and stdout', async () => {
    const { logAction, currentLogFile } = await import('../logger.js');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    logAction({ method: 'POST', path: '/api/items', status: 201 });

    expect(consoleSpy).toHaveBeenCalled();
    const logFile = currentLogFile();
    expect(fs.existsSync(logFile)).toBe(true);
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry).toMatchObject({ method: 'POST', path: '/api/items', status: 201 });
    expect(entry.time).toBeTruthy();

    consoleSpy.mockRestore();
  });

  it('redacts password and token fields before logging', async () => {
    const { logAction, currentLogFile } = await import('../logger.js');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    logAction({
      method: 'POST',
      path: '/api/auth/login',
      status: 200,
      request_body: { username: 'kieren', password: 'hunter2' },
      response_body: { token: 'secret.jwt.token' },
    });

    const entry = JSON.parse(fs.readFileSync(currentLogFile(), 'utf8').trim().split('\n').pop());
    expect(entry.request_body.password).toBe('***');
    expect(entry.request_body.username).toBe('kieren');
    expect(entry.response_body.token).toBe('***');
  });
});

describe('pruneOldLogs', () => {
  it('deletes weekly log files older than the max age and keeps recent ones', async () => {
    const { pruneOldLogs } = await import('../logger.js');
    const oldFile = path.join(tmpDir, 'actions-2020-01-06.log');
    const recentFile = path.join(tmpDir, 'actions-2020-01-27.log');
    fs.writeFileSync(oldFile, '{}\n');
    fs.writeFileSync(recentFile, '{}\n');
    const oldTime = (Date.now() - 40 * 24 * 60 * 60 * 1000) / 1000;
    const recentTime = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(oldFile, oldTime, oldTime);
    fs.utimesSync(recentFile, recentTime, recentTime);

    pruneOldLogs(30);

    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(recentFile)).toBe(true);
  });
});

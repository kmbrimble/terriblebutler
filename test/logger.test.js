import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { Writable } from 'stream';

let tmpDir;
let slowOut = null;

// A stand-in for fd 1: `slow` holds writes until released, like a stalled `docker logs` reader.
function fakeStdout({ slow = false } = {}) {
  const chunks = [];
  const pending = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      if (slow && chunk.length) pending.push(cb); else cb();
    },
  });
  const release = () => pending.splice(0).forEach((cb) => cb());
  // Lets the stalled reader catch up completely.
  const drain = async () => { while (stream.writableLength > 0) { release(); await new Promise((r) => setImmediate(r)); } };
  if (slow) slowOut = { drain };
  return { stream, chunks, release, drain, text: () => chunks.join('') };
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `butler-logger-test-${crypto.randomBytes(4).toString('hex')}-`));
  process.env.LOG_DIR = tmpDir;
  process.env.ACTION_LOG_STDOUT = '0'; // tests that care install their own capture stream
  vi.resetModules();
});

afterEach(async () => {
  if (slowOut) { await slowOut.drain(); slowOut = null; }
  const { flush } = await import('../logger.js');
  await flush();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.LOG_DIR;
  delete process.env.ACTION_LOG_STDOUT;
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
    const { logAction, currentLogFile, flush } = await import('../logger.js');
    const { setStdoutStream } = await import('../logger.js');
    const out = fakeStdout();
    setStdoutStream(out.stream);
    const consoleSpy = vi.spyOn(console, 'log');

    logAction({ method: 'POST', path: '/api/items', status: 201 });
    await flush();

    expect(consoleSpy).not.toHaveBeenCalled(); // no synchronous console.log any more
    expect(out.text()).toMatch(/^\[Action\] \{.*"path":"\/api\/items".*\}\n$/);
    const logFile = currentLogFile();
    expect(fs.existsSync(logFile)).toBe(true);
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry).toMatchObject({ method: 'POST', path: '/api/items', status: 201 });
    expect(entry.time).toBeTruthy();

  });

  it('redacts password and token fields before logging', async () => {
    const { logAction, currentLogFile, flush } = await import('../logger.js');

    logAction({
      method: 'POST',
      path: '/api/auth/login',
      status: 200,
      request_body: { username: 'kieren', password: 'hunter2' },
      response_body: { token: 'secret.jwt.token' },
    });
    await flush();

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

describe('write buffering', () => {
  it('drops entries past the buffer bound, counts them, and records the loss once it drains', async () => {
    const { logAction, currentLogFile, flush, MAX_BUFFERED_BYTES } = await import('../logger.js');
    // Synchronous burst: the stream cannot drain between calls, so the buffer fills.
    const chunk = 'z'.repeat(3000);
    for (let i = 0; i < 2000; i++) logAction({ method: 'POST', path: '/api/items', status: 201, request_body: { note: chunk.slice(0, 2000), i } });
    await flush();
    const lines = fs.readFileSync(currentLogFile(), 'utf8').trim().split('\n');
    expect(lines.length).toBeLessThan(2000);
    expect(Buffer.byteLength(lines.join('\n'))).toBeLessThan(MAX_BUFFERED_BYTES + 64 * 1024);

    logAction({ method: 'POST', path: '/api/items', status: 201 });
    await flush();
    const after = fs.readFileSync(currentLogFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const overflow = after.find((e) => e.event === 'log_overflow');
    expect(overflow.dropped).toBe(2000 - lines.length);
  });

  it('survives an unwritable log directory without throwing', async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.writeFileSync(tmpDir, 'not a directory');
    const { logAction } = await import('../logger.js');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => logAction({ method: 'POST', path: '/api/items', status: 201 })).not.toThrow();
    expect(errSpy).toHaveBeenCalled();
    fs.rmSync(tmpDir, { force: true });
    fs.mkdirSync(tmpDir);
  });
});

describe('pruneOldLogs failures', () => {
  it('logs and carries on when a stale log cannot be removed', async () => {
    const { pruneOldLogs } = await import('../logger.js');
    const stale = path.join(tmpDir, 'actions-2020-01-06.log');
    fs.mkdirSync(stale); // unlinkSync on a directory fails
    const old = (Date.now() - 40 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(stale, old, old);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => pruneOldLogs(30)).not.toThrow();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('actions-2020-01-06.log'), expect.any(String));
  });
});

describe('stdout copy', () => {
  it('is bounded like the file stream: a stalled reader never grows memory, and the loss is recorded', async () => {
    const { logAction, flush, setStdoutStream, MAX_BUFFERED_BYTES } = await import('../logger.js');
    const out = fakeStdout({ slow: true });
    setStdoutStream(out.stream);
    const chunk = 'z'.repeat(2000);
    for (let i = 0; i < 2000; i++) logAction({ method: 'POST', path: '/api/items', status: 201, request_body: { note: chunk, i } });
    expect(out.stream.writableLength).toBeLessThan(MAX_BUFFERED_BYTES + 64 * 1024);

    await out.drain();

    // reader catches up; the next accepted entry is preceded by an overflow record
    logAction({ method: 'POST', path: '/api/after', status: 201 });
    await out.drain();
    await flush();
    const lines = out.text().trim().split('\n');
    expect(lines.every((l) => l.startsWith('[Action] '))).toBe(true);
    const overflow = lines.map((l) => JSON.parse(l.slice('[Action] '.length))).find((e) => e.event === 'log_overflow');
    expect(overflow.dropped).toBeGreaterThan(0);
    expect(overflow.dropped + lines.length - 1).toBe(2001); // every entry is either written or counted
  });

  it('does not block the caller while the reader is stalled', async () => {
    const { logAction, setStdoutStream } = await import('../logger.js');
    setStdoutStream(fakeStdout({ slow: true }).stream);
    const started = performance.now();
    for (let i = 0; i < 500; i++) logAction({ method: 'POST', path: '/api/items', status: 201 });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('survives stdout failing (EPIPE) and keeps writing the file', async () => {
    const { logAction, currentLogFile, flush, setStdoutStream } = await import('../logger.js');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const broken = new Writable({ write(_c, _e, cb) { cb(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })); } });
    setStdoutStream(broken);
    logAction({ method: 'POST', path: '/api/one', status: 201 });
    await new Promise((r) => setImmediate(r));
    expect(() => logAction({ method: 'POST', path: '/api/two', status: 201 })).not.toThrow();
    await flush();
    const entries = fs.readFileSync(currentLogFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(entries.map((e) => e.path)).toEqual(['/api/one', '/api/two']);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('stdout action log disabled'));
  });

  it('can be switched off with ACTION_LOG_STDOUT=0 (no fd 1 stream is opened)', async () => {
    const spy = vi.spyOn(fs, 'createWriteStream');
    const { logAction, flush } = await import('../logger.js');
    logAction({ method: 'POST', path: '/api/items', status: 201 });
    await flush();
    expect(spy.mock.calls.every(([, opts]) => !(opts && opts.fd === 1))).toBe(true);
  });
});

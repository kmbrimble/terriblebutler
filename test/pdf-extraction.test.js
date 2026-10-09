import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import './setup.js';
import { minimalPdf } from './pdf-fixture.js';

const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse');
const { parsePdfText } = require('../lib/pdf-text');
const uploads = require('../lib/uploads');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-pdf-'));
const write = (name, buf) => {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, buf);
  return file;
};
afterEach(() => vi.restoreAllMocks());

describe('page bound', () => {
  it('asks the parser for only MAX_PDF_PAGES + 1 pages and processes no more', async () => {
    const spy = vi.spyOn(PDFParse.prototype, 'getText');
    const { total, text } = await parsePdfText(minimalPdf(30), uploads.MAX_PDF_PAGES);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ first: uploads.MAX_PDF_PAGES + 1 }));
    const result = await spy.mock.results[0].value;
    expect(result.pages).toHaveLength(uploads.MAX_PDF_PAGES + 1); // not 30
    expect(total).toBe(30); // the real count is still reported, so over-length is rejected
    expect(text).not.toContain('Page 30');
  });

  it('extractPdfText rejects over-length and accepts at the limit', async () => {
    await expect(uploads.extractPdfText(write('long.pdf', minimalPdf(21)))).rejects.toMatchObject({ status: 422 });
    await expect(uploads.extractPdfText(write('ok.pdf', minimalPdf(20)))).resolves.toContain('Page 20');
  });
});

describe('deadline and limits', () => {
  it('abandons a document that exceeds the deadline', async () => {
    const started = Date.now();
    await expect(uploads.extractPdfText(write('slow.pdf', minimalPdf(5)), { timeoutMs: 1 }))
      .rejects.toMatchObject({ status: 422, message: expect.stringContaining('abandoned') });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('terminates a worker stuck in a synchronous loop, leaving the main thread responsive', async () => {
    const spinner = write('spin.js', 'require("worker_threads"); for (;;) {}');
    let ticks = 0;
    const interval = setInterval(() => { ticks += 1; }, 10);
    await expect(uploads.runWorker(spinner, {}, { timeoutMs: 150 })).rejects.toMatchObject({ status: 422 });
    clearInterval(interval);
    expect(ticks).toBeGreaterThan(3); // the event loop kept running while the worker spun
  });

  it('the ceiling is the configured one: ~64 MB of live heap passes under 512 MB and is killed under 16 MB', async () => {
    // Without resourceLimits both runs would pass, so this fails if the cap is ever dropped or ignored.
    const alloc = write('alloc.js', 'const { parentPort } = require("worker_threads"); const a = []; for (let i = 0; i < 8; i++) a.push(new Array(1e6).fill(1)); parentPort.postMessage({ ok: true, result: a.length });');
    await expect(uploads.runWorker(alloc, {}, { timeoutMs: 10_000, memoryMb: 512 })).resolves.toBe(8);
    await expect(uploads.runWorker(alloc, {}, { timeoutMs: 10_000, memoryMb: 16 }))
      .rejects.toMatchObject({ status: 422, message: expect.stringContaining('too complex') });
  });

  it('kills a worker that exhausts its memory ceiling', async () => {
    const hog = write('hog.js', 'const a = []; for (;;) a.push(new Array(1e6).fill(1));');
    await expect(uploads.runWorker(hog, {}, { timeoutMs: 10_000, memoryMb: 32 }))
      .rejects.toMatchObject({ status: 422, message: expect.stringContaining('too complex') });
  });

  it('reports a worker that dies without an answer', async () => {
    const quiet = write('quiet.js', '');
    await expect(uploads.runWorker(quiet, {}, { timeoutMs: 5000 })).rejects.toThrow(/exited unexpectedly/);
  });

  it('still rejects non-PDF bytes before spawning anything', async () => {
    await expect(uploads.extractPdfText(write('x.pdf', Buffer.from('<html>')))).rejects.toMatchObject({ status: 400 });
  });
});

describe('PDF limit configuration', () => {
  it.each([['Infinity'], ['1.5'], ['-1'], ['0'], ['abc'], ['999999999999']])('falls back to the defaults for %s', async (bad) => {
    vi.resetModules();
    process.env.PDF_PARSE_TIMEOUT_MS = bad;
    process.env.PDF_WORKER_MEMORY_MB = bad;
    try {
      const config = require('../lib/config');
      delete require.cache[require.resolve('../lib/config')];
      const fresh = require('../lib/config');
      expect([fresh.PDF_PARSE_TIMEOUT_MS, fresh.PDF_WORKER_MEMORY_MB]).toEqual([20_000, 256]);
      expect(config).toBeTruthy();
    } finally {
      delete process.env.PDF_PARSE_TIMEOUT_MS;
      delete process.env.PDF_WORKER_MEMORY_MB;
      delete require.cache[require.resolve('../lib/config')];
    }
  });
});

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import request from 'supertest';
import Database from 'better-sqlite3';
import './setup.js';
import { TEST_TOKEN, clearInvoiceImports, tmpUploadScratchDir } from './setup.js';
import { loadFreshApp } from './fresh-app.js';

vi.setConfig({ testTimeout: 30000 });
const nodeRequire = createRequire(import.meta.url);
const WOOLWORTHS_PDF = path.join(process.cwd(), 'test/fixtures/invoices/woolworths-example.pdf');
const authed = (test) => test.set('Authorization', `Bearer ${TEST_TOKEN}`);
const scratchFiles = () => fs.readdirSync(tmpUploadScratchDir);
// The handler discards the upload in a `finally` that runs after the response has been sent, so the
// file goes shortly after the client sees the status (same idiom as test/uploads.test.js).
const scratchEmptied = () => vi.waitFor(() => expect(scratchFiles()).toEqual([]), { timeout: 5000 });

beforeAll(() => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1';
});
beforeEach(() => clearInvoiceImports());
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.HEAVY_WORK_CONCURRENCY;
  delete process.env.HEAVY_WORK_QUEUE;
  delete process.env.PDF_WORKER_MEMORY_MB;
});

// No LLM spend or network in these tests: every Anthropic call fails fast, which the import
// reports as a warning rather than an error.
function failingFetch() {
  vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network disabled in tests'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
}

describe('POST /api/invoices/import: unreadable PDFs', () => {
  it('answers 422 with a clear message for a corrupt PDF (not a 500), and discards the upload', async () => {
    const { app } = loadFreshApp({});
    const corrupt = Buffer.from('%PDF-1.4\nthis is not a real pdf body\n%%EOF');
    const res = await authed(request(app).post('/api/invoices/import')).attach('invoice', corrupt, { filename: 'bad.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/could not be read/i);
    expect(res.body.correlation_id).toBeUndefined();
    await scratchEmptied();
  });

  it('a worker that hits its heap ceiling fails the request cleanly (422), not the server', async () => {
    // The configured ceiling has a 64 MB floor (a smaller one aborts the process), so shrink it
    // for this app only by wrapping the extractor the route was built with.
    const { app } = loadFreshApp({}, {
      beforeLoad: (req) => {
        const uploads = req('../lib/uploads');
        const real = uploads.extractPdfText;
        uploads.extractPdfText = (file) => real(file, { memoryMb: 8 });
      },
    });
    const res = await authed(request(app).post('/api/invoices/import')).attach('invoice', WOOLWORTHS_PDF);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/too complex/i);
    expect(res.body.correlation_id).toBeUndefined();
    await scratchEmptied();
    // ...and the server carries on serving.
    expect((await authed(request(app).get('/api/health'))).status).toBe(200);
  });

  it.each(['1', '63', '0', '-5', 'abc', '99999'])('PDF_WORKER_MEMORY_MB=%s falls back to the default instead of crashing workers', (bad) => {
    loadFreshApp({ PDF_WORKER_MEMORY_MB: bad });
    expect(nodeRequire('../lib/config').PDF_WORKER_MEMORY_MB).toBe(256);
  });
});

describe('POST /api/invoices/import: staging is one transaction (#43)', () => {
  it('leaves no header row behind when a line insert fails', async () => {
    const { app } = loadFreshApp({});
    failingFetch();
    const conn = new Database(process.env.DB_PATH);
    conn.exec("CREATE TRIGGER fail_line_insert BEFORE INSERT ON invoice_import_lines BEGIN SELECT RAISE(ABORT, 'forced line failure'); END;");
    try {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = await authed(request(app).post('/api/invoices/import')).attach('invoice', WOOLWORTHS_PDF);
      expect(res.status).toBe(500);
      expect(res.body.error).not.toMatch(/forced line failure/);
      expect(conn.prepare('SELECT COUNT(*) AS n FROM invoice_imports').get().n).toBe(0);
      expect(conn.prepare('SELECT COUNT(*) AS n FROM invoice_import_lines').get().n).toBe(0);
    } finally {
      conn.exec('DROP TRIGGER fail_line_insert');
      conn.close();
    }
    // The dedupe key was not consumed either: the same invoice imports once the fault is gone.
    const retry = await authed(request(app).post('/api/invoices/import')).attach('invoice', WOOLWORTHS_PDF);
    expect(retry.status).toBe(200);
  });
});

describe('POST /api/invoices/import: source_filename', () => {
  it('stores a sanitised display name, not the raw upload filename', async () => {
    const { app } = loadFreshApp({});
    failingFetch();
    const pdf = fs.readFileSync(WOOLWORTHS_PDF);
    const res = await authed(request(app).post('/api/invoices/import'))
      .attach('invoice', pdf, { filename: 'C:\\Users\\x/../../etc/pass\twd.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(200);
    const name = res.body.import.source_filename;
    expect(name).not.toMatch(/[\\/]/);
    expect(name).not.toMatch(/\p{Cc}/u);
    expect(name).toBe('pass wd.pdf');
  });

  it('bounds a very long filename to 200 characters', async () => {
    const { app } = loadFreshApp({});
    failingFetch();
    const res = await authed(request(app).post('/api/invoices/import'))
      .attach('invoice', fs.readFileSync(WOOLWORTHS_PDF), { filename: `${'a'.repeat(400)}.pdf`, contentType: 'application/pdf' });
    expect(res.status).toBe(200);
    expect(res.body.import.source_filename).toHaveLength(200);
  });
});

describe('process-wide bound on heavy upload work (HEAVY_WORK_CONCURRENCY / HEAVY_WORK_QUEUE)', () => {
  it('answers 503 + Retry-After when the gate is full, and still discards the upload', async () => {
    const { app } = loadFreshApp({ HEAVY_WORK_CONCURRENCY: '1', HEAVY_WORK_QUEUE: '0' });
    const { heavyWork } = nodeRequire('../lib/uploads');
    let release;
    const held = heavyWork.run(() => new Promise((resolve) => { release = resolve; }));
    try {
      const res = await authed(request(app).post('/api/invoices/import')).attach('invoice', WOOLWORTHS_PDF);
      expect(res.status).toBe(503);
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      await scratchEmptied();

      const label = await authed(request(app).post('/api/parse-label-llm')).attach('image', path.join(process.cwd(), 'test/fixtures/product1.jpg'));
      expect(label.status).toBe(503);
      expect(Number(label.headers['retry-after'])).toBeGreaterThan(0);
      await scratchEmptied();
    } finally {
      release();
      await held;
    }
  });

  it('serves the request again once a slot frees', async () => {
    const { app } = loadFreshApp({ HEAVY_WORK_CONCURRENCY: '1', HEAVY_WORK_QUEUE: '0' });
    failingFetch();
    const res = await authed(request(app).post('/api/invoices/import')).attach('invoice', WOOLWORTHS_PDF);
    expect(res.status).toBe(200);
  });
});

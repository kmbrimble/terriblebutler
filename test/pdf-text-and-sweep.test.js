// The extracted-text cap (inside the worker) and the lstat-based scratch sweep.
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { createRequire } from 'module';
import request from 'supertest';
import './setup.js';
import { TEST_TOKEN, clearInvoiceImports, tmpUploadScratchDir } from './setup.js';
import { loadFreshApp } from './fresh-app.js';

vi.setConfig({ testTimeout: 60000 });
const nodeRequire = createRequire(import.meta.url);
afterEach(() => vi.restoreAllMocks());

// A benign, compact PDF: one page whose deflated content stream expands to `chars` characters of text.
function compressedTextPdf(chars, lineLength = 30) {
  const lines = [];
  for (let n = 0; n < chars; n += lineLength) lines.push(`BT /F1 8 Tf 5 ${190 - (lines.length % 150) * 0.5} Td (${'A'.repeat(Math.min(lineLength, chars - n))}) Tj ET`);
  const stream = zlib.deflateSync(Buffer.from(lines.join('\n'), 'latin1')).toString('latin1');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>',
    `<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n${stream}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

describe('PDF_MAX_TEXT_CHARS', () => {
  it('the fixture really is compact: well under 100 KB for ~1.5 million characters of text', () => {
    expect(compressedTextPdf(1_500_000).length).toBeLessThan(100_000);
  });

  it('is configured as documented: default 500,000, floor 1,000, junk falls back', () => {
    loadFreshApp({ PDF_MAX_TEXT_CHARS: undefined });
    expect(nodeRequire('../lib/config').PDF_MAX_TEXT_CHARS).toBe(500000);
    for (const bad of ['0', '999', '-5', 'abc', '1e6', '', '50000001']) {
      loadFreshApp({ PDF_MAX_TEXT_CHARS: bad });
      expect(nodeRequire('../lib/config').PDF_MAX_TEXT_CHARS, bad).toBe(500000);
    }
    loadFreshApp({ PDF_MAX_TEXT_CHARS: '2000' });
    expect(nodeRequire('../lib/config').PDF_MAX_TEXT_CHARS).toBe(2000);
  });

  it('a PDF whose text exceeds the cap is a 422 from the worker, never reaching the parsers, and the upload is discarded', async () => {
    const { app } = loadFreshApp({ PDF_MAX_TEXT_CHARS: undefined });
    clearInvoiceImports();
    const res = await request(app).post('/api/invoices/import').set('Authorization', `Bearer ${TEST_TOKEN}`)
      .attach('invoice', compressedTextPdf(1_500_000), { filename: 'big.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/far larger than any invoice/);
    expect(res.body.correlation_id).toBeUndefined();
    await vi.waitFor(() => expect(fs.readdirSync(tmpUploadScratchDir)).toEqual([]), { timeout: 5000 });
  });

  it('extractPdfText: the same PDF passes under a cap above its size, and fails under one below it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-pdfcap-'));
    const file = path.join(dir, 'a.pdf');
    fs.writeFileSync(file, compressedTextPdf(20_000));
    try {
      loadFreshApp({ PDF_MAX_TEXT_CHARS: '50000' });
      const roomy = nodeRequire('../lib/uploads');
      expect((await roomy.extractPdfText(file)).length).toBeGreaterThan(15_000);
      loadFreshApp({ PDF_MAX_TEXT_CHARS: '10000' });
      await expect(nodeRequire('../lib/uploads').extractPdfText(file)).rejects.toMatchObject({ status: 422 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an ordinary invoice is far below the default cap', async () => {
    const { parsePdfText } = nodeRequire('../lib/pdf-text');
    const { PDFParse } = nodeRequire('pdf-parse');
    void PDFParse;
    const text = (await parsePdfText(fs.readFileSync(path.join(process.cwd(), 'test/fixtures/invoices/woolworths-example.pdf')), 20)).text;
    expect(text.length).toBeLessThan(500_000 / 20);
  });
});

describe('sweepStaleScratch uses lstat', () => {
  const OLD = new Date(Date.now() - 3 * 60 * 60 * 1000);
  function scratch() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-sweep-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-sweep-outside-'));
    return { dir, outside, cleanup: () => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); } };
  }
  const { sweepStaleScratch } = nodeRequire('../lib/uploads');

  it('removes stale files, keeps fresh ones', async () => {
    const s = scratch();
    try {
      const old = path.join(s.dir, 'old'); const fresh = path.join(s.dir, 'fresh');
      fs.writeFileSync(old, 'x'); fs.writeFileSync(fresh, 'x'); fs.utimesSync(old, OLD, OLD);
      await sweepStaleScratch(s.dir);
      expect(fs.existsSync(old)).toBe(false);
      expect(fs.existsSync(fresh)).toBe(true);
    } finally { s.cleanup(); }
  });

  it('removes symbolic links themselves, whatever they point at, and never touches the targets', async () => {
    const s = scratch();
    try {
      const target = path.join(s.outside, 'precious.txt');
      fs.writeFileSync(target, 'keep'); fs.utimesSync(target, OLD, OLD); // old, so a following sweep would delete it
      const targetDir = path.join(s.outside, 'dir'); fs.mkdirSync(targetDir);
      fs.writeFileSync(path.join(targetDir, 'inside.txt'), 'keep');
      fs.symlinkSync(target, path.join(s.dir, 'to-old-file'));
      fs.symlinkSync(targetDir, path.join(s.dir, 'to-dir'));
      fs.symlinkSync(path.join(s.outside, 'nowhere'), path.join(s.dir, 'dangling'));
      await sweepStaleScratch(s.dir);
      expect(fs.readdirSync(s.dir)).toEqual([]);
      expect(fs.readFileSync(target, 'utf8')).toBe('keep');
      expect(fs.readFileSync(path.join(targetDir, 'inside.txt'), 'utf8')).toBe('keep');
    } finally { s.cleanup(); }
  });

  it('a dangling link (or any unreadable entry) does not stop the rest being swept, whatever the listing order', async () => {
    const s = scratch();
    try {
      const old = path.join(s.dir, 'old-after');
      fs.writeFileSync(old, 'x'); fs.utimesSync(old, OLD, OLD);
      fs.symlinkSync(path.join(s.outside, 'nowhere'), path.join(s.dir, 'dangling-first'));
      vi.spyOn(fs.promises, 'readdir').mockResolvedValue(['dangling-first', 'vanished', 'old-after']);
      await sweepStaleScratch(s.dir);
      vi.restoreAllMocks();
      expect(fs.existsSync(old)).toBe(false);
      expect(fs.readdirSync(s.dir)).toEqual([]);
    } finally { s.cleanup(); }
  });
});

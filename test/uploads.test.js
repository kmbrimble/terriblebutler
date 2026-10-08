import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import express from 'express';
import path from 'path';
import sharp from 'sharp';
import request from 'supertest';
import { api, tmpUploadsDir, tmpUploadScratchDir } from './setup.js';
import pkg from '../server.js';
import uploads from '../lib/uploads.js';

const { app, db } = pkg;

// --- benign generated fixtures -------------------------------------------------------------

const solid = (width, height, channels = 3) =>
  sharp({ create: { width, height, channels, background: { r: 200, g: 60, b: 60 } } });

function minimalPdf(pageCount) {
  const objs = [];
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  const kids = Array.from({ length: pageCount }, (_, i) => `${3 + i * 2} 0 R`).join(' ');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`);
  for (let i = 0; i < pageCount; i++) {
    const stream = `BT /F1 12 Tf 20 100 Td (Page ${i + 1}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

async function upload(buf, { filename = 'photo.jpg', mime = 'image/jpeg', route = '/api/upload-image' } = {}) {
  return api(app).post(route).attach('image', buf, { filename, contentType: mime });
}

const storedFiles = () => fs.readdirSync(tmpUploadsDir);
const scratchFiles = () => (fs.existsSync(tmpUploadScratchDir) ? fs.readdirSync(tmpUploadScratchDir) : []);
const scratchEmpty = () => vi.waitFor(() => expect(scratchFiles()).toEqual([]));

function splitUrl(url) {
  const u = new URL(url, 'http://x');
  return { name: path.basename(u.pathname), exp: u.searchParams.get('exp'), sig: u.searchParams.get('sig') };
}

async function storeJpeg() {
  const res = await upload(await solid(40, 20).jpeg().toBuffer());
  expect(res.status).toBe(200);
  return res.body;
}

// --- tests ---------------------------------------------------------------------------------

describe('upload storage location (#51)', () => {
  it('stores images in UPLOADS_DIR (the one configured directory), not the cwd-relative uploads/', async () => {
    const { image_id } = await storeJpeg();
    expect(fs.existsSync(path.join(tmpUploadsDir, image_id))).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), 'uploads', image_id))).toBe(false);
  });
});

describe('uploaded images are not reachable without a valid signature (#41)', () => {
  it('no longer serves /uploads statically', async () => {
    const { image_id } = await storeJpeg();
    const res = await request(app).get(`/uploads/${image_id}`);
    expect(res.headers['content-type'] || '').not.toMatch(/image/);
  });

  it('refuses /media/<id> with no signature, tampered parameters, or a bad signature', async () => {
    const { image_path } = await storeJpeg();
    const { name, exp, sig } = splitUrl(image_path);

    expect((await request(app).get(`/media/${name}`)).status).toBe(403);
    expect((await request(app).get(`/media/${name}?exp=${exp}`)).status).toBe(403);
    expect((await request(app).get(`/media/${name}?exp=${exp}&sig=${'A'.repeat(43)}`)).status).toBe(403);
    // Flipping the last signature character, extending the expiry, and swapping the id all fail.
    const flipped = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
    expect((await request(app).get(`/media/${name}?exp=${exp}&sig=${flipped}`)).status).toBe(403);
    expect((await request(app).get(`/media/${name}?exp=${Number(exp) + 3600}&sig=${sig}`)).status).toBe(403);
    const other = await storeJpeg();
    expect((await request(app).get(`/media/${other.image_id}?exp=${exp}&sig=${sig}`)).status).toBe(403);
  });

  it('rejects an expired signature even though it is otherwise genuine', async () => {
    const { image_id } = await storeJpeg();
    const twoHoursAgo = Date.now() - 2 * 3600 * 1000 - 1000;
    const expired = uploads.signMediaUrl(image_id, twoHoursAgo);
    expect((await request(app).get(expired)).status).toBe(403);
  });

  it('serves the image for a valid signature, with a server-chosen type and hardening headers', async () => {
    const { image_path } = await storeJpeg();
    const res = await request(app).get(image_path).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(res.headers['cache-control']).toMatch(/^private, max-age=\d+$/);
    expect(res.headers['content-disposition']).toBeUndefined();
    expect((await sharp(res.body).metadata()).format).toBe('webp');
  });

  it('answers 404 for a validly signed but missing file, and refuses traversal-shaped ids', async () => {
    const missing = uploads.signMediaUrl('0'.repeat(32) + '.webp');
    expect((await request(app).get(missing)).status).toBe(404);

    for (const bad of ['..%2F..%2Fetc%2Fpasswd', '..%2Fserver.js', '%2e%2e%2fserver.js', `${'0'.repeat(32)}.webp%00.html`, 'x.html']) {
      const res = await request(app).get(`/media/${bad}?exp=${Date.now()}&sig=${'A'.repeat(43)}`);
      expect([403, 404]).toContain(res.status);
      expect(res.headers['content-type'] || '').not.toMatch(/javascript|html/);
    }
    // Even a genuine signature cannot make a non-canonical name resolvable.
    expect(() => uploads.signMediaUrl('../server.js')).toThrow();
  });

  it('denyUploadsUnder keeps a static mount from serving the uploads dir, however the path is spelled', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-static-'));
    try {
      fs.mkdirSync(path.join(root, 'uploads'));
      fs.writeFileSync(path.join(root, 'uploads', 'secret.txt'), 'private');
      fs.writeFileSync(path.join(root, 'ok.txt'), 'public');
      const mini = express();
      mini.use('/legacy', uploads.denyUploadsUnder(root, path.join(root, 'uploads')));
      mini.use('/legacy', express.static(root));
      for (const spelling of [
        '/legacy/uploads/secret.txt',
        '/legacy/%75ploads/secret.txt',
        '/legacy//uploads/secret.txt',
        '/legacy/uploads%2Fsecret.txt',
        '/legacy/./uploads/secret.txt',
        '/legacy/x/../uploads/secret.txt',
        '/legacy/%E0%A4%A',
      ]) {
        const res = await request(mini).get(spelling);
        expect([400, 404], spelling).toContain(res.status);
        expect(res.text, spelling).not.toContain('private');
      }
      const control = await request(mini).get('/legacy/ok.txt');
      expect(control.status).toBe(200);
      expect(control.text).toBe('public');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires authentication to upload', async () => {
    const res = await request(app).post('/api/upload-image').attach('image', await solid(8, 8).jpeg().toBuffer(), { filename: 'a.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(401);
  });
});

describe('every place an image leaves the server is signed (#41)', () => {
  function itemWithImage(name, stored, extra = {}) {
    const info = db.prepare('INSERT INTO items (name, reorder_threshold, barcode) VALUES (?, 5, ?)').run(name, extra.barcode || null);
    db.prepare('UPDATE items SET image_path = ? WHERE id = ?').run(stored, info.lastInsertRowid);
    return Number(info.lastInsertRowid);
  }

  const expectSigned = (value, id) => {
    expect(value).toMatch(new RegExp(`^/media/${id}\\?exp=\\d+&sig=[A-Za-z0-9_-]{43}$`));
  };

  it('signs image_path on list, detail, barcode, search, grocery and mutation responses', async () => {
    const { image_id } = await storeJpeg();
    const id = itemWithImage('Signed Widget', image_id, { barcode: 'SIGNED-1' });

    const list = await api(app).get('/api/items');
    expectSigned(list.body.find((i) => i.id === id).image_path, image_id);
    expectSigned((await api(app).get(`/api/items/${id}/details`)).body.image_path, image_id);
    expectSigned((await api(app).get('/api/items/barcode/SIGNED-1')).body.image_path, image_id);
    expectSigned((await api(app).get('/api/items/search?q=Signed Widget')).body[0].image_path, image_id);
    expectSigned((await api(app).get('/api/grocery-list')).body.find((i) => i.id === id).image_path, image_id);
    const put = await api(app).put(`/api/items/${id}`).send({ name: 'Signed Widget', reorder_threshold: 5 });
    expectSigned(put.body.image_path, image_id);
  });

  it('signs the item inside Socket.IO broadcast payloads (they share getItem with the REST responses)', async () => {
    const { image_id } = await storeJpeg();
    const id = itemWithImage('Broadcast Widget', image_id);
    const { createDomainHelpers } = await import('../lib/domain-helpers.js');
    expectSigned(createDomainHelpers(db).getItem(id).image_path, image_id);
  });

  it('never emits an unsigned or legacy value: anything not a stored image id becomes null', async () => {
    const legacy = itemWithImage('Legacy Widget', '/uploads/1700000000000-123456789.html');
    const traversal = itemWithImage('Traversal Widget', '../../etc/passwd');
    const list = (await api(app).get('/api/items')).body;
    expect(list.find((i) => i.id === legacy).image_path).toBeNull();
    expect(list.find((i) => i.id === traversal).image_path).toBeNull();
  });

  it('gives the same URL throughout a time bucket (so browsers can cache) and a fresh one next bucket', () => {
    const name = '1'.repeat(32) + '.webp';
    const t = Date.UTC(2026, 9, 9, 10, 5, 0);
    expect(uploads.signMediaUrl(name, t)).toBe(uploads.signMediaUrl(name, t + 30 * 60 * 1000));
    expect(uploads.signMediaUrl(name, t)).not.toBe(uploads.signMediaUrl(name, t + 2 * 3600 * 1000));
  });
});

describe('uploaded content is validated, re-encoded and renamed server-side (#41)', () => {
  it('ignores the client filename and extension entirely', async () => {
    const res = await upload(await solid(30, 30).png().toBuffer(), { filename: 'evil.html', mime: 'image/png' });
    expect(res.status).toBe(200);
    expect(res.body.image_id).toMatch(/^[0-9a-f]{32}\.webp$/);
    expect(JSON.stringify(res.body)).not.toMatch(/evil|html/);
    expect(storedFiles().filter((f) => /html/.test(f))).toEqual([]);
  });

  it('rejects content that is not an allowed image even when the declared MIME says image', async () => {
    const before = storedFiles().length;
    const notImages = [
      ['html', Buffer.from('<!doctype html><title>x</title><p>hello</p>')],
      ['svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>')],
      ['gif', await solid(10, 10).gif().toBuffer()],
      ['tiff', await solid(10, 10).tiff().toBuffer()],
      ['text', Buffer.from('just some text')],
    ];
    for (const [label, buf] of notImages) {
      const res = await upload(buf, { filename: `${label}.jpg`, mime: 'image/jpeg' });
      expect(res.status, label).toBe(400);
    }
    expect(storedFiles().length).toBe(before);
    await scratchEmpty();
  });

  it('accepts jpeg, png and webp inputs by their real format and stores a single canonical format', async () => {
    for (const buf of [await solid(16, 16).jpeg().toBuffer(), await solid(16, 16, 4).png().toBuffer(), await solid(16, 16).webp().toBuffer()]) {
      const res = await upload(buf, { filename: 'a.bin', mime: 'image/jpeg' });
      expect(res.status).toBe(200);
      const meta = await sharp(path.join(tmpUploadsDir, res.body.image_id)).metadata();
      expect(meta.format).toBe('webp');
    }
  });

  it('strips EXIF/GPS metadata and applies the orientation instead of keeping the tag', async () => {
    const withExif = await solid(40, 20)
      .withExif({ IFD0: { Copyright: 'secret-owner' }, IFD3: { GPSLatitudeRef: 'S', GPSLongitudeRef: 'E' } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeTruthy();

    const res = await upload(withExif);
    expect(res.status).toBe(200);
    const stored = fs.readFileSync(path.join(tmpUploadsDir, res.body.image_id));
    const meta = await sharp(stored).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(stored.includes(Buffer.from('secret-owner'))).toBe(false);
    // Orientation 6 rotates 90 degrees: 40x20 is stored as 20x40 with no orientation tag left.
    expect([meta.width, meta.height]).toEqual([20, 40]);
    expect(meta.orientation === undefined || meta.orientation === 1).toBe(true);
  });

  it('enforces the input pixel limit (a tiny PNG that decodes to ~64 megapixels is refused)', async () => {
    const huge = await solid(8000, 8000).png({ compressionLevel: 9 }).toBuffer();
    expect(huge.length).toBeLessThan(5 * 1024 * 1024);
    const before = storedFiles().length;
    const res = await upload(huge, { filename: 'big.png', mime: 'image/png' });
    expect(res.status).toBe(400);
    expect(storedFiles().length).toBe(before);
    await scratchEmpty();
  });

  it('applies the same content validation to the label parser (no LLM call for a non-image)', async () => {
    const res = await upload(Buffer.from('<html></html>'), { route: '/api/parse-label-llm' });
    expect(res.status).toBe(400);
    await scratchEmpty();
  });

  it('leaves no multer scratch files behind after success or failure', async () => {
    await storeJpeg();
    await upload(Buffer.from('nope'));
    await upload(await solid(16, 16).jpeg().toBuffer(), { mime: 'text/html' });
    await scratchEmpty();
  });

  it('keeps raw uploads out of the served directory while processing', async () => {
    await storeJpeg();
    for (const f of storedFiles()) expect(f).toMatch(/^[0-9a-f]{32}\.webp$/);
  });
});

describe('only the image decoders the app needs are enabled (#60)', () => {
  it('refuses SVG, TIFF and GIF at the libvips loader level but still reads jpeg/png/webp', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>');
    await expect(sharp(svg).metadata()).rejects.toThrow();
    await expect(sharp(await solid(4, 4).tiff().toBuffer()).metadata()).rejects.toThrow();
    await expect(sharp(await solid(4, 4).gif().toBuffer()).metadata()).rejects.toThrow();
    for (const fmt of ['jpeg', 'png', 'webp']) {
      expect((await sharp(await solid(4, 4)[fmt]().toBuffer()).metadata()).format).toBe(fmt);
    }
  });
});

describe('invoice PDFs are bounded and never stored (#41/#60)', () => {
  const pdf = (n) => minimalPdf(n);
  const send = (route, buf) =>
    api(app).post(route).attach('invoice', buf, { filename: 'invoice.pdf', contentType: 'application/pdf' });

  it('rejects a PDF over the page limit on /api/invoices/import and /api/invoices/parse', async () => {
    const tooLong = pdf(uploads.MAX_PDF_PAGES + 1);
    for (const route of ['/api/invoices/import', '/api/invoices/parse']) {
      const res = await send(route, tooLong);
      expect(res.status, route).toBe(422);
      expect(res.body.error).toMatch(/pages/i);
    }
    await scratchEmpty();
  });

  it('does not reject a PDF at the page limit for being too long', async () => {
    const res = await send('/api/invoices/import', pdf(uploads.MAX_PDF_PAGES));
    // The generated PDF is not a supported retailer invoice, but it is read in full.
    expect(res.status).toBe(422);
    expect(res.body.error).not.toMatch(/pages/i);
  });

  it('rejects a non-PDF declared as application/pdf, and never writes PDFs to the uploads dir', async () => {
    const before = storedFiles().length;
    const res = await send('/api/invoices/import', Buffer.from('<html>not a pdf</html>'));
    expect(res.status).toBe(400);
    expect(storedFiles().length).toBe(before);
    await scratchEmpty();
  });
});

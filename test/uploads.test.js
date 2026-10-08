import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import request from 'supertest';
import { api, tmpUploadsDir, tmpUploadScratchDir } from './setup.js';
import pkg from '../server.js';
import uploads from '../lib/uploads.js';
import { minimalPdf } from './pdf-fixture.js';

const { app, db } = pkg;

// --- benign generated fixtures -------------------------------------------------------------

const solid = (width, height, channels = 3) =>
  sharp({ create: { width, height, channels, background: { r: 200, g: 60, b: 60 } } });

// Label scan is the only upload endpoint. The Anthropic call is stubbed out so no test can reach the network.
async function upload(buf, { filename = 'photo.jpg', mime = 'image/jpeg', route = '/api/parse-label-llm' } = {}) {
  return api(app).post(route).attach('image', buf, { filename, contentType: mime });
}

// Runs a buffer through the storage pipeline directly (no endpoint stores images today), from a
// source file with an arbitrary, hostile-looking name.
async function storeImage(buf, sourceName = 'source.bin') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-src-'));
  try {
    const src = path.join(dir, sourceName);
    fs.writeFileSync(src, buf);
    return await uploads.storeUploadedImage(src);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const storedFiles = () => fs.readdirSync(tmpUploadsDir);
const scratchFiles = () => (fs.existsSync(tmpUploadScratchDir) ? fs.readdirSync(tmpUploadScratchDir) : []);
const scratchEmpty = () => vi.waitFor(() => expect(scratchFiles()).toEqual([]));

function splitUrl(url) {
  const u = new URL(url, 'http://x');
  return { name: path.basename(u.pathname), exp: u.searchParams.get('exp'), sig: u.searchParams.get('sig') };
}

async function storeJpeg() {
  const image_id = await storeImage(await solid(40, 20).jpeg().toBuffer());
  return { image_id, image_path: uploads.signMediaUrl(image_id) };
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

  it('serves no uploaded file at any static-looking path: /media is the only way to read one', async () => {
    const name = `${'a'.repeat(32)}.webp`;
    fs.mkdirSync(tmpUploadsDir, { recursive: true });
    fs.writeFileSync(path.join(tmpUploadsDir, name), 'private-bytes');
    try {
      for (const p of [`/uploads/${name}`, `/legacy/uploads/${name}`, `/legacy/%75ploads/${name}`, `/public/uploads/${name}`, `/legacy/`]) {
        const res = await request(app).get(p);
        expect(res.text, p).not.toContain('private-bytes');
        expect(res.headers['content-type'] || '', p).not.toMatch(/image\/webp/);
      }
      const unsigned = await request(app).get(`/media/${name}`);
      expect(unsigned.status).toBe(403);
      // Errors carry the strict /media policy too, not the app-wide one.
      expect(unsigned.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    } finally {
      fs.rmSync(path.join(tmpUploadsDir, name), { force: true });
    }
  });

  it('has no endpoint that stores client uploads (nothing links them to an item or cleans them up)', async () => {
    const before = storedFiles();
    const res = await api(app).post('/api/upload-image').attach('image', await solid(8, 8).jpeg().toBuffer(), { filename: 'a.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(404);
    expect(storedFiles()).toEqual(before);
    await scratchEmpty();
  });

  it('requires authentication to scan a label', async () => {
    const res = await request(app).post('/api/parse-label-llm').attach('image', await solid(8, 8).jpeg().toBuffer(), { filename: 'a.jpg', contentType: 'image/jpeg' });
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

describe('stored images are re-encoded and renamed server-side (#41)', () => {
  it('ignores the source name and extension entirely', async () => {
    const id = await storeImage(await solid(30, 30).png().toBuffer(), 'evil.html');
    expect(id).toMatch(/^[0-9a-f]{32}\.webp$/);
    expect(storedFiles().filter((f) => /html|evil/.test(f))).toEqual([]);
  });

  it('accepts jpeg, png and webp by their real format and stores a single canonical format', async () => {
    for (const buf of [await solid(16, 16).jpeg().toBuffer(), await solid(16, 16, 4).png().toBuffer(), await solid(16, 16).webp().toBuffer()]) {
      const id = await storeImage(buf, 'a.gif');
      expect((await sharp(path.join(tmpUploadsDir, id)).metadata()).format).toBe('webp');
    }
  });

  it('strips EXIF/GPS metadata and applies the orientation instead of keeping the tag', async () => {
    const withExif = await solid(40, 20)
      .withExif({ IFD0: { Copyright: 'secret-owner' }, IFD3: { GPSLatitudeRef: 'S', GPSLongitudeRef: 'E' } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeTruthy();

    const stored = fs.readFileSync(path.join(tmpUploadsDir, await storeImage(withExif)));
    const meta = await sharp(stored).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(stored.includes(Buffer.from('secret-owner'))).toBe(false);
    // Orientation 6 rotates 90 degrees: 40x20 is stored as 20x40 with no orientation tag left.
    expect([meta.width, meta.height]).toEqual([20, 40]);
    expect(meta.orientation === undefined || meta.orientation === 1).toBe(true);
  });

  it('refuses non-images and over-limit images without leaving anything stored', async () => {
    const before = storedFiles();
    const huge = await solid(8000, 8000).png({ compressionLevel: 9 }).toBuffer();
    for (const buf of [Buffer.from('<html></html>'), await solid(10, 10).gif().toBuffer(), huge]) {
      await expect(storeImage(buf)).rejects.toThrow();
    }
    expect(storedFiles()).toEqual(before);
  });
});

describe('label-scan uploads are validated before any LLM call (#41/#60)', () => {
  const realFetch = globalThis.fetch;
  let llmCalls;
  beforeEach(() => {
    llmCalls = 0;
    process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
    globalThis.fetch = vi.fn(async (url, init) => {
      if (String(url).includes('anthropic')) {
        llmCalls += 1;
        return new Response('{}', { status: 400, headers: { 'content-type': 'application/json' } });
      }
      return realFetch(url, init);
    });
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('rejects content that is not an allowed image even when the declared MIME says image', async () => {
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
      expect(res.body.error, label).toMatch(/JPEG, PNG or WebP/);
    }
    expect(llmCalls).toBe(0);
    await scratchEmpty();
  });

  it('does not accept HEIC/HEIF: neither by declared type nor by content', async () => {
    for (const mime of ['image/heic', 'image/heif']) {
      const res = await upload(await solid(10, 10).jpeg().toBuffer(), { mime, filename: 'IMG_0001.HEIC' });
      expect(res.status, mime).toBe(400);
      expect(res.body.error, mime).toMatch(/JPEG, PNG or WebP/);
    }
    // Real HEIF-container content (AV1 flavour) sent under an allowed MIME is refused too.
    const heif = await solid(10, 10).heif({ compression: 'av1' }).toBuffer();
    expect((await sharp(heif).metadata().catch(() => ({}))).format).toBeUndefined();
    const res = await upload(heif, { mime: 'image/jpeg' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/JPEG, PNG or WebP/);
    expect(llmCalls).toBe(0);
    await scratchEmpty();
  });

  it('enforces the input pixel limit (a tiny PNG that decodes to ~64 megapixels is refused)', async () => {
    const huge = await solid(8000, 8000).png({ compressionLevel: 9 }).toBuffer();
    expect(huge.length).toBeLessThan(5 * 1024 * 1024);
    const res = await upload(huge, { filename: 'big.png', mime: 'image/png' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too large/);
    expect(llmCalls).toBe(0);
    await scratchEmpty();
  });

  it('accepts jpeg, png and webp whatever the client calls them, and never stores the upload', async () => {
    const before = storedFiles();
    for (const buf of [await solid(16, 16).jpeg().toBuffer(), await solid(16, 16, 4).png().toBuffer(), await solid(16, 16).webp().toBuffer()]) {
      const res = await upload(buf, { filename: 'a.html', mime: 'image/jpeg' });
      expect(res.status).toBe(200);
    }
    expect(llmCalls).toBe(3);
    expect(storedFiles()).toEqual(before);
    await scratchEmpty();
  });

  it('leaves no multer scratch files behind after success or failure', async () => {
    await upload(await solid(16, 16).jpeg().toBuffer());
    await upload(Buffer.from('nope'));
    await upload(await solid(16, 16).jpeg().toBuffer(), { mime: 'text/html' });
    await scratchEmpty();
  });

  it('refuses a multipart request padded with extra fields', async () => {
    let req = api(app).post('/api/parse-label-llm').attach('image', await solid(8, 8).jpeg().toBuffer(), { filename: 'a.jpg', contentType: 'image/jpeg' });
    for (let i = 0; i < 20; i++) req = req.field(`f${i}`, 'x');
    expect((await req).status).toBe(400);
    await scratchEmpty();
  });
});

describe('only the image decoders the app needs are enabled (#60)', () => {
  it('refuses SVG, TIFF, GIF and HEIF at the libvips loader level but still reads jpeg/png/webp', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>');
    await expect(sharp(svg).metadata()).rejects.toThrow();
    await expect(sharp(await solid(4, 4).tiff().toBuffer()).metadata()).rejects.toThrow();
    await expect(sharp(await solid(4, 4).gif().toBuffer()).metadata()).rejects.toThrow();
    await expect(sharp(await solid(4, 4).heif({ compression: 'av1' }).toBuffer()).metadata()).rejects.toThrow();
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

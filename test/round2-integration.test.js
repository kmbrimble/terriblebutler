import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import './setup.js';
import { api, TEST_TOKEN } from './setup.js';
import pkg from '../server.js';
import { cleanPurchaseDate, strictFlag, ValidationError } from '../lib/domain-helpers.js';
import { purgeAbandonedImports } from '../lib/invoice-retention.js';

const { app, db } = pkg;

describe('unknown /api paths', () => {
  it.each(['get', 'post', 'put', 'patch', 'delete'])('an authenticated %s to a made-up path is a JSON 404, not the SPA', async (method) => {
    const res = await api(app)[method]('/api/no-such-thing/at/all');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  it('the bare /api prefix is also a JSON 404', async () => {
    const res = await api(app).get('/api');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
  });

  it('a real path with the wrong method is a JSON 404 too', async () => {
    const res = await api(app).delete('/api/items');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
  });

  it('unauthenticated callers get 401 for made-up and real paths alike, so existence is not disclosed', async () => {
    for (const method of ['get', 'post', 'delete']) {
      const missing = await request(app)[method]('/api/no-such-thing');
      const real = await request(app)[method]('/api/items');
      expect([missing.status, real.status], method).toEqual([401, 401]);
      expect(missing.body).toEqual(real.body);
    }
    expect((await request(app).get('/api/auth/nope')).status).toBe(401);
    expect((await request(app).post('/api/health')).status).toBe(401);
  });

  // The shell only exists once the client has been built (npm run build in client/).
  it.skipIf(!fs.existsSync(path.join(__dirname, '../client/dist/index.html')))('non-API paths still serve the SPA shell', async () => {
    const res = await request(app).get('/some/client/route');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
  });
});

describe('cleanPurchaseDate', () => {
  const now = new Date('2026-10-09T12:00:00Z');
  it('accepts a real past date and today, returning the stored timestamp form', () => {
    expect(cleanPurchaseDate('2026-01-02', now)).toBe('2026-01-02 00:00:00');
    expect(cleanPurchaseDate('2026-10-09', now)).toBe('2026-10-09 00:00:00');
    expect(cleanPurchaseDate('2000-01-01', now)).toBe('2000-01-01 00:00:00');
    expect(cleanPurchaseDate('2024-02-29', now)).toBe('2024-02-29 00:00:00');
  });
  it('blank means no date', () => {
    for (const v of [undefined, null, '', '   ']) expect(cleanPurchaseDate(v, now)).toBeNull();
  });
  it.each(['2026-02-30', '2025-02-29', '2026-13-01', '2026-00-10', '10/01/2026', 'yesterday', '2026-1-2',
    '2026-01-02 10:00:00', '2026-01-02T00:00:00Z', ' 2026-01-02x', '99999-01-01', '1999-12-31', '0000-01-01', '2026-10-11'])('rejects %j', (v) => {
    expect(() => cleanPurchaseDate(v, now)).toThrow(ValidationError);
  });
  it.each([20260102, true, ['2026-01-02'], { d: 1 }])('rejects the non-string %j', (v) => {
    expect(() => cleanPurchaseDate(v, now)).toThrow(ValidationError);
  });
  it('allows tomorrow (UTC) for a client ahead of UTC but not the day after', () => {
    expect(cleanPurchaseDate('2026-10-10', now)).toBe('2026-10-10 00:00:00');
    expect(() => cleanPurchaseDate('2026-10-11', now)).toThrow(/future/);
  });
});

describe('purchase_date on every route that accepts it', () => {
  let itemId;
  beforeAll(async () => {
    itemId = (await api(app).post('/api/items').send({ name: 'Dated item', quantity: 1 })).body.id;
  });
  const bad = ['2026-02-30', 'not a date', '2999-01-01', '1900-01-01', '2026-01-02 10:00:00'];

  it.each(bad)('POST /api/items rejects %j and creates nothing', async (purchase_date) => {
    const name = `Dated create ${purchase_date}`;
    const res = await api(app).post('/api/items').send({ name, price: 2, purchase_date });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/purchase date/i);
    expect(db.prepare('SELECT COUNT(*) AS n FROM items WHERE name = ?').get(name).n).toBe(0);
  });

  it.each(bad)('PUT /api/items/:id rejects %j and records nothing', async (purchase_date) => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM price_history WHERE item_id = ?').get(itemId).n;
    const res = await api(app).put(`/api/items/${itemId}`).send({ name: 'Dated item', reorder_threshold: 0, price: 2, purchase_date });
    expect(res.status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM price_history WHERE item_id = ?').get(itemId).n).toBe(before);
  });

  it.each(bad)('POST /api/items/:id/merge rejects %j and changes nothing', async (purchase_date) => {
    const res = await api(app).post(`/api/items/${itemId}/merge`).send({ quantity: 5, price: 2, purchase_date });
    expect(res.status).toBe(400);
    expect(db.prepare('SELECT SUM(quantity) AS q FROM item_locations WHERE item_id = ?').get(itemId).q).toBe(1);
  });

  it('a valid date is stored as the purchase time on create, update and merge', async () => {
    const created = await api(app).post('/api/items').send({ name: 'Dated ok', price: 2, purchase_date: '2026-03-04' });
    expect(created.status).toBe(201);
    await api(app).put(`/api/items/${created.body.id}`).send({ name: 'Dated ok', reorder_threshold: 0, price: 3, purchase_date: '2026-03-05' });
    await api(app).post(`/api/items/${created.body.id}/merge`).send({ quantity: 1, price: 4, purchase_date: '2026-03-06' });
    const dates = db.prepare('SELECT recorded_at FROM price_history WHERE item_id = ? ORDER BY id').all(created.body.id).map((r) => r.recorded_at);
    expect(dates).toEqual(['2026-03-04 00:00:00', '2026-03-05 00:00:00', '2026-03-06 00:00:00']);
  });

  it('a blank date still records the purchase, stamped now', async () => {
    const created = await api(app).post('/api/items').send({ name: 'Dated blank', price: 2, purchase_date: '' });
    expect(created.status).toBe(201);
    expect(db.prepare('SELECT recorded_at FROM price_history WHERE item_id = ?').get(created.body.id).recorded_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

describe('POST /api/items/:id/merge numeric rules', () => {
  let itemId;
  beforeAll(async () => {
    itemId = (await api(app).post('/api/items').send({ name: 'Merge numerics', quantity: 1 })).body.id;
  });
  const stock = () => db.prepare('SELECT SUM(quantity) AS q FROM item_locations WHERE item_id = ?').get(itemId).q;

  it.each([
    ['missing', {}, /Quantity is required/],
    ['null', { quantity: null }, /Quantity is required/],
    ['blank', { quantity: '' }, /Quantity is required/],
    ['negative', { quantity: -1 }, /Quantity must be/],
    ['non-numeric', { quantity: 'abc' }, /Quantity must be/],
    ['boolean', { quantity: true }, /Quantity must be/],
    ['array', { quantity: [1] }, /Quantity must be/],
    ['over the maximum', { quantity: 1000001 }, /Quantity must not be greater than 1000000/],
  ])('rejects a %s quantity with a 400 ValidationError message and changes nothing', async (_label, body, message) => {
    const res = await api(app).post(`/api/items/${itemId}/merge`).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
    expect(stock()).toBe(1);
  });

  it.each([-0.5, 100001, 'cheap', true])('rejects the price %j', async (price) => {
    const res = await api(app).post(`/api/items/${itemId}/merge`).send({ quantity: 1, price });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Price/);
    expect(stock()).toBe(1);
  });

  it('accepts zero quantity, no price and a null price; accepts the price maximum', async () => {
    expect((await api(app).post(`/api/items/${itemId}/merge`).send({ quantity: 0 })).status).toBe(200);
    expect((await api(app).post(`/api/items/${itemId}/merge`).send({ quantity: 0, price: null })).status).toBe(200);
    expect((await api(app).post(`/api/items/${itemId}/merge`).send({ quantity: '2', price: 100000 })).status).toBe(200);
    expect(stock()).toBe(3);
  });

  it('a database failure is a correlation-id 500, not a leaked message', async () => {
    db.exec(`CREATE TRIGGER merge_boom BEFORE INSERT ON price_history WHEN NEW.vendor = 'boom' BEGIN SELECT RAISE(ABORT, 'secret internals'); END`);
    try {
      const res = await api(app).post(`/api/items/${itemId}/merge`).send({ quantity: 1, price: 1, vendor: 'boom' });
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toMatch(/secret internals/);
      expect(res.body.correlation_id).toBeTruthy();
    } finally {
      db.exec('DROP TRIGGER merge_boom');
    }
  });
});

describe('strict boolean flags', () => {
  it('strictFlag maps only true/false/1/0', () => {
    expect([strictFlag(true, 'f'), strictFlag(1, 'f'), strictFlag(false, 'f'), strictFlag(0, 'f')]).toEqual([1, 1, 0, 0]);
    for (const v of ['true', 'false', '1', '0', 'yes', 2, -1, null, undefined, [], [1], {}, '']) {
      expect(() => strictFlag(v, 'f'), JSON.stringify(v)).toThrow(ValidationError);
    }
  });

  let itemId;
  beforeAll(async () => {
    itemId = (await api(app).post('/api/items').send({ name: 'Flag item', quantity: 2 })).body.id;
  });
  const openFlag = () => db.prepare('SELECT is_open FROM item_locations WHERE item_id = ?').get(itemId).is_open;
  const ignoreFlag = () => db.prepare('SELECT is_ignored_grocery AS f FROM items WHERE id = ?').get(itemId).f;

  it.each(['true', 'false', '0', 'yes', 2, [], {}, null])('PATCH /open rejects is_open %j and leaves the flag alone', async (is_open) => {
    const res = await api(app).patch(`/api/items/${itemId}/open`).send({ is_open });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/is_open/);
    expect(openFlag()).toBe(0);
  });

  it('PATCH /open requires the flag to be present', async () => {
    expect((await api(app).patch(`/api/items/${itemId}/open`).send({})).status).toBe(400);
    expect(openFlag()).toBe(0);
  });

  it('PATCH /open accepts true/1 and false/0', async () => {
    expect((await api(app).patch(`/api/items/${itemId}/open`).send({ is_open: true })).status).toBe(200);
    expect(openFlag()).toBe(1);
    expect((await api(app).patch(`/api/items/${itemId}/open`).send({ is_open: 0 })).status).toBe(200);
    expect(openFlag()).toBe(0);
    expect((await api(app).patch(`/api/items/${itemId}/open`).send({ is_open: 1 })).status).toBe(200);
    expect((await api(app).patch(`/api/items/${itemId}/open`).send({ is_open: false })).status).toBe(200);
    expect(openFlag()).toBe(0);
  });

  it.each(['true', '1', 'yes', 2, [], {}, null, undefined])('PATCH /ignore-grocery rejects %j', async (is_ignored_grocery) => {
    const res = await api(app).patch(`/api/items/${itemId}/ignore-grocery`).send({ is_ignored_grocery });
    expect(res.status).toBe(400);
    expect(ignoreFlag()).toBe(0);
  });

  it('PATCH /ignore-grocery accepts true/false/1/0', async () => {
    expect((await api(app).patch(`/api/items/${itemId}/ignore-grocery`).send({ is_ignored_grocery: true })).status).toBe(200);
    expect(ignoreFlag()).toBe(1);
    expect((await api(app).patch(`/api/items/${itemId}/ignore-grocery`).send({ is_ignored_grocery: 0 })).status).toBe(200);
    expect(ignoreFlag()).toBe(0);
  });
});

describe('GET /api/items/search', () => {
  beforeAll(async () => {
    const cat = (await api(app).post('/api/categories').send({ name: 'Searchable Cat' })).body.id;
    await api(app).post('/api/items').send({ name: 'Wholemeal Bread Loaf', barcode: '9300000000017', category_id: cat, quantity: 2 });
    // Direct inserts: sixty POSTs would trip the mutation rate limiter.
    const insert = db.prepare('INSERT INTO items (name) VALUES (?)');
    for (let i = 0; i < 60; i++) insert.run(`zorbulon ${String(i).padStart(2, '0')}`);
  });

  it('still matches on name (including a typo), barcode and category name', async () => {
    const byName = (await api(app).get('/api/items/search?q=Wholemeal')).body;
    expect(byName.map((i) => i.name)).toContain('Wholemeal Bread Loaf');
    expect((await api(app).get('/api/items/search?q=Wholemeel Bred')).body.map((i) => i.name)).toContain('Wholemeal Bread Loaf');
    expect((await api(app).get('/api/items/search?q=9300000000017')).body.map((i) => i.name)).toEqual(['Wholemeal Bread Loaf']);
    expect((await api(app).get('/api/items/search?q=Searchable Cat')).body.map((i) => i.name)).toContain('Wholemeal Bread Loaf');
  });

  it('returns full item rows, with quantity and locations', async () => {
    const [hit] = (await api(app).get('/api/items/search?q=9300000000017')).body;
    expect(hit).toMatchObject({ name: 'Wholemeal Bread Loaf', quantity: 2, category_name: 'Searchable Cat' });
    expect(Array.isArray(hit.locations)).toBe(true);
  });

  it('returns at most 50 results, best match first', async () => {
    const res = await api(app).get('/api/items/search?q=zorbulon');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(50);
    expect(res.body.every((i) => i.name.includes('zorbulon'))).toBe(true);
  });

  it('keeps Fuse relevance order (an exact name outranks a partial one)', async () => {
    await api(app).post('/api/items').send({ name: 'Rareword' });
    await api(app).post('/api/items').send({ name: 'Rareword with a very long extra description attached' });
    const names = (await api(app).get('/api/items/search?q=Rareword')).body.map((i) => i.name);
    expect(names[0]).toBe('Rareword');
  });

  it('blank or absent q is an empty list', async () => {
    expect((await api(app).get('/api/items/search')).body).toEqual([]);
    expect((await api(app).get('/api/items/search?q=')).body).toEqual([]);
    expect((await api(app).get('/api/items/search?q=%20%20')).body).toEqual([]);
  });

  it('rejects an over-long query and a repeated q with a 400', async () => {
    const long = await api(app).get(`/api/items/search?q=${'a'.repeat(101)}`);
    expect(long.status).toBe(400);
    expect((await api(app).get(`/api/items/search?q=${'a'.repeat(100)}`)).status).toBe(200);
    expect((await api(app).get('/api/items/search?q=a&q=b')).status).toBe(400);
  });
});

describe('abandoned invoice import retention', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.parse('2026-10-09T00:00:00Z');
  const stamp = (daysAgo) => new Date(now - daysAgo * DAY).toISOString().slice(0, 19).replace('T', ' ');
  function stage(label, daysAgo, status, key) {
    const id = db.prepare('INSERT INTO invoice_imports (retailer, invoice_number, status, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('coles', label, status, key, stamp(daysAgo)).lastInsertRowid;
    db.prepare('INSERT INTO invoice_import_lines (import_id, raw_name) VALUES (?, ?)').run(id, `${label} line`);
    return Number(id);
  }
  const exists = (id) => Boolean(db.prepare('SELECT 1 FROM invoice_imports WHERE id = ?').get(id));
  const lines = (id) => db.prepare('SELECT COUNT(*) AS n FROM invoice_import_lines WHERE import_id = ?').get(id).n;

  it('deletes uncommitted imports past the retention, with their lines, and keeps everything else', () => {
    const old = stage('old', 31, 'in_progress', 'coles|no:retention-old');
    const fresh = stage('fresh', 29, 'in_progress', 'coles|no:retention-fresh');
    const oldCommitted = stage('old-committed', 400, 'committed', 'coles|no:retention-committed');
    expect(purgeAbandonedImports(db, 30, now)).toBe(1);
    expect(exists(old)).toBe(false);
    expect(lines(old)).toBe(0);
    expect(exists(fresh)).toBe(true);
    expect(lines(fresh)).toBe(1);
    expect(exists(oldCommitted)).toBe(true);
    expect(lines(oldCommitted)).toBe(1);
  });

  it('frees the duplicate-detection key so the invoice can be imported again', () => {
    const key = 'coles|no:retention-key';
    stage('keyed', 90, 'in_progress', key);
    expect(() => stage('again', 0, 'in_progress', key)).toThrow(/UNIQUE/);
    purgeAbandonedImports(db, 30, now);
    expect(() => stage('again', 0, 'in_progress', key)).not.toThrow();
  });

  it('is idempotent and a no-op on an empty table', () => {
    purgeAbandonedImports(db, 30, now);
    expect(purgeAbandonedImports(db, 30, now)).toBe(0);
  });

  it('rolls back as a unit if the delete fails', () => {
    const id = stage('atomic', 90, 'in_progress', 'coles|no:retention-atomic');
    db.exec(`CREATE TRIGGER purge_boom BEFORE DELETE ON invoice_imports BEGIN SELECT RAISE(ABORT, 'nope'); END`);
    try {
      expect(() => purgeAbandonedImports(db, 30, now)).toThrow();
      expect(lines(id)).toBe(1);
    } finally {
      db.exec('DROP TRIGGER purge_boom');
    }
    purgeAbandonedImports(db, 30, now);
  });

  it('INVOICE_IMPORT_RETENTION_DAYS defaults to 30 (bad values: test/config-validation.test.js)', async () => {
    const config = (await import('../lib/config.js')).default;
    expect(config.INVOICE_IMPORT_RETENTION_DAYS).toBe(30);
  });
});

describe('route sweep includes the JSON 404 behind authentication', () => {
  it('a bad bearer token on a made-up path is 401, a good one is 404', async () => {
    expect((await request(app).get('/api/made-up').set('Authorization', 'Bearer nope')).status).toBe(401);
    expect((await request(app).get('/api/made-up').set('Authorization', `Bearer ${TEST_TOKEN}`)).status).toBe(404);
  });
});

describe('committing an invoice line with no price', () => {
  it('leaves the matched item’s last/lowest price and price history alone', async () => {
    const item = (await api(app).post('/api/items').send({ name: 'Unpriced match', price: 3.5, quantity: 1 })).body;
    const importId = db.prepare("INSERT INTO invoice_imports (retailer, invoice_number) VALUES ('coles', 'UNPRICED-1')").run().lastInsertRowid;
    db.prepare("INSERT INTO invoice_import_lines (import_id, raw_name, qty_supplied, unit_price, matched_item_id, line_status) VALUES (?, 'Unpriced match', 2, NULL, ?, 'reviewed')")
      .run(importId, item.id);
    const res = await api(app).post(`/api/invoices/import/${importId}/commit`);
    expect(res.status).toBe(200);
    const after = (await api(app).get(`/api/items/${item.id}/details`)).body;
    expect([after.quantity, after.last_price, after.lowest_price]).toEqual([3, 3.5, 3.5]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM price_history WHERE item_id = ?').get(item.id).n).toBe(1);
  });

  it('a new item from an unpriced line starts at no price and gets no history row', async () => {
    const importId = db.prepare("INSERT INTO invoice_imports (retailer, invoice_number) VALUES ('coles', 'UNPRICED-2')").run().lastInsertRowid;
    db.prepare("INSERT INTO invoice_import_lines (import_id, raw_name, qty_supplied, unit_price, line_status) VALUES (?, 'Brand new unpriced thing', 1, NULL, 'reviewed')").run(importId);
    expect((await api(app).post(`/api/invoices/import/${importId}/commit`)).status).toBe(200);
    const row = db.prepare("SELECT id, last_price, lowest_price FROM items WHERE name = 'Brand new unpriced thing'").get();
    expect([row.last_price, row.lowest_price]).toEqual([0, 0]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM price_history WHERE item_id = ?').get(row.id).n).toBe(0);
  });
});

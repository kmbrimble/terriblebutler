import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import request from 'supertest';
import './setup.js';
import { api } from './setup.js';
import pkg from '../server.js';

const { app, db } = pkg;

const WOOLWORTHS_PDF = path.join(process.cwd(), 'test/fixtures/invoices/woolworths-example.pdf');
const COLES_PDF = path.join(process.cwd(), 'test/fixtures/invoices/coles-example.pdf');

beforeAll(() => {
  // Unreachable on purpose: lines with no deterministic item match fall back to an LLM
  // classify call, and this proves+keeps that fallback fast/deterministic in tests by
  // failing the connection immediately rather than hitting a real model. ANTHROPIC_BASE_URL
  // is read natively by the Anthropic SDK's client construction.
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1';
});

function markAllReviewed(importId) {
  db.prepare("UPDATE invoice_import_lines SET line_status = 'reviewed' WHERE import_id = ?").run(importId);
}

describe('POST /api/invoices/import', () => {
  it('parses the Woolworths fixture into staging rows with correct values', async () => {
    const res = await api(app).post('/api/invoices/import').attach('invoice', WOOLWORTHS_PDF);
    expect(res.status).toBe(200);
    expect(res.body.import.retailer).toBe('woolworths');
    expect(res.body.import.invoice_number).toBe('310473367');
    expect(res.body.import.invoice_date).toBe('2026-07-17');
    expect(res.body.import.status).toBe('in_progress');
    expect(res.body.lines).toHaveLength(32);

    const line = res.body.lines.find((l) => l.raw_name === 'Milkybar white choc block 170g');
    expect(line).toMatchObject({
      qty_ordered: 2,
      qty_supplied: 2,
      unit_price: 3.75,
      line_total: 7.5,
      gst_applicable: 1,
      line_status: 'pending',
      matched_item_id: null,
    });
  });

  it('parses the Coles fixture into staging rows, excluding out-of-stock lines', async () => {
    const res = await api(app).post('/api/invoices/import').attach('invoice', COLES_PDF);
    expect(res.status).toBe(200);
    expect(res.body.import.retailer).toBe('coles');
    expect(res.body.lines).toHaveLength(30);
    expect(res.body.lines.map((l) => l.raw_name)).not.toContain('Coles Chocolate Dairy Dessert 12 Pack 1.2kg');
  });

  it('inherits category/location from an exact existing-item match and records matched_item_id', async () => {
    const loc = await api(app).post('/api/locations').send({ name: 'Import Test Pantry' });
    const cat = await api(app).post('/api/categories').send({ name: 'Import Test Baking' });
    const item = await api(app).post('/api/items').send({
      name: 'CADBURY BAKING CHIPS MILK CHOCOLATE 360G',
      category_id: cat.body.id,
      location_id: loc.body.id,
      quantity: 5,
    });

    const res = await api(app).post('/api/invoices/import').attach('invoice', WOOLWORTHS_PDF);
    const line = res.body.lines.find((l) => l.raw_name === 'Cadbury baking chips milk chocolate 360g');
    expect(line.matched_item_id).toBe(item.body.id);
    expect(line.suggested_category_id).toBe(cat.body.id);
    expect(line.suggested_location_id).toBe(loc.body.id);
  });

  it('deleting a category/location referenced by a staged (uncommitted) line does not FK-violate', async () => {
    const cat = await api(app).post('/api/categories').send({ name: 'FK Regression Category' });
    const loc = await api(app).post('/api/locations').send({ name: 'FK Regression Location' });
    const imported = await api(app).post('/api/invoices/import').attach('invoice', COLES_PDF);
    const importId = imported.body.import.id;
    const line = imported.body.lines[0];

    await api(app).patch(`/api/invoices/import/${importId}/lines/${line.id}`).send({
      final_category_id: cat.body.id,
      final_location_id: loc.body.id,
    });

    const delCat = await api(app).delete(`/api/categories/${cat.body.id}`);
    const delLoc = await api(app).delete(`/api/locations/${loc.body.id}`);
    expect(delCat.status).toBe(200);
    expect(delLoc.status).toBe(200);

    const persisted = db.prepare('SELECT final_category_id, final_location_id FROM invoice_import_lines WHERE id = ?').get(line.id);
    expect(persisted.final_category_id).toBeNull();
    expect(persisted.final_location_id).toBeNull();
  });

  it('returns 400 when no file is uploaded', async () => {
    const res = await api(app).post('/api/invoices/import');
    expect(res.status).toBe(400);
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request(app).post('/api/invoices/import').attach('invoice', WOOLWORTHS_PDF);
    expect(res.status).toBe(401);
  });
});

describe('GET /api/invoices/import/:id', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await request(app).get('/api/invoices/import/1');
    expect(res.status).toBe(401);
  });

  it('returns 404 for a non-existent import', async () => {
    const res = await api(app).get('/api/invoices/import/999999');
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/invoices/import/:id/lines/:lineId', () => {
  it('persists a field change so a later GET reflects it (crash-safety guarantee)', async () => {
    const imported = await api(app).post('/api/invoices/import').attach('invoice', WOOLWORTHS_PDF);
    const importId = imported.body.import.id;
    const line = imported.body.lines[0];
    const cat = await api(app).post('/api/categories').send({ name: 'Patch Test Category' });

    const patchRes = await api(app).patch(`/api/invoices/import/${importId}/lines/${line.id}`).send({
      final_category_id: cat.body.id,
      qty_confirmed: 99,
      line_status: 'reviewed',
    });
    expect(patchRes.status).toBe(200);

    const getRes = await api(app).get(`/api/invoices/import/${importId}`);
    const persisted = getRes.body.lines.find((l) => l.id === line.id);
    expect(persisted.final_category_id).toBe(cat.body.id);
    expect(persisted.qty_confirmed).toBe(99);
    expect(persisted.line_status).toBe('reviewed');
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request(app).patch('/api/invoices/import/1/lines/1').send({ line_status: 'reviewed' });
    expect(res.status).toBe(401);
  });

  it('rejects an invalid line_status', async () => {
    const imported = await api(app).post('/api/invoices/import').attach('invoice', WOOLWORTHS_PDF);
    const importId = imported.body.import.id;
    const line = imported.body.lines[0];
    const res = await api(app).patch(`/api/invoices/import/${importId}/lines/${line.id}`).send({ line_status: 'bogus' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/invoices/import/:id/commit', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await request(app).post('/api/invoices/import/1/commit');
    expect(res.status).toBe(401);
  });

  it('refuses to commit while any line is still pending', async () => {
    const imported = await api(app).post('/api/invoices/import').attach('invoice', WOOLWORTHS_PDF);
    const importId = imported.body.import.id;
    const res = await api(app).post(`/api/invoices/import/${importId}/commit`);
    expect(res.status).toBe(400);
    expect(db.prepare('SELECT status FROM invoice_imports WHERE id = ?').get(importId).status).toBe('in_progress');
  });

  it('rolls back the whole transaction on a mid-commit failure, leaving the import in_progress with no partial writes', async () => {
    const imported = await api(app).post('/api/invoices/import').attach('invoice', WOOLWORTHS_PDF);
    const importId = imported.body.import.id;
    markAllReviewed(importId);

    // Simulate a downstream constraint violation on one line, after several others in the
    // same import would have already been written. final_category_id itself has a FK to
    // categories(id), so seeding an invalid value has to briefly bypass enforcement (a
    // deleted/never-existed category slipping through some other path) — the commit
    // transaction below runs with foreign_keys back ON and must still catch it.
    // Must be a line that will actually hit the create-new-item path at commit time (a line
    // that matched an existing item never touches final_category_id) — run this before any
    // other test in the file has committed a full fixture, so most/all lines are guaranteed
    // still unmatched here rather than depending on a fixed index.
    const newLine = imported.body.lines.find((l) => l.matched_item_id === null);
    expect(newLine).toBeTruthy();
    db.pragma('foreign_keys = OFF');
    db.prepare('UPDATE invoice_import_lines SET final_category_id = ? WHERE id = ?').run(999999, newLine.id);
    db.pragma('foreign_keys = ON');

    const itemCountBefore = db.prepare('SELECT COUNT(*) AS n FROM items').get().n;
    const priceHistoryCountBefore = db.prepare('SELECT COUNT(*) AS n FROM price_history').get().n;

    const res = await api(app).post(`/api/invoices/import/${importId}/commit`);
    expect(res.status).toBe(500);

    expect(db.prepare('SELECT COUNT(*) AS n FROM items').get().n).toBe(itemCountBefore);
    expect(db.prepare('SELECT COUNT(*) AS n FROM price_history').get().n).toBe(priceHistoryCountBefore);
    expect(db.prepare('SELECT status FROM invoice_imports WHERE id = ?').get(importId).status).toBe('in_progress');
  });

  it('matches an existing item, creates new items for the rest, and keeps staging rows as a committed audit trail', async () => {
    // A distinct product from the fixture, not reused by any other test in this file — the
    // whole file shares one DB across `it()` blocks, so a name collision would cause this
    // test's exact-name match to silently land on a different test's item instead.
    const item = await api(app).post('/api/items').send({ name: 'Hillview cheese block 1kg', quantity: 5 });

    const imported = await api(app).post('/api/invoices/import').attach('invoice', WOOLWORTHS_PDF);
    const importId = imported.body.import.id;
    // Other tests in this file may have already created items that also exact-match a
    // fixture line (this file shares one DB across `it()` blocks, matching the existing
    // project convention in invoices.test.js) — compute the expected split from the staged
    // lines themselves rather than hardcoding a count, so this test doesn't depend on
    // execution order elsewhere in the file. The Hillview item created just above guarantees
    // at least one real match to assert against.
    const preMatched = imported.body.lines.filter((l) => l.matched_item_id !== null).length;
    expect(preMatched).toBeGreaterThanOrEqual(1);
    markAllReviewed(importId);

    const itemCountBefore = db.prepare('SELECT COUNT(*) AS n FROM items').get().n;

    const res = await api(app).post(`/api/invoices/import/${importId}/commit`);
    expect(res.status).toBe(200);
    expect(res.body.items_matched).toBe(preMatched);
    expect(res.body.items_added).toBe(32 - preMatched);

    const itemCountAfter = db.prepare('SELECT COUNT(*) AS n FROM items').get().n;
    expect(itemCountAfter - itemCountBefore).toBe(32 - preMatched);

    const allItems = await api(app).get('/api/items');
    const matched = allItems.body.find((i) => i.id === item.body.id);
    expect(matched.quantity).toBe(7); // 5 existing + 2 supplied on the invoice

    const newItem = allItems.body.find((i) => i.name === 'Weet-bix breakfast cereal 575g');
    expect(newItem).toBeTruthy();
    expect(newItem.quantity).toBe(4);

    const priceHistory = db.prepare('SELECT * FROM price_history WHERE item_id = ? AND vendor = ?').all(newItem.id, 'woolworths');
    expect(priceHistory.length).toBeGreaterThan(0);
    expect(priceHistory[0].price).toBe(2.5);

    const importRow = db.prepare('SELECT status FROM invoice_imports WHERE id = ?').get(importId);
    expect(importRow.status).toBe('committed');

    const stagingLines = db.prepare('SELECT * FROM invoice_import_lines WHERE import_id = ?').all(importId);
    expect(stagingLines).toHaveLength(32);
    expect(stagingLines.every((l) => l.matched_item_id !== null)).toBe(true);
  });

  it('rejects committing an already-committed import', async () => {
    const imported = await api(app).post('/api/invoices/import').attach('invoice', COLES_PDF);
    const importId = imported.body.import.id;
    markAllReviewed(importId);
    const first = await api(app).post(`/api/invoices/import/${importId}/commit`);
    expect(first.status).toBe(200);

    const second = await api(app).post(`/api/invoices/import/${importId}/commit`);
    expect(second.status).toBe(409);
  });

});

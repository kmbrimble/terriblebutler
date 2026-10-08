import { describe, it, expect, vi } from 'vitest';
import './setup.js';
import { api, clearInvoiceImports } from './setup.js';
import { loadFreshApp } from './fresh-app.js';
import path from 'path';
import pkg from '../server.js';
import { finiteNumber, QUANTITY_MAX, PRICE_MAX, ValidationError } from '../lib/domain-helpers.js';

const { app, db } = pkg;

// Numeric input rules:
//   - A quantity/amount that is required must be present: null, '' or missing is a 400
//     ("<name> is required"), never a silent 0.
//   - Optional fields have an explicit default or are nullable (see each route's test).
//   - Quantities are 0..QUANTITY_MAX, prices 0..PRICE_MAX; booleans, arrays and objects are
//     not numbers.
describe('finiteNumber', () => {
  it('requires a value unless a default or null is allowed', () => {
    for (const blank of [undefined, null, '', '   ']) {
      expect(() => finiteNumber(blank, { name: 'Amount' })).toThrow(/Amount is required/);
      expect(finiteNumber(blank, { name: 'Amount', allowNull: true })).toBeNull();
      expect(finiteNumber(blank, { name: 'Amount', defaultValue: 7 })).toBe(7);
    }
  });

  it('throws ValidationError and rejects non-numeric types', () => {
    for (const bad of [true, false, [], [5], {}, 'abc', NaN, Infinity, -1]) {
      expect(() => finiteNumber(bad, { name: 'Amount' })).toThrow(ValidationError);
    }
    expect(finiteNumber('12.5', { name: 'Amount' })).toBe(12.5);
    expect(finiteNumber(0, { name: 'Amount' })).toBe(0);
  });

  it('enforces the maximum', () => {
    expect(() => finiteNumber(PRICE_MAX + 1, { name: 'Price', max: PRICE_MAX })).toThrow(/not be greater/);
    expect(finiteNumber(PRICE_MAX, { name: 'Price', max: PRICE_MAX })).toBe(PRICE_MAX);
  });
});

describe('POST /api/items', () => {
  it('quantity and reorder_threshold are optional with an explicit default of 0', async () => {
    for (const blank of [undefined, null, '']) {
      const res = await api(app).post('/api/items').send({ name: `Default ${String(blank)}`, quantity: blank, reorder_threshold: blank });
      expect(res.status).toBe(201);
      expect(res.body.quantity).toBe(0);
      expect(res.body.reorder_threshold).toBe(0);
    }
  });

  it.each([
    [{ quantity: true }, /Quantity/],
    [{ quantity: [] }, /Quantity/],
    [{ quantity: {} }, /Quantity/],
    [{ reorder_threshold: QUANTITY_MAX + 1 }, /Reorder threshold/],
    [{ price: PRICE_MAX + 1 }, /Price/],
    [{ price: -1 }, /Price/],
  ])('rejects %j', async (extra, message) => {
    const res = await api(app).post('/api/items').send({ name: 'Bad numbers', ...extra });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
  });

  it('price is optional (no purchase record) and accepted at the maximum', async () => {
    expect((await api(app).post('/api/items').send({ name: 'No price' })).status).toBe(201);
    expect((await api(app).post('/api/items').send({ name: 'Max price', price: PRICE_MAX })).status).toBe(201);
  });
});

describe('PUT /api/items/:id', () => {
  async function make() {
    return (await api(app).post('/api/items').send({ name: `Put probe ${Math.random()}`, quantity: 1 })).body;
  }

  it('reorder_threshold is required: missing or null is a 400, not a silent reset to 0', async () => {
    const item = await make();
    for (const reorder_threshold of [undefined, null, '']) {
      const res = await api(app).put(`/api/items/${item.id}`).send({ name: item.name, reorder_threshold });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Reorder threshold is required/);
    }
  });

  it('rejects an over-maximum price', async () => {
    const item = await make();
    const res = await api(app).put(`/api/items/${item.id}`).send({ name: item.name, reorder_threshold: 0, price: PRICE_MAX + 1 });
    expect(res.status).toBe(400);
  });
});

describe('required amounts on the stock routes', () => {
  async function make() {
    return (await api(app).post('/api/items').send({ name: `Amount probe ${Math.random()}`, quantity: 5 })).body;
  }

  it.each([
    ['patch', 'quantity', { action: 'add' }],
    ['post', 'deduct', {}],
    ['patch', 'move-location', { to_location_id: 1 }],
  ])('%s /%s with a missing, null or blank amount is a 400 and changes nothing', async (method, tail, base) => {
    const item = await make();
    for (const amount of [undefined, null, '']) {
      const res = await api(app)[method](`/api/items/${item.id}/${tail}`).send({ ...base, amount });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Amount is required/);
    }
    expect(db.prepare('SELECT SUM(quantity) AS q FROM item_locations WHERE item_id = ?').get(item.id).q).toBe(5);
  });

  it('"set" to an explicit 0 is still allowed', async () => {
    const item = await make();
    const res = await api(app).patch(`/api/items/${item.id}/quantity`).send({ action: 'set', amount: 0 });
    expect(res.status).toBe(200);
    expect(res.body.quantity).toBe(0);
  });
});

describe('invoice import numeric rules', () => {
  const COLES_PDF = path.join(process.cwd(), 'test/fixtures/invoices/coles-example.pdf');

  function appWith(change) {
    return loadFreshApp({ INVOICE_IMPORT_MAX_LINES: undefined }, {
      beforeLoad(req) {
        const router = req('../parsers/router.js');
        const real = router.parseInvoice;
        router.parseInvoice = (text) => {
          const parsed = real(text);
          return { ...parsed, lines: parsed.lines.map((l, i) => (i === 0 ? { ...l, ...change } : l)) };
        };
      },
    });
  }

  it.each([
    [{ unit_price: PRICE_MAX + 1 }],
    [{ line_total: 1e12 }],
    [{ qty_supplied: 'lots' }],
  ])('rejects a parsed line with %j', async (change) => {
    const { app: fresh } = appWith(change);
    clearInvoiceImports();
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('unreachable'));
    const res = await api(fresh).post('/api/invoices/import').attach('invoice', COLES_PDF);
    expect(res.status).toBe(422);
    vi.restoreAllMocks();
  });

  it('refuses to commit a kept line that has no quantity, but a skipped one is fine', async () => {
    const { app: fresh, db: freshDb } = appWith({ qty_supplied: null });
    clearInvoiceImports();
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('unreachable'));
    const res = await api(fresh).post('/api/invoices/import').attach('invoice', COLES_PDF);
    const importId = res.body.import.id;
    freshDb.prepare("UPDATE invoice_import_lines SET line_status = 'reviewed' WHERE import_id = ?").run(importId);
    const refused = await api(fresh).post(`/api/invoices/import/${importId}/commit`);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/needs a quantity/);
    expect(freshDb.prepare('SELECT status FROM invoice_imports WHERE id = ?').get(importId).status).toBe('in_progress');
    freshDb.prepare("UPDATE invoice_import_lines SET line_status = 'skipped' WHERE import_id = ? AND qty_supplied IS NULL").run(importId);
    expect((await api(fresh).post(`/api/invoices/import/${importId}/commit`)).status).toBe(200);
    vi.restoreAllMocks();
  });

  it('a parsed line with no price or quantity is staged with nulls, not coerced to 0', async () => {
    const { app: fresh, db: freshDb } = appWith({ unit_price: null, qty_supplied: null });
    clearInvoiceImports();
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('unreachable'));
    const res = await api(fresh).post('/api/invoices/import').attach('invoice', COLES_PDF);
    expect(res.status).toBe(200);
    const row = freshDb.prepare('SELECT unit_price, qty_supplied FROM invoice_import_lines ORDER BY id LIMIT 1').get();
    expect(row).toEqual({ unit_price: null, qty_supplied: null });
    vi.restoreAllMocks();
  });
});

// Follow-ups from the independent review of 0.45: duplicate-aware matching, strict parser tokens,
// real calendar dates, the location-delete ceiling and step-up passwords never reaching the log.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import request from 'supertest';
import { PDFParse } from 'pdf-parse';
import './setup.js';
import { api, TEST_PASSWORD, TEST_TOKEN } from './setup.js';
import pkg from '../server.js';

const require = createRequire(import.meta.url);
const { findMatch } = require('../item-matching.js');
const { parseAuDate, parseMoney, parseQuantity } = require('../parsers/shared.js');
const { parseWoolworths } = require('../parsers/woolworths.js');
const { parseColes } = require('../parsers/coles.js');
const { QUANTITY_MAX } = require('../lib/domain-helpers.js');
const { currentLogFile, flush } = require('../logger.js');
const { app, db } = pkg;

describe('findMatch never picks one of several identical items for you', () => {
  const items = [
    { id: 1, name: 'Plain flour', barcode: '111' },
    { id: 2, name: 'plain  FLOUR', barcode: '111' },
    { id: 3, name: 'Sugar', barcode: '333' },
  ];

  it('two items with the same normalised name: type exact_name, no auto-applicable item, every candidate listed', () => {
    const match = findMatch(items, { barcode: null, name: 'Plain flour' }, null);
    expect(match.type).toBe('exact_name');
    expect(match.item).toBeNull();
    expect(match.candidates.map((c) => c.id)).toEqual([1, 2]);
  });

  it('two items with the same barcode: likewise', () => {
    const match = findMatch(items, { barcode: '111', name: 'anything' }, null);
    expect(match.type).toBe('barcode');
    expect(match.item).toBeNull();
    expect(match.candidates.map((c) => c.id)).toEqual([1, 2]);
  });

  it('a unique match is still the confident, auto-applicable one', () => {
    expect(findMatch(items, { barcode: null, name: 'sugar' }, null)).toMatchObject({ type: 'exact_name', item: items[2] });
    expect(findMatch(items, { barcode: '333', name: 'x' }, null)).toMatchObject({ type: 'barcode', item: items[2] });
  });
});

describe('an invoice line that matches duplicate items is a suggestion, not a merge', () => {
  it('import leaves matched_item_id empty and commit does not add the stock to the first duplicate', async () => {
    const a = (await api(app).post('/api/items').send({ name: 'Dup twin oats', quantity: 1, price: 1 })).body;
    const b = (await api(app).post('/api/items').send({ name: 'dup TWIN oats', quantity: 5, price: 1 })).body;
    const importId = db.prepare("INSERT INTO invoice_imports (retailer, status, dedupe_key) VALUES ('coles', 'in_progress', ?)").run(`dup-${Math.random()}`).lastInsertRowid;
    db.prepare("INSERT INTO invoice_import_lines (import_id, raw_name, qty_supplied, unit_price, line_status) VALUES (?, 'Dup Twin Oats', 3, 2, 'reviewed')").run(importId);
    const res = await request(app).post(`/api/invoices/import/${importId}/commit`).set('Authorization', `Bearer ${TEST_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.items_added).toBe(1); // a new item, not stock on an arbitrary one of the twins
    const qty = (id) => db.prepare('SELECT COALESCE(SUM(quantity), 0) AS q FROM item_locations WHERE item_id = ?').get(id).q;
    expect([qty(a.id), qty(b.id)]).toEqual([1, 5]);
  });

  it('but an explicit choice in the review (matched_item_id) is honoured', async () => {
    const a = (await api(app).post('/api/items').send({ name: 'Dup choice rice', quantity: 1, price: 1 })).body;
    await api(app).post('/api/items').send({ name: 'dup CHOICE rice', quantity: 5, price: 1 });
    const importId = db.prepare("INSERT INTO invoice_imports (retailer, status, dedupe_key) VALUES ('coles', 'in_progress', ?)").run(`dupc-${Math.random()}`).lastInsertRowid;
    db.prepare("INSERT INTO invoice_import_lines (import_id, raw_name, qty_supplied, unit_price, matched_item_id, line_status) VALUES (?, 'Dup Choice Rice', 3, 2, ?, 'reviewed')").run(importId, a.id);
    expect((await request(app).post(`/api/invoices/import/${importId}/commit`).set('Authorization', `Bearer ${TEST_TOKEN}`)).status).toBe(200);
    expect(db.prepare('SELECT SUM(quantity) AS q FROM item_locations WHERE item_id = ?').get(a.id).q).toBe(4);
  });
});

describe('parseAuDate accepts real calendar dates only', () => {
  it.each([['17 Jul 2026', '2026-07-17'], ['1 January 2026', '2026-01-01'], ['29 Feb 2028', '2028-02-29'], ['31 Dec 2026', '2026-12-31']])('%s -> %s', (input, expected) => {
    expect(parseAuDate(input)).toBe(expected);
  });
  it.each(['31 Feb 2026', '29 Feb 2027', '00 Jan 2026', '32 Jan 2026', '31 Apr 2026', '5 Foo 2026', ''])('%j -> null', (input) => {
    expect(parseAuDate(input)).toBeNull();
  });
});

describe('parser tokens must be plain numbers', () => {
  it.each([['12.50', 12.5], ['$12.50', 12.5], ['.5', 0.5], ['0', 0]])('parseMoney(%j) = %d', (token, value) => expect(parseMoney(token)).toBe(value));
  it.each(['1..2', '$1..2', '.', '$', '1,000', '1e3', '1abc', '', '--1', '1.2.3'])('parseMoney(%j) = null', (token) => expect(parseMoney(token)).toBeNull());
  it.each([['2', 2], ['1.5', 1.5], ['0.526 kg', 0.526], ['2ea', 2], ['3 pk', 3]])('parseQuantity(%j) = %d', (token, value) => expect(parseQuantity(token)).toBe(value));
  it.each(['1..2', '1,000', '2.', '.', 'abc', '', '1 2', '2x3', '1.2.3'])('parseQuantity(%j) = null', (token) => expect(parseQuantity(token)).toBeNull());

  it('Woolworths: a row with a malformed quantity or price is not read as a different, valid-looking row', () => {
    const good = '1 Plain flour\t2\t2\t$3.00\t$6.00';
    expect(parseWoolworths(good).lines).toHaveLength(1);
    for (const bad of ['1 Plain flour\t1..2\t2\t$3.00\t$6.00', '1 Plain flour\t2\t1,000\t$3.00\t$6.00', '1 Plain flour\t2\t2\t$3..00\t$6.00', '1 Plain flour\t2\t2\t$.\t$6.00']) {
      expect(parseWoolworths(bad).lines, bad).toHaveLength(0);
    }
  });

  it('Coles: likewise, and a bare number is not a price', () => {
    const row = (name, ordered, picked, price, total) => `Invoice number: #1\nPantry\nProduct\tOrdered\tPicked\tPrice\tTotal\n${[name, ordered, picked, price, total].join('\t')}`;
    expect(parseColes(row('Flour', '2', '2', '$3.00', '$6.00')).lines).toHaveLength(1);
    for (const bad of [row('Flour', '1..2', '1', '$3.00', '$3.00'), row('Flour', '1', '1,0', '$3.00', '$3.00'), row('Flour', '1', '1', '3.00', '$3.00'), row('Flour', '1', '1', '$3.00', '$3..00')]) {
      expect(parseColes(bad).lines, bad).toHaveLength(0);
    }
  });

  it('the real fixtures still parse completely', async () => {
    const parser = new PDFParse({ data: fs.readFileSync(path.join(process.cwd(), 'test/fixtures/invoices/woolworths-example.pdf')) });
    const { text } = await parser.getText();
    await parser.destroy();
    expect(parseWoolworths(text).lines).toHaveLength(32);
  });
});

describe('deleting a location cannot push stock past the quantity ceiling', () => {
  it('is a clear 409, and leaves the location and every stock row untouched', async () => {
    const location = (await api(app).post('/api/locations').send({ name: `Ceiling spot ${Math.random()}` })).body;
    const item = (await api(app).post('/api/items').send({ name: `Ceiling item ${Math.random()}`, price: 1, quantity: QUANTITY_MAX - 100_000, location_id: null })).body;
    db.prepare('INSERT INTO item_locations (item_id, location_id, quantity) VALUES (?, ?, 200000)').run(item.id, location.id);
    const rows = () => db.prepare('SELECT location_id, quantity FROM item_locations WHERE item_id = ? ORDER BY id').all(item.id);
    const before = rows();
    const res = await api(app).delete(`/api/locations/${location.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/maximum quantity/i);
    expect(res.body.correlation_id).toBeUndefined();
    expect(rows()).toEqual(before);
    expect(db.prepare('SELECT 1 FROM locations WHERE id = ?').get(location.id)).toBeTruthy();
  });

  it('still merges stock into the unassigned row when it fits', async () => {
    const location = (await api(app).post('/api/locations').send({ name: `Fits spot ${Math.random()}` })).body;
    const item = (await api(app).post('/api/items').send({ name: `Fits item ${Math.random()}`, price: 1, quantity: 10 })).body;
    db.prepare('INSERT INTO item_locations (item_id, location_id, quantity) VALUES (?, ?, 5)').run(item.id, location.id);
    expect((await api(app).delete(`/api/locations/${location.id}`)).status).toBe(200);
    expect(db.prepare('SELECT SUM(quantity) AS q FROM item_locations WHERE item_id = ?').get(item.id).q).toBe(15);
  });
});

describe('step-up passwords never reach the action log', () => {
  it('neither the revoke nor the sign-out-everywhere password is written, right or wrong', async () => {
    const marker = 'step-up-wrong-password-marker';
    const device = db.prepare("INSERT INTO device_tokens (token_hash, device_label) VALUES (?, 'log test')").run(`h-${Math.random()}`).lastInsertRowid;
    await api(app).post(`/api/auth/devices/${device}/revoke`).send({ password: marker });
    await api(app).post(`/api/auth/devices/${device}/revoke`).send({ password: TEST_PASSWORD });
    await api(app).post('/api/auth/revoke-all').send({ password: marker });
    await flush();
    const raw = fs.readFileSync(currentLogFile(), 'utf8');
    expect(raw).toContain('/api/auth/devices/'); // the calls were logged...
    expect(raw).not.toContain(marker); // ...without the password
    expect(raw).not.toContain(TEST_PASSWORD);
  });
});

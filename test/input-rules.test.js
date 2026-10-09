import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import Database from 'better-sqlite3';
import './setup.js';
import { api, TEST_TOKEN } from './setup.js';
import pkg from '../server.js';
import { cleanText, finiteNumber, ValidationError, QUANTITY_MAX } from '../lib/domain-helpers.js';
import request from 'supertest';

const nodeRequire = createRequire(import.meta.url);
const { app, db } = pkg;

describe('cleanText accepts text only', () => {
  it.each([[['x']], [{ a: 1 }], [123], [true], [[]], [{ toString: () => 'x' }]])('rejects %j instead of coercing it', (bad) => {
    expect(() => cleanText(bad)).toThrow(ValidationError);
    expect(() => cleanText(bad, { required: true })).toThrow(ValidationError);
  });

  it('still reads undefined/null as empty, trims, and enforces required and max', () => {
    expect(cleanText(undefined)).toBe('');
    expect(cleanText(null)).toBe('');
    expect(cleanText('  hi  ')).toBe('hi');
    expect(() => cleanText('', { required: true })).toThrow(/required/);
    expect(() => cleanText('x'.repeat(11), { max: 10 })).toThrow(/10 character/);
  });

  it('turns control characters into spaces so a value cannot carry a line break', () => {
    expect(cleanText('a\nb\r\nc\u0000d\u001be\u0085f')).toBe('a b  c d e f');
  });
});

describe('text fields reject non-strings over the API', () => {
  it.each([
    ['name', ['Milk']], ['name', { a: 1 }], ['container_details', ['1L']], ['vendor', ['Coles']], ['vendor', { a: 1 }],
  ])('POST /api/items with %s = %j is a 400, nothing is stored', async (field, value) => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM items').get().n;
    const res = await api(app).post('/api/items').send({ name: 'Valid name', quantity: 1, price: 1, [field]: value });
    expect(res.status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM items').get().n).toBe(before);
  });

  it('device_label as an array is a 400', async () => {
    const res = await api(app).post('/api/auth/device-token').send({ device_label: ['phone'] });
    expect(res.status).toBe(400);
    expect(db.prepare("SELECT COUNT(*) AS n FROM device_tokens WHERE device_label = 'phone'").get().n).toBe(0);
  });

  it('a string device_label is still accepted', async () => {
    const res = await api(app).post('/api/auth/device-token').send({ device_label: 'Kitchen tablet' });
    expect(res.status).toBe(200);
  });
});

describe('finiteNumber accepts plain decimals only', () => {
  it.each(['0x10', '0X1F', '1e3', '1E3', '1e-2', '0b101', '0o7', 'Infinity', '-Infinity', 'NaN', '1_000', '1,000', '0x', ' 0x10 ', '１２'])('rejects the string %j', (bad) => {
    expect(() => finiteNumber(bad, { name: 'Amount' })).toThrow(ValidationError);
  });

  it.each([['12', 12], ['12.5', 12.5], ['.5', 0.5], ['5.', 5], [' 7 ', 7], ['+3', 3], ['0', 0], ['007', 7], [4, 4], [0.25, 0.25]])('accepts %j as %d', (good, expected) => {
    expect(finiteNumber(good, { name: 'Amount' })).toBe(expected);
  });

  it('still honours min, and a negative decimal is not read as a hex/exponent form', () => {
    expect(() => finiteNumber('-1', { name: 'Amount' })).toThrow(/not less than 0/);
    expect(finiteNumber('-1.5', { name: 'Amount', min: -10 })).toBe(-1.5);
  });

  it('a hex string no longer slips into a quantity through the API', async () => {
    const res = await api(app).post('/api/items').send({ name: 'Hex qty', quantity: '0x10', price: 1 });
    expect(res.status).toBe(400);
  });
});

describe('quantity cap', () => {
  const makeItem = async (quantity) => (await api(app).post('/api/items').send({ name: `Cap ${Math.random()}`, quantity, price: 1 })).body;

  it('refuses an add that would take a location past QUANTITY_MAX, and leaves the quantity unchanged', async () => {
    const item = await makeItem(QUANTITY_MAX - 5);
    const res = await api(app).patch(`/api/items/${item.id}/quantity`).send({ action: 'add', amount: 10 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/maximum quantity/i);
    const after = (await api(app).get(`/api/items/${item.id}/details`)).body;
    expect(after.quantity).toBe(QUANTITY_MAX - 5);
    // exactly reaching the cap is fine
    expect((await api(app).patch(`/api/items/${item.id}/quantity`).send({ action: 'add', amount: 5 })).status).toBeLessThan(300);
    expect((await api(app).get(`/api/items/${item.id}/details`)).body.quantity).toBe(QUANTITY_MAX);
  });

  it('the database itself refuses a raw write above the cap (trigger), for insert and increase', () => {
    const item = db.prepare("INSERT INTO items (name) VALUES ('Trigger item')").run();
    const id = Number(item.lastInsertRowid);
    expect(() => db.prepare('INSERT INTO item_locations (item_id, location_id, quantity) VALUES (?, NULL, ?)').run(id, QUANTITY_MAX + 1)).toThrow(/must not exceed/);
    db.prepare('INSERT INTO item_locations (item_id, location_id, quantity) VALUES (?, NULL, ?)').run(id, QUANTITY_MAX);
    expect(() => db.prepare('UPDATE item_locations SET quantity = quantity + 1 WHERE item_id = ?').run(id)).toThrow(/must not exceed/);
  });

  it('a legacy row already above the cap can still be reduced (the trigger only blocks increases)', () => {
    const tmp = path.join(os.tmpdir(), `butler-legacy-${process.pid}-${Date.now()}.db`);
    const legacy = new Database(tmp);
    legacy.exec('CREATE TABLE item_locations (id INTEGER PRIMARY KEY, item_id INTEGER, location_id INTEGER, quantity REAL, is_open INTEGER DEFAULT 0)');
    legacy.prepare('INSERT INTO item_locations (item_id, quantity) VALUES (1, ?)').run(QUANTITY_MAX * 3);
    legacy.exec(nodeRequire('../db-migrations').QUANTITY_GUARD_SQL);
    legacy.prepare('UPDATE item_locations SET quantity = ?').run(QUANTITY_MAX * 2);
    expect(() => legacy.prepare('UPDATE item_locations SET quantity = ?').run(QUANTITY_MAX * 2 + 1)).toThrow(/must not exceed/);
    legacy.close();
    fs.rmSync(tmp, { force: true });
  });

  it('an invoice commit that would pass the cap is refused whole (400), adding nothing', async () => {
    const item = await makeItem(QUANTITY_MAX - 1);
    const info = db.prepare("INSERT INTO invoice_imports (retailer, status, dedupe_key) VALUES ('coles', 'in_progress', ?)").run(`cap-${Math.random()}`);
    const importId = Number(info.lastInsertRowid);
    db.prepare(`INSERT INTO invoice_import_lines (import_id, raw_name, qty_supplied, unit_price, matched_item_id, line_status)
                VALUES (?, 'Cap line', 50, 1, ?, 'reviewed')`).run(importId, item.id);
    const res = await request(app).post(`/api/invoices/import/${importId}/commit`).set('Authorization', `Bearer ${TEST_TOKEN}`);
    expect(res.status).toBe(400);
    expect(db.prepare('SELECT status FROM invoice_imports WHERE id = ?').get(importId).status).toBe('in_progress');
    expect((await api(app).get(`/api/items/${item.id}/details`)).body.quantity).toBe(QUANTITY_MAX - 1);
  });
});

describe('openDatabase creates only the DB_PATH directory', () => {
  const { openDatabase } = nodeRequire('../lib/database');
  const repoData = path.join(import.meta.dirname, '..', 'data');

  it('never asks for <repo>/data when DB_PATH points elsewhere (independent of whether that directory already exists)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-opendb-'));
    const nested = path.join(dir, 'a', 'b', 'inventory.db');
    const saved = process.env.DB_PATH;
    process.env.DB_PATH = nested;
    const mkdir = vi.spyOn(fs, 'mkdirSync');
    try {
      const { db: opened, dbPath } = openDatabase();
      opened.close();
      expect(dbPath).toBe(nested);
      expect(fs.existsSync(nested)).toBe(true);
      const created = mkdir.mock.calls.map(([target]) => path.resolve(String(target)));
      expect(created).toEqual([path.dirname(nested)]);
      expect(created).not.toContain(path.resolve(repoData));
    } finally {
      mkdir.mockRestore();
      process.env.DB_PATH = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('counsel follow-ups (round 3 review)', () => {
  it('an unpriced matched invoice line still advances the item\'s updated_at', async () => {
    const item = (await api(app).post('/api/items').send({ name: `Updated at ${Math.random()}`, price: 2, quantity: 1 })).body;
    db.prepare("UPDATE items SET updated_at = '2001-01-01 00:00:00' WHERE id = ?").run(item.id);
    const importId = db.prepare("INSERT INTO invoice_imports (retailer, status, dedupe_key) VALUES ('coles', 'in_progress', ?)").run(`upd-${Math.random()}`).lastInsertRowid;
    db.prepare("INSERT INTO invoice_import_lines (import_id, raw_name, qty_supplied, unit_price, matched_item_id, line_status) VALUES (?, 'Unpriced', 2, NULL, ?, 'reviewed')").run(importId, item.id);
    const res = await request(app).post(`/api/invoices/import/${importId}/commit`).set('Authorization', `Bearer ${TEST_TOKEN}`);
    expect(res.status).toBe(200);
    expect(db.prepare('SELECT updated_at FROM items WHERE id = ?').get(item.id).updated_at).not.toBe('2001-01-01 00:00:00');
    expect((await api(app).get(`/api/items/${item.id}/details`)).body.last_price).toBe(2); // price still untouched
  });

  it('item_locations has a plain item_id index, and the item lookup uses an index', () => {
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT SUM(quantity) FROM item_locations WHERE item_id = ?').all(1).map((r) => r.detail).join(' ');
    expect(plan).toMatch(/idx_item_locations_item_id|idx_item_locations_unique/);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_item_locations_item_id'").get()).toBeTruthy();
  });
});

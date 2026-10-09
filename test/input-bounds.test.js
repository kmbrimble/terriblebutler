// Every route that feeds user text into the fuzzy matcher, a regex or an LLM prompt is bounded.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';
import './setup.js';
import { api } from './setup.js';
import pkg from '../server.js';

const nodeRequire = createRequire(import.meta.url);
const { findMatch, resolveNamedMatch, FUZZY_QUERY_MAX } = nodeRequire('../item-matching.js');
const Fuse = nodeRequire('fuse.js');
const { NAME_LIST_MAX } = nodeRequire('../lib/domain-helpers.js');
const { app, db } = pkg;
afterEach(() => vi.restoreAllMocks());

describe('GET /api/items/match is bounded like /search', () => {
  const match = (query) => api(app).get('/api/items/match').query(query);

  it('rejects a name over 200 characters and a barcode over 128 with a 400, without searching', async () => {
    const search = vi.spyOn(Fuse.prototype, 'search');
    const long = await match({ name: 'x'.repeat(15000) });
    expect(long.status).toBe(400);
    expect(long.body.error).toMatch(/at most 200/);
    expect((await match({ name: 'ok', barcode: '9'.repeat(129) })).status).toBe(400);
    expect(search).not.toHaveBeenCalled();
  });

  it('accepts the limits exactly', async () => {
    expect((await match({ name: 'x'.repeat(200), barcode: '9'.repeat(128) })).status).toBe(200);
  });

  it('rejects repeated values (they would otherwise be joined into one long string)', async () => {
    expect((await api(app).get('/api/items/match?name=a&name=b')).status).toBe(400);
    expect((await api(app).get('/api/items/match?barcode=1&barcode=2')).status).toBe(400);
  });

  it('still finds duplicates (exact, barcode and fuzzy) as before', async () => {
    await api(app).post('/api/items').send({ name: 'Bounds test oat milk', barcode: '5012345678900', quantity: 1, price: 1 });
    expect((await match({ name: 'bounds test oat milk' })).body.type).toBe('exact_name');
    expect((await match({ name: 'x', barcode: '5012345678900' })).body.type).toBe('barcode');
    expect((await match({ name: 'Bounds test oat mil' })).body.type).toBe('fuzzy');
    expect((await match({})).body.type).toBeNull();
  });

  it('GET /api/items/barcode/:barcode caps the barcode length', async () => {
    expect((await api(app).get(`/api/items/barcode/${'9'.repeat(129)}`)).status).toBe(400);
    expect((await api(app).get(`/api/items/barcode/${'9'.repeat(128)}`)).status).toBe(404);
  });
});

describe('every fuzzy search clips its pattern', () => {
  it('findMatch and resolveNamedMatch never hand Fuse more than FUZZY_QUERY_MAX characters', () => {
    const items = [{ id: 1, name: 'Milk' }];
    const fuse = new Fuse(items, { keys: ['name'], threshold: 0.3 });
    const search = vi.spyOn(fuse, 'search');
    findMatch(items, { barcode: null, name: 'm'.repeat(5000) }, fuse);
    resolveNamedMatch(items, 'm'.repeat(5000), fuse);
    expect(search).toHaveBeenCalledTimes(2);
    for (const [pattern] of search.mock.calls) expect(pattern.length).toBeLessThanOrEqual(FUZZY_QUERY_MAX);
  });

  it('a 500-character invoice description costs one clipped search, not a 500-character one', () => {
    const items = Array.from({ length: 2000 }, (_, i) => ({ id: i, name: `Product ${i} with some words ${i * 7919 % 1000}` }));
    const fuse = new Fuse(items, { keys: ['name'], threshold: 0.3 });
    const started = Date.now();
    findMatch(items, { barcode: null, name: 'cola zero sugar '.repeat(32) }, fuse);
    expect(Date.now() - started).toBeLessThan(300); // 500 characters unclipped took ~370 ms on 2,000 items
  });
});

describe('category and location lists that go into LLM prompts have a ceiling', () => {
  it.each([['categories', 'Category'], ['locations', 'Location']])('POST /api/%s refuses the %s past the cap with a 409', async (table) => {
    const have = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    const insert = db.prepare(`INSERT INTO ${table} (name) VALUES (?)`);
    db.transaction(() => { for (let i = have; i < NAME_LIST_MAX; i++) insert.run(`Filler ${table} ${i}`); })();
    try {
      const refused = await api(app).post(`/api/${table}`).send({ name: `One too many ${table}` });
      expect(refused.status).toBe(409);
      expect(refused.body.error).toMatch(new RegExp(`at most ${NAME_LIST_MAX}`));
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n).toBe(NAME_LIST_MAX);
    } finally {
      db.prepare(`DELETE FROM ${table} WHERE name LIKE 'Filler ${table} %'`).run();
    }
    expect((await api(app).post(`/api/${table}`).send({ name: `Fits again ${table}` })).status).toBe(201);
  });
});

import { describe, it, expect, beforeAll } from 'vitest';
import './setup.js';
import pkg from '../server.js';
import { applyStocktake } from '../scripts/apply-stocktake.js';

const { db } = pkg;

let pantry, fridge;

beforeAll(() => {
  pantry = db.prepare('INSERT INTO locations (name) VALUES (?)').run('Pantry Test').lastInsertRowid;
  fridge = db.prepare('INSERT INTO locations (name) VALUES (?)').run('Fridge Test').lastInsertRowid;
});

function getItem(name) {
  return db.prepare('SELECT * FROM items WHERE name = ?').get(name);
}
function getLocations(itemId) {
  return db.prepare('SELECT * FROM item_locations WHERE item_id = ?').all(itemId);
}

describe('applyStocktake', () => {
  it('inserts a new item with a single location', () => {
    const stocktake = [
      { name: 'Stock Rice', open: false, reorder_threshold: 2, ignored: false,
        locations: [{ location: 'Pantry Test', container: '1kg', qty: 5 }] },
    ];
    const result = applyStocktake(db, stocktake, { dryRun: false });
    expect(result.inserted).toBe(1);
    expect(result.updated).toBe(0);

    const item = getItem('Stock Rice');
    expect(item.container_details).toBe('1kg');
    expect(item.reorder_threshold).toBe(2);
    expect(item.is_ignored_grocery).toBe(0);

    const locs = getLocations(item.id);
    expect(locs).toHaveLength(1);
    expect(locs[0]).toMatchObject({ location_id: pantry, quantity: 5, is_open: 0 });
  });

  it('updates an existing item: overwrites threshold/ignore/named-location quantity, leaves other fields and out-of-scope locations alone', () => {
    const created = db.prepare(`INSERT INTO items (name, container_details, reorder_threshold, is_ignored_grocery) VALUES (?, ?, ?, ?)`)
      .run('Stock Bacon', 'Large', 0, 0);
    const itemId = Number(created.lastInsertRowid);
    db.prepare('INSERT INTO item_locations (item_id, location_id, quantity, is_open) VALUES (?, ?, ?, ?)').run(itemId, fridge, 9, 0);

    const stocktake = [
      { name: 'Stock Bacon', open: true, reorder_threshold: 3, ignored: true,
        locations: [{ location: 'Pantry Test', container: 'packet', qty: 2 }] },
    ];
    const result = applyStocktake(db, stocktake, { dryRun: false });
    expect(result.updated).toBe(1);
    expect(result.inserted).toBe(0);

    const item = getItem('Stock Bacon');
    expect(item.reorder_threshold).toBe(3);
    expect(item.is_ignored_grocery).toBe(1);
    expect(item.container_details).toBe('Large'); // untouched on update

    const locs = getLocations(itemId);
    const byLoc = Object.fromEntries(locs.map((l) => [l.location_id, l]));
    expect(byLoc[pantry]).toMatchObject({ quantity: 2, is_open: 1 }); // new row for the stocktake location
    expect(byLoc[fridge]).toMatchObject({ quantity: 9, is_open: 0 }); // out-of-scope row untouched
  });

  it('multi-location item: joins distinct containers with " / " and sets is_open on every location', () => {
    const stocktake = [
      { name: 'Stock Onion Powder', open: true, reorder_threshold: 0, ignored: false,
        locations: [
          { location: 'Pantry Test', container: 'large jar', qty: 1 },
          { location: 'Fridge Test', container: 'small jar', qty: 2 },
        ] },
    ];
    const result = applyStocktake(db, stocktake, { dryRun: false });
    expect(result.inserted).toBe(1);

    const item = getItem('Stock Onion Powder');
    expect(item.container_details).toBe('large jar / small jar');

    const locs = getLocations(item.id);
    expect(locs).toHaveLength(2);
    expect(locs.every((l) => l.is_open === 1)).toBe(true);
  });

  it('dry run writes nothing', () => {
    const stocktake = [
      { name: 'Stock Nowrite', open: false, reorder_threshold: 0, ignored: false,
        locations: [{ location: 'Pantry Test', container: '', qty: 1 }] },
    ];
    const result = applyStocktake(db, stocktake, { dryRun: true });
    expect(result.inserted).toBe(1); // reported as if it happened...
    expect(getItem('Stock Nowrite')).toBeUndefined(); // ...but nothing was persisted
  });

  it('is idempotent: re-running the same stocktake does not duplicate items or location rows', () => {
    const stocktake = [
      { name: 'Stock Idempotent', open: false, reorder_threshold: 1, ignored: false,
        locations: [{ location: 'Pantry Test', container: '2L', qty: 4 }] },
    ];
    applyStocktake(db, stocktake, { dryRun: false });
    const second = applyStocktake(db, stocktake, { dryRun: false });
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(1);

    const item = getItem('Stock Idempotent');
    const locs = getLocations(item.id);
    expect(locs).toHaveLength(1);
    expect(locs[0].quantity).toBe(4);
  });

  it('refuses to run at all when a stocktake name ambiguously matches more than one existing item', () => {
    db.prepare('INSERT INTO items (name) VALUES (?)').run('Stock Dupe');
    db.prepare('INSERT INTO items (name) VALUES (?)').run('Stock Dupe');

    const stocktake = [
      { name: 'Stock Dupe', open: false, reorder_threshold: 0, ignored: false,
        locations: [{ location: 'Pantry Test', container: '', qty: 1 }] },
    ];
    expect(() => applyStocktake(db, stocktake, { dryRun: false })).toThrow(/Ambiguous match/);
  });

  it('refuses to run when the input file itself has the same name twice, rather than double-inserting', () => {
    const stocktake = [
      { name: 'Stock Duplicate Input', open: false, reorder_threshold: 0, ignored: false,
        locations: [{ location: 'Pantry Test', container: '', qty: 1 }] },
      { name: 'Stock Duplicate Input', open: false, reorder_threshold: 0, ignored: false,
        locations: [{ location: 'Fridge Test', container: '', qty: 2 }] },
    ];
    expect(() => applyStocktake(db, stocktake, { dryRun: false })).toThrow(/Duplicate stocktake entry/);
    expect(getItem('Stock Duplicate Input')).toBeUndefined();
  });

  it('refuses to run when a stocktake location does not exist', () => {
    const stocktake = [
      { name: 'Stock Unknown Loc', open: false, reorder_threshold: 0, ignored: false,
        locations: [{ location: 'Nonexistent Shed', container: '', qty: 1 }] },
    ];
    expect(() => applyStocktake(db, stocktake, { dryRun: false })).toThrow(/Unknown location/);
    expect(getItem('Stock Unknown Loc')).toBeUndefined();
  });
});

import { describe, it, expect, beforeAll } from 'vitest';
import './setup.js';
import { api } from './setup.js';
import pkg from '../server.js';

const { app, db } = pkg;

let locA, locB;

beforeAll(async () => {
  locA = (await api(app).post('/api/locations').send({ name: 'Merge Pantry' })).body.id;
  locB = (await api(app).post('/api/locations').send({ name: 'Merge Garage' })).body.id;
});

async function multiLocationItem(name) {
  const created = await api(app).post('/api/items').send({ name, location_id: locA, quantity: 4 });
  await api(app).patch(`/api/items/${created.body.id}/quantity`).send({ amount: 3, action: 'add', location_id: locB });
  return created.body.id;
}

describe('deduct on a multi-location item (#45)', () => {
  it('omitting the location is a 400 that tells the user a location is required', async () => {
    const id = await multiLocationItem('Deduct ambiguous');
    const res = await api(app).post(`/api/items/${id}/deduct`).send({ amount: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/location/i);
  });

  it('naming the unassigned bucket when the item has no stock there says so, not "Insufficient quantity"', async () => {
    const id = await multiLocationItem('Deduct unassigned');
    const res = await api(app).post(`/api/items/${id}/deduct`).send({ amount: 1, location_id: null });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no stock at that location/i);
  });

  it('a location that holds too little is still reported as insufficient', async () => {
    const id = await multiLocationItem('Deduct short');
    const res = await api(app).post(`/api/items/${id}/deduct`).send({ amount: 99, location_id: locA });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/insufficient/i);
  });
});

describe('POST /api/items/:id/merge (#50)', () => {
  it('adds the quantity AND records the purchase, recalculating prices', async () => {
    const created = await api(app).post('/api/items').send({ name: 'Merge target', location_id: locA, quantity: 2 });
    const id = created.body.id;
    const res = await api(app).post(`/api/items/${id}/merge`).send({
      quantity: 3, location_id: locA, price: 4.5, vendor: 'Corner Shop', purchase_date: '2026-01-02 00:00:00',
    });
    expect(res.status).toBe(200);
    expect(res.body.quantity).toBe(5);
    expect(res.body.last_price).toBe(4.5);
    expect(res.body.lowest_price).toBe(4.5);
    const rows = db.prepare('SELECT price, vendor, recorded_at FROM price_history WHERE item_id = ?').all(id);
    expect(rows).toEqual([{ price: 4.5, vendor: 'Corner Shop', recorded_at: '2026-01-02 00:00:00' }]);
  });

  it('merges quantity only when no price is given, and adds to a new location', async () => {
    const id = (await api(app).post('/api/items').send({ name: 'Merge qty only', location_id: locA, quantity: 1 })).body.id;
    const res = await api(app).post(`/api/items/${id}/merge`).send({ quantity: 2, location_id: locB });
    expect(res.status).toBe(200);
    expect(res.body.locations).toHaveLength(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM price_history WHERE item_id = ?').get(id).n).toBe(0);
  });

  it('with location_id omitted, lands in the item\'s only location (no Unassigned bucket)', async () => {
    const id = (await api(app).post('/api/items').send({ name: 'Merge infer', location_id: locA, quantity: 1 })).body.id;
    const res = await api(app).post(`/api/items/${id}/merge`).send({ quantity: 2 });
    expect(res.status).toBe(200);
    expect(res.body.locations).toEqual([expect.objectContaining({ location_id: locA, quantity: 3 })]);
  });

  it('is atomic: an invalid price rejects the whole request and changes nothing', async () => {
    const id = (await api(app).post('/api/items').send({ name: 'Merge atomic', location_id: locA, quantity: 1 })).body.id;
    const res = await api(app).post(`/api/items/${id}/merge`).send({ quantity: 5, location_id: locA, price: -3 });
    expect(res.status).toBe(400);
    const item = (await api(app).get('/api/items')).body.find((i) => i.id === id);
    expect(item.quantity).toBe(1);
  });

  it('rolls back the quantity if recording the purchase fails mid-transaction', async () => {
    const id = (await api(app).post('/api/items').send({ name: 'Merge rollback', location_id: locA, quantity: 1 })).body.id;
    db.exec(`CREATE TEMP TRIGGER fail_ph BEFORE INSERT ON price_history WHEN NEW.vendor = 'BOOM' BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    try {
      const res = await api(app).post(`/api/items/${id}/merge`).send({ quantity: 5, location_id: locA, price: 2, vendor: 'BOOM' });
      expect(res.status).toBeGreaterThanOrEqual(400);
    } finally {
      db.exec('DROP TRIGGER fail_ph');
    }
    const item = (await api(app).get('/api/items')).body.find((i) => i.id === id);
    expect(item.quantity).toBe(1);
  });

  it('404s for an unknown item and 400s for an ambiguous location', async () => {
    expect((await api(app).post('/api/items/999999/merge').send({ quantity: 1 })).status).toBe(404);
    const id = await multiLocationItem('Merge ambiguous');
    const res = await api(app).post(`/api/items/${id}/merge`).send({ quantity: 1 });
    expect(res.status).toBe(400);
  });
});

import { describe, it, expect, beforeAll } from 'vitest';
import './setup.js';
import { api } from './setup.js';
import pkg from '../server.js';

const { app } = pkg;

let locA, locB;

beforeAll(async () => {
  const resA = await api(app).post('/api/locations').send({ name: 'Pantry Test' });
  const resB = await api(app).post('/api/locations').send({ name: 'Garage Test' });
  locA = resA.body.id;
  locB = resB.body.id;
});

describe('Multi-location stock', () => {
  it('POST /api/items creates one item_locations row for the initial location', async () => {
    const created = await api(app).post('/api/items').send({ name: 'Rice 1kg', location_id: locA, quantity: 3 });
    expect(created.status).toBe(201);

    const item = (await api(app).get('/api/items')).body.find((i) => i.id === created.body.id);
    expect(item.quantity).toBe(3);
    expect(item.locations).toEqual([{ location_id: locA, location_name: 'Pantry Test', quantity: 3, is_open: 0 }]);
  });

  it('PATCH quantity "add" to a new location creates a second item_locations row without touching the first', async () => {
    const created = await api(app).post('/api/items').send({ name: 'Pasta 500g', location_id: locA, quantity: 2 });
    const id = created.body.id;

    const res = await api(app).patch(`/api/items/${id}/quantity`).send({ amount: 4, action: 'add', location_id: locB });
    expect(res.status).toBe(200);

    const item = (await api(app).get('/api/items')).body.find((i) => i.id === id);
    expect(item.quantity).toBe(6);
    const byLocation = Object.fromEntries(item.locations.map((l) => [l.location_id, l.quantity]));
    expect(byLocation[locA]).toBe(2);
    expect(byLocation[locB]).toBe(4);
  });

  it('PATCH quantity "add" to an existing location increments that row', async () => {
    const created = await api(app).post('/api/items').send({ name: 'Flour 1kg', location_id: locA, quantity: 1 });
    const id = created.body.id;

    await api(app).patch(`/api/items/${id}/quantity`).send({ amount: 5, action: 'add', location_id: locA });

    const item = (await api(app).get('/api/items')).body.find((i) => i.id === id);
    expect(item.quantity).toBe(6);
    expect(item.locations).toHaveLength(1);
  });

  it('subtracting more than a specific location holds fails with 409, even if another location has plenty', async () => {
    const created = await api(app).post('/api/items').send({ name: 'Sugar 1kg', location_id: locA, quantity: 1 });
    const id = created.body.id;
    await api(app).patch(`/api/items/${id}/quantity`).send({ amount: 100, action: 'add', location_id: locB });

    const res = await api(app).patch(`/api/items/${id}/quantity`).send({ amount: 5, action: 'subtract', location_id: locA });
    expect(res.status).toBe(409);

    const item = (await api(app).get('/api/items')).body.find((i) => i.id === id);
    expect(item.quantity).toBe(101);
  });

  it('quantity endpoints infer the location automatically when the item has stock in exactly one', async () => {
    const created = await api(app).post('/api/items').send({ name: 'Oats 750g', location_id: locA, quantity: 2 });
    const id = created.body.id;

    const res = await api(app).patch(`/api/items/${id}/quantity`).send({ amount: 1, action: 'add' });
    expect(res.status).toBe(200);

    const item = (await api(app).get('/api/items')).body.find((i) => i.id === id);
    expect(item.quantity).toBe(3);
  });

  it('POST deduct is location-scoped the same way as the quantity endpoint', async () => {
    const created = await api(app).post('/api/items').send({ name: 'Tea Bags', location_id: locA, quantity: 10 });
    const id = created.body.id;
    await api(app).patch(`/api/items/${id}/quantity`).send({ amount: 1, action: 'add', location_id: locB });

    const insufficient = await api(app).post(`/api/items/${id}/deduct`).send({ amount: 5, location_id: locB });
    expect(insufficient.status).toBe(409);

    const ok = await api(app).post(`/api/items/${id}/deduct`).send({ amount: 5, location_id: locA });
    expect(ok.status).toBe(200);

    const item = (await api(app).get('/api/items')).body.find((i) => i.id === id);
    expect(item.quantity).toBe(6);
  });

  it('the reorder threshold is compared against the TOTAL across all locations', async () => {
    const created = await api(app).post('/api/items').send({ name: 'Canned Corn', location_id: locA, quantity: 2, reorder_threshold: 5 });
    const id = created.body.id;
    await api(app).patch(`/api/items/${id}/quantity`).send({ amount: 2, action: 'add', location_id: locB });

    let grocery = (await api(app).get('/api/grocery-list')).body;
    expect(grocery.some((i) => i.id === id)).toBe(true); // 2 + 2 = 4 <= 5

    await api(app).patch(`/api/items/${id}/quantity`).send({ amount: 10, action: 'add', location_id: locA });
    grocery = (await api(app).get('/api/grocery-list')).body;
    expect(grocery.some((i) => i.id === id)).toBe(false); // 12 + 2 = 14 > 5
  });

  it('GET /api/items/match reports the aggregate quantity across locations for a candidate', async () => {
    const created = await api(app).post('/api/items').send({ name: 'Honey Jar', location_id: locA, quantity: 1 });
    await api(app).patch(`/api/items/${created.body.id}/quantity`).send({ amount: 2, action: 'add', location_id: locB });

    const res = await api(app).get('/api/items/match').query({ name: 'Honey Jar' });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('exact_name');
    expect(res.body.candidates[0].quantity).toBe(3);
  });

  it('deleting a location reassigns its stock to the unassigned bucket instead of losing it', async () => {
    const tempLoc = await api(app).post('/api/locations').send({ name: 'Temp Shed' });
    const created = await api(app).post('/api/items').send({ name: 'Motor Oil', location_id: tempLoc.body.id, quantity: 4 });

    await api(app).delete(`/api/locations/${tempLoc.body.id}`);

    const item = (await api(app).get('/api/items')).body.find((i) => i.id === created.body.id);
    expect(item.quantity).toBe(4);
    expect(item.locations).toEqual([{ location_id: null, location_name: null, quantity: 4, is_open: 0 }]);
  });

  it('deleting a location merges into an existing unassigned row rather than violating the unique index', async () => {
    const tempLoc = await api(app).post('/api/locations').send({ name: 'Temp Garage' });
    const otherLoc = await api(app).post('/api/locations').send({ name: 'Other Shed' });
    const created = await api(app).post('/api/items').send({ name: 'WD-40', location_id: tempLoc.body.id, quantity: 3 });
    // Give the item stock at a second real location too, so it now has >1 row and an
    // explicit location_id: '' can't be satisfied by the "only one row" inference shortcut.
    await api(app).patch(`/api/items/${created.body.id}/quantity`).send({ amount: 1, action: 'add', location_id: otherLoc.body.id });
    // Now give it some pre-existing unassigned stock too (explicit null bucket).
    const addUnassigned = await api(app).patch(`/api/items/${created.body.id}/quantity`).send({ amount: 2, action: 'add', location_id: '' });
    expect(addUnassigned.status).toBe(200);
    const midway = (await api(app).get('/api/items')).body.find((i) => i.id === created.body.id);
    expect(midway.locations).toHaveLength(3); // tempLoc(3), otherLoc(1), unassigned(2)

    const deleteRes = await api(app).delete(`/api/locations/${tempLoc.body.id}`);
    expect(deleteRes.status).toBe(200);

    const item = (await api(app).get('/api/items')).body.find((i) => i.id === created.body.id);
    expect(item.locations).toHaveLength(2); // otherLoc(1), unassigned(3+2=5)
    const unassigned = item.locations.find((l) => l.location_id === null);
    expect(unassigned).toEqual({ location_id: null, location_name: null, quantity: 5, is_open: 0 });
  });
});

describe('Per-location "open" status', () => {
  it('PATCH /api/items/:id/open infers the location when the item has stock in exactly one', async () => {
    const created = await api(app).post('/api/items').send({ name: 'Milk 2L', location_id: locA, quantity: 1 });
    const id = created.body.id;

    const res = await api(app).patch(`/api/items/${id}/open`).send({ is_open: 1 });
    expect(res.status).toBe(200);

    const item = (await api(app).get('/api/items')).body.find((i) => i.id === id);
    expect(item.locations[0].is_open).toBe(1);
  });

  it('requires an explicit location_id when the item has stock in more than one location', async () => {
    const created = await api(app).post('/api/items').send({ name: 'Yoghurt Tub', location_id: locA, quantity: 1 });
    const id = created.body.id;
    await api(app).patch(`/api/items/${id}/quantity`).send({ amount: 1, action: 'add', location_id: locB });

    const ambiguous = await api(app).patch(`/api/items/${id}/open`).send({ is_open: 1 });
    expect(ambiguous.status).toBe(400);

    const scoped = await api(app).patch(`/api/items/${id}/open`).send({ is_open: 1, location_id: locB });
    expect(scoped.status).toBe(200);

    const item = (await api(app).get('/api/items')).body.find((i) => i.id === id);
    const byLocation = Object.fromEntries(item.locations.map((l) => [l.location_id, l.is_open]));
    expect(byLocation[locA]).toBe(0);
    expect(byLocation[locB]).toBe(1);
  });

  it('subtracting exactly 1 clears is_open on that location\'s row', async () => {
    const created = await api(app).post('/api/items').send({ name: 'Butter Block', location_id: locA, quantity: 3 });
    const id = created.body.id;
    await api(app).patch(`/api/items/${id}/open`).send({ is_open: 1 });

    await api(app).patch(`/api/items/${id}/quantity`).send({ amount: 1, action: 'subtract', location_id: locA });

    const item = (await api(app).get('/api/items')).body.find((i) => i.id === id);
    expect(item.locations[0].is_open).toBe(0);
    expect(item.locations[0].quantity).toBe(2);
  });

  it('subtracting more than 1 at once leaves is_open untouched', async () => {
    const created = await api(app).post('/api/items').send({ name: 'Cheese Block', location_id: locA, quantity: 5 });
    const id = created.body.id;
    await api(app).patch(`/api/items/${id}/open`).send({ is_open: 1 });

    await api(app).patch(`/api/items/${id}/quantity`).send({ amount: 2, action: 'subtract', location_id: locA });

    const item = (await api(app).get('/api/items')).body.find((i) => i.id === id);
    expect(item.locations[0].is_open).toBe(1);
    expect(item.locations[0].quantity).toBe(3);
  });

  it('adding stock does not affect is_open', async () => {
    const created = await api(app).post('/api/items').send({ name: 'Bread Loaf', location_id: locA, quantity: 1 });
    const id = created.body.id;
    await api(app).patch(`/api/items/${id}/open`).send({ is_open: 1 });

    await api(app).patch(`/api/items/${id}/quantity`).send({ amount: 1, action: 'add', location_id: locA });

    const item = (await api(app).get('/api/items')).body.find((i) => i.id === id);
    expect(item.locations[0].is_open).toBe(1);
  });
});

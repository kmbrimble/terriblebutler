import { describe, it, expect, beforeEach } from 'vitest';
import './setup.js';
import { api } from './setup.js';
import pkg from '../server.js';


const { app, db } = pkg;

describe('Items API', () => {
  it('adds an item without a barcode', async () => {
    const res = await api(app)
      .post('/api/items')
      .send({ name: 'Test Item', quantity: 5 });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Test Item');
    expect(res.body.quantity).toBe(5);
  });

  it('adds an item with a barcode', async () => {
    const res = await api(app)
      .post('/api/items')
      .send({ name: 'Barcoded Item', barcode: '9310598500211', quantity: 3 });

    expect(res.status).toBe(201);
    expect(res.body.barcode).toBe('9310598500211');
  });

  it('rejects a duplicate barcode', async () => {
    const barcode = '9310273126200';

    const first = await api(app)
      .post('/api/items')
      .send({ name: 'Original Item', barcode, quantity: 1 });
    expect(first.status).toBe(201);

    const second = await api(app)
      .post('/api/items')
      .send({ name: 'Duplicate Item', barcode, quantity: 1 });

    expect(second.status).toBe(409);
  });

  it('edit preserves fields not in the edit payload', async () => {
    const created = await api(app)
      .post('/api/items')
      .send({
        name: 'Preserve Test',
        barcode: '9310881989594',
        quantity: 2,
        price: 4.50,
        vendor: 'Coles',
      });
    expect(created.status).toBe(201);
    const itemId = created.body.id;

    const before = await api(app).get(`/api/items/${itemId}/details`);
    const originalLastPrice = before.body.last_price;
    expect(originalLastPrice).toBe(4.50);

    const updated = await api(app)
      .put(`/api/items/${itemId}`)
      .send({ name: 'Preserve Test Renamed', quantity: 2, reorder_threshold: 0 });
    expect(updated.status).toBe(200);

    const after = await api(app).get(`/api/items/${itemId}/details`);
    expect(after.body.last_price).toBe(originalLastPrice);
    expect(after.body.barcode).toBe('9310881989594');
  });

  it('rejects a negative deduction', async () => {
    const created = await api(app)
      .post('/api/items')
      .send({ name: 'Deduct Negative Test', quantity: 5 });
    const itemId = created.body.id;

    const res = await api(app)
      .post(`/api/items/${itemId}/deduct`)
      .send({ amount: -3 });

    expect(res.status).toBe(400);
  });

  it('prevents stock falling below zero', async () => {
    const created = await api(app)
      .post('/api/items')
      .send({ name: 'Deduct Overflow Test', quantity: 2 });
    const itemId = created.body.id;

    const res = await api(app)
      .post(`/api/items/${itemId}/deduct`)
      .send({ amount: 10 });

    expect(res.status).toBe(409);

    const after = await api(app).get(`/api/items/${itemId}/details`);
    expect(after.body.quantity).toBe(2);
  });

  it('records price on create', async () => {
    const created = await api(app)
      .post('/api/items')
      .send({ name: 'Price Create', quantity: 1, price: 3.25, vendor: 'Coles' });
    expect(created.status).toBe(201);
    const itemId = created.body.id;

    const details = await api(app).get(`/api/items/${itemId}/details`);
    expect(details.body.last_price).toBe(3.25);
    expect(details.body.lowest_price).toBe(3.25);
  });

  it('rejects an item with an empty name', async () => {
    const res = await api(app)
      .post('/api/items')
      .send({ name: '', quantity: 1 });

    expect(res.status).toBe(400);
  });

  it('rejects a non-finite quantity', async () => {
    const res = await api(app)
      .post('/api/items')
      .send({ name: 'NaN Qty', quantity: 'abc' });

    expect(res.status).toBe(400);
  });

  it('rejects a negative reorder threshold', async () => {
    const res = await api(app)
      .post('/api/items')
      .send({ name: 'Neg Threshold', quantity: 1, reorder_threshold: -5 });

    expect(res.status).toBe(400);
  });

  it('returns 404 when editing a non-existent item', async () => {
    const res = await api(app)
      .put('/api/items/999999')
      .send({ name: 'Ghost', quantity: 1, reorder_threshold: 0 });

    expect(res.status).toBe(404);
  });

  it('returns 404 when deducting a non-existent item', async () => {
    const res = await api(app)
      .post('/api/items/999999/deduct')
      .send({ amount: 1 });

    expect(res.status).toBe(404);
  });

  it('rejects a zero deduction', async () => {
    const created = await api(app)
      .post('/api/items')
      .send({ name: 'Zero Deduct Test', quantity: 5 });
    const itemId = created.body.id;

    const res = await api(app)
      .post(`/api/items/${itemId}/deduct`)
      .send({ amount: 0 });

    expect(res.status).toBe(400);
  });

  it('rejects a non-numeric deduction', async () => {
    const created = await api(app)
      .post('/api/items')
      .send({ name: 'Non Numeric Deduct Test', quantity: 5 });
    const itemId = created.body.id;

    const res = await api(app)
      .post(`/api/items/${itemId}/deduct`)
      .send({ amount: 'five' });

    expect(res.status).toBe(400);
  });

  it('rejects editing an item to a barcode used by another item', async () => {
    const itemA = await api(app)
      .post('/api/items')
      .send({ name: 'Item A', barcode: '9300601186945', quantity: 1 });
    expect(itemA.status).toBe(201);

    const itemB = await api(app)
      .post('/api/items')
      .send({ name: 'Item B', quantity: 1 });
    expect(itemB.status).toBe(201);
    const itemBId = itemB.body.id;

    const res = await api(app)
      .put(`/api/items/${itemBId}`)
      .send({ name: 'B', barcode: '9300601186945', quantity: 1, reorder_threshold: 0 });

    expect(res.status).toBe(409);
  });

  it('deletes an item and its price history', async () => {
    const created = await api(app)
      .post('/api/items')
      .send({ name: 'Delete Test', quantity: 1, price: 1.99, vendor: 'Test Vendor' });
    expect(created.status).toBe(201);
    const itemId = created.body.id;

    const deleteRes = await api(app).delete(`/api/items/${itemId}`);
    expect(deleteRes.status).toBe(200);

    const historyRes = await api(app).get(`/api/items/${itemId}/price-history`);
    expect(historyRes.body).toEqual([]);
  });
});

describe('GET /api/items/match', () => {
  it('returns no match when nothing is close', async () => {
    const res = await api(app).get('/api/items/match').query({ name: 'Completely Unrelated Product' });
    expect(res.status).toBe(200);
    expect(res.body.type).toBeNull();
    expect(res.body.candidates).toEqual([]);
  });

  it('finds a barcode match', async () => {
    await api(app).post('/api/items').send({ name: 'Beans', barcode: '444555666', quantity: 1 });
    const res = await api(app).get('/api/items/match').query({ name: 'Different Name', barcode: '444555666' });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('barcode');
    expect(res.body.candidates[0].barcode).toBe('444555666');
  });

  it('finds an exact normalised-name match', async () => {
    await api(app).post('/api/items').send({ name: 'Olive Oil 1L', quantity: 1 });
    const res = await api(app).get('/api/items/match').query({ name: '  olive   OIL 1L ' });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('exact_name');
  });

  it('finds a fuzzy match and reports it as a suggestion (no auto-selected item)', async () => {
    await api(app).post('/api/items').send({ name: 'Peanut Butter Smooth 500g', quantity: 1 });
    const res = await api(app).get('/api/items/match').query({ name: 'Peanut Buttr Smooth 500g' });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('fuzzy');
    expect(res.body.candidates.length).toBeGreaterThan(0);
  });
});

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import './setup.js';
import pkg from '../server.js';

const { app, db } = pkg;

describe('Price History API', () => {
  it('recalculates prices after deleting a price-history record', async () => {
    const created = await request(app)
      .post('/api/items')
      .send({ name: 'Recalc Test', quantity: 1, price: 5.00, vendor: 'Vendor A' });
    expect(created.status).toBe(201);
    const itemId = created.body.id;

    const updated = await request(app)
      .put(`/api/items/${itemId}`)
      .send({ name: 'Recalc Test', quantity: 1, reorder_threshold: 0, price: 2.00, vendor: 'X' });
    expect(updated.status).toBe(200);

    const history = await request(app).get(`/api/items/${itemId}/price-history`);
    const recordToDelete = history.body.find((entry) => entry.price === 2.00);
    expect(recordToDelete).toBeTruthy();

    const deleteRes = await request(app).delete(`/api/price-history/${recordToDelete.id}`);
    expect(deleteRes.status).toBe(200);

    const details = await request(app).get(`/api/items/${itemId}/details`);
    expect(details.body.last_price).toBe(5.00);
    expect(details.body.lowest_price).toBe(5.00);
  });

  it('returns 404 when deleting a non-existent price-history record', async () => {
    const res = await request(app).delete('/api/price-history/999999');

    expect(res.status).toBe(404);
  });
});

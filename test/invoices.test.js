import { describe, it, expect } from 'vitest';
import './setup.js';
import { api } from './setup.js';
import pkg from '../server.js';

const { app } = pkg;

describe('POST /api/invoices/commit', () => {
  it('creates a new item when nothing matches', async () => {
    const res = await api(app).post('/api/invoices/commit').send({
      items: [{ name: 'Brand New Product 1L', quantity: 2, price: 3.5, vendor: 'Coles' }],
    });
    expect(res.status).toBe(200);

    const items = await api(app).get('/api/items');
    const created = items.body.find((i) => i.name === 'Brand New Product 1L');
    expect(created).toBeTruthy();
    expect(created.quantity).toBe(2);
  });

  it('auto-merges into an existing item on an exact normalised-name match', async () => {
    await api(app).post('/api/items').send({ name: 'Tinned Tomatoes', quantity: 1 });
    const res = await api(app).post('/api/invoices/commit').send({
      items: [{ name: '  tinned   TOMATOES  ', quantity: 3, price: 2, vendor: 'Woolworths' }],
    });
    expect(res.status).toBe(200);

    const items = await api(app).get('/api/items');
    const matches = items.body.filter((i) => i.name === 'Tinned Tomatoes');
    expect(matches).toHaveLength(1);
    expect(matches[0].quantity).toBe(4);
  });

  it('auto-merges on a barcode match even when the name differs from the invoice text', async () => {
    await api(app).post('/api/items').send({ name: 'Beans', barcode: '111222333', quantity: 1 });
    const res = await api(app).post('/api/invoices/commit').send({
      items: [{ name: 'BEANS BAKED 420G TIN', barcode: '111222333', quantity: 5, price: 2, vendor: 'IGA' }],
    });
    expect(res.status).toBe(200);

    const items = await api(app).get('/api/items');
    const matches = items.body.filter((i) => i.barcode === '111222333');
    expect(matches).toHaveLength(1);
    expect(matches[0].quantity).toBe(6);
    expect(matches[0].name).toBe('Beans');
  });

  it('never auto-merges a fuzzy-only match — creates a new item instead', async () => {
    await api(app).post('/api/items').send({ name: 'Baked Beans 420g', quantity: 1 });
    const res = await api(app).post('/api/invoices/commit').send({
      items: [{ name: 'Baked Beanz 420g', quantity: 2, price: 2, vendor: 'IGA' }],
    });
    expect(res.status).toBe(200);

    const items = await api(app).get('/api/items');
    expect(items.body.filter((i) => i.name === 'Baked Beans 420g')).toHaveLength(1);
    expect(items.body.find((i) => i.name === 'Baked Beanz 420g')).toBeTruthy();
  });

  it('merges into a fuzzy candidate when the client explicitly confirms it via matchDecision', async () => {
    const created = await api(app).post('/api/items').send({ name: 'Peanut Sauce 250g', quantity: 1 });
    const targetId = created.body.id;

    const res = await api(app).post('/api/invoices/commit').send({
      items: [{ name: 'Peanutt Sauce 250g', quantity: 2, price: 2, vendor: 'IGA', matchDecision: targetId }],
    });
    expect(res.status).toBe(200);

    const items = await api(app).get('/api/items');
    expect(items.body.filter((i) => i.name.startsWith('Peanut'))).toHaveLength(1);
    expect(items.body.find((i) => i.id === targetId).quantity).toBe(3);
  });

  it("matchDecision: 'new' forces a new item even when an exact-name match exists", async () => {
    await api(app).post('/api/items').send({ name: 'Milk 2L', quantity: 1 });
    const res = await api(app).post('/api/invoices/commit').send({
      items: [{ name: 'Milk 2L', quantity: 4, price: 4, vendor: 'Coles', matchDecision: 'new' }],
    });
    expect(res.status).toBe(200);

    const items = await api(app).get('/api/items');
    expect(items.body.filter((i) => i.name === 'Milk 2L')).toHaveLength(2);
  });

  it('matching an existing item at a NEW location creates a second item_locations row instead of merging into the wrong one', async () => {
    const locA = await api(app).post('/api/locations').send({ name: 'Invoice Loc A' });
    const locB = await api(app).post('/api/locations').send({ name: 'Invoice Loc B' });
    const created = await api(app).post('/api/items').send({ name: 'Cereal Box', location_id: locA.body.id, quantity: 1 });

    const res = await api(app).post('/api/invoices/commit').send({
      items: [{ name: 'Cereal Box', quantity: 3, price: 5, vendor: 'Coles', location_id: locB.body.id }],
    });
    expect(res.status).toBe(200);

    const item = (await api(app).get('/api/items')).body.find((i) => i.id === created.body.id);
    expect(item.quantity).toBe(4);
    const byLocation = Object.fromEntries(item.locations.map((l) => [l.location_id, l.quantity]));
    expect(byLocation[locA.body.id]).toBe(1);
    expect(byLocation[locB.body.id]).toBe(3);
  });

  it('updates the in-memory match set as items are inserted, so two identical line items in one invoice merge together', async () => {
    const res = await api(app).post('/api/invoices/commit').send({
      items: [
        { name: 'Frozen Peas 1kg', quantity: 1, price: 3, vendor: 'Aldi' },
        { name: 'Frozen Peas 1kg', quantity: 1, price: 3, vendor: 'Aldi' },
      ],
    });
    expect(res.status).toBe(200);

    const items = await api(app).get('/api/items');
    const matches = items.body.filter((i) => i.name === 'Frozen Peas 1kg');
    expect(matches).toHaveLength(1);
    expect(matches[0].quantity).toBe(2);
  });
});

import { describe, it, expect, afterEach, vi } from 'vitest';
import './setup.js';
import { api } from './setup.js';
import pkg from '../server.js';

const { app, db } = pkg;

afterEach(() => {
  vi.restoreAllMocks();
});

const LEAK = 'SQLITE_INTERNAL: no such column secret_table.hidden_column';

describe('sendMutationError only echoes deliberate validation errors', () => {
  it('an unexpected database error on an item mutation yields the generic correlation-id 500', async () => {
    const created = await api(app).post('/api/items').send({ name: 'Leak probe', quantity: 1 });
    expect(created.status).toBe(201);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const realPrepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation((sql) => {
      if (/UPDATE item_locations SET quantity/.test(sql)) throw new Error(LEAK);
      return realPrepare(sql);
    });

    const res = await api(app).patch(`/api/items/${created.body.id}/quantity`).send({ action: 'add', amount: 1 });

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('hidden_column');
    expect(res.body.correlation_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(errSpy.mock.calls.some((c) => c.some((a) => a instanceof Error && a.message === LEAK))).toBe(true);
  });

  it.each([
    ['POST', '/api/items', { name: '' }, 400, /required/i],
    ['POST', '/api/items', { name: 'x', quantity: -1 }, 400, /Quantity/],
    ['POST', '/api/items', { name: 'x', location_id: 99999 }, 400, /Location does not exist/],
  ])('deliberate validation errors keep their message: %s %s', async (method, url, body, status, message) => {
    const res = await api(app)[method.toLowerCase()](url).send(body);
    expect(res.status).toBe(status);
    expect(res.body.error).toMatch(message);
  });

  it('a duplicate barcode is still a 409 with its message', async () => {
    await api(app).post('/api/items').send({ name: 'Dup A', barcode: '9300000000017' });
    const res = await api(app).post('/api/items').send({ name: 'Dup B', barcode: '9300000000017' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already assigned/);
  });

  it('a plain Error whose text mentions "already assigned" is not treated as a conflict', async () => {
    const { sendMutationError } = await import('../lib/domain-helpers.js');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    sendMutationError(res, new Error('already assigned: internal detail'));
    expect(res.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain('internal detail');
  });
});

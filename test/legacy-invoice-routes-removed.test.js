import { describe, it, expect } from 'vitest';
import './setup.js';
import { api } from './setup.js';
import pkg from '../server.js';

const { app } = pkg;

// The plain LLM-parse flow had no client once /legacy was retired (#59) and no duplicate
// protection; the deterministic import (POST /api/invoices/import) supersedes it, so the
// unguarded second path is gone rather than kept.
describe('retired LLM-parse invoice routes', () => {
  it.each(['/api/invoices/parse', '/api/invoices/commit'])('%s no longer exists', async (route) => {
    const res = await api(app).post(route).send({ items: [{ name: 'x', quantity: 1, price: 1 }] });
    expect(res.status).toBe(404);
  });
});

import { describe, it, expect } from 'vitest';
import './setup.js';
import pkg from '../server.js';

const { app, server, db } = pkg;

// Route-table snapshot: the ordered list of (method, path) pairs registered on `app`.
// This is the contract issue #32's server.js split had to preserve exactly — an empty
// diff against this list is the strongest signal the refactor didn't change behaviour.
const EXPECTED_ROUTES = [
  'GET /healthz',
  'POST /api/auth/login',
  'GET /api/health',
  'POST /api/auth/device-token',
  'GET /api/auth/devices',
  'POST /api/auth/devices/:id/revoke',
  'GET /api/locations',
  'POST /api/locations',
  'PUT /api/locations/:id',
  'DELETE /api/locations/:id',
  'GET /api/categories',
  'POST /api/categories',
  'PUT /api/categories/:id',
  'DELETE /api/categories/:id',
  'GET /api/items',
  'GET /api/grocery-list',
  'GET /api/out-of-stock-ignored',
  'GET /api/items/search',
  'GET /api/items/match',
  'GET /api/items/barcode/:barcode',
  'GET /api/items/:id/details',
  'GET /api/items/:id/price-history',
  'POST /api/items',
  'PUT /api/items/:id',
  'PATCH /api/items/:id/quantity',
  'POST /api/items/:id/deduct',
  'PATCH /api/items/:id/ignore-grocery',
  'PATCH /api/items/:id/open',
  'DELETE /api/items/:id',
  'DELETE /api/price-history/:id',
  'POST /api/upload-image',
  'POST /api/parse-label-llm',
  'POST /api/invoices/parse',
  'POST /api/invoices/commit',
  'POST /api/invoices/import',
  'GET /api/invoices/import/:id',
  'PATCH /api/invoices/import/:id/lines/:lineId',
  'POST /api/invoices/import/:id/commit',
  'GET *',
];

function dumpRoutes(expressApp) {
  return expressApp._router.stack
    .filter((layer) => layer.route)
    .map((layer) => {
      const methods = Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]);
      return methods.map((m) => `${m.toUpperCase()} ${layer.route.path}`);
    })
    .flat();
}

describe('server.js module split (issue #32)', () => {
  it('still exports app, server, and db', () => {
    expect(app).toBeTruthy();
    expect(server).toBeTruthy();
    expect(db).toBeTruthy();
    expect(typeof db.prepare).toBe('function');
  });

  it('opens the database against DB_PATH', () => {
    expect(process.env.DB_PATH).toBeTruthy();
    expect(db.name).toBe(process.env.DB_PATH);
  });

  it('registers the exact same route table, in the exact same order, as before the split', () => {
    expect(dumpRoutes(app)).toEqual(EXPECTED_ROUTES);
  });
});

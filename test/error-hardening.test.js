import { describe, it, expect, afterEach, vi } from 'vitest';
import path from 'path';
import './setup.js';
import { api } from './setup.js';
import pkg from '../server.js';

const { app, db } = pkg;

afterEach(() => {
  vi.restoreAllMocks();
});

const LEAK = 'SQLITE_INTERNAL: no such column secret_table.hidden_column';

// Makes every db.prepare() throw an error whose message must never reach the client.
function breakDatabase() {
  vi.spyOn(db, 'prepare').mockImplementation(() => {
    throw new Error(LEAK);
  });
}

function expectGeneric500(res, errSpy) {
  expect(res.status).toBe(500);
  expect(JSON.stringify(res.body)).not.toContain('SQLITE');
  expect(JSON.stringify(res.body)).not.toContain('hidden_column');
  expect(res.body.correlation_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(res.body.error).toContain(res.body.correlation_id.slice(0, 8));
  // The full error is logged server-side under the same id.
  const logged = errSpy.mock.calls.find((call) => String(call[0]).includes(res.body.correlation_id));
  expect(logged).toBeTruthy();
  expect(logged.some((arg) => arg instanceof Error && arg.message === LEAK)).toBe(true);
}

describe('500 responses do not echo internal error messages (#61)', () => {
  it.each([
    ['POST', '/api/categories', { name: 'Leak Category' }],
    ['PUT', '/api/categories/1', { name: 'Leak Category' }],
    ['DELETE', '/api/categories/1', undefined],
    ['POST', '/api/locations', { name: 'Leak Location' }],
    ['PUT', '/api/locations/1', { name: 'Leak Location' }],
    ['DELETE', '/api/locations/1', undefined],
    ['PATCH', '/api/items/1/ignore-grocery', { is_ignored_grocery: 1 }],
  ])('%s %s', async (method, url, body) => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    breakDatabase();
    const res = await api(app)[method.toLowerCase()](url).send(body);
    expectGeneric500(res, errSpy);
  });

  it('the global error handler returns a generic 500 for unexpected errors', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    breakDatabase();
    const res = await api(app).get('/api/items');
    expectGeneric500(res, errSpy);
  });

  it('invoice parse/commit/import failures are generic too', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    breakDatabase();
    const commit = await api(app).post('/api/invoices/commit').send({ items: [] });
    expectGeneric500(commit, errSpy);
    const importCommit = await api(app).post('/api/invoices/import/1/commit');
    expectGeneric500(importCommit, errSpy);
  });

  it('keeps deliberate 4xx messages: malformed JSON, unsupported upload type, upload limits', async () => {
    const bad = await api(app).post('/api/categories').set('Content-Type', 'application/json').send('{"name": ');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('Malformed JSON in request body.');

    const badType = await api(app)
      .post('/api/upload-image')
      .attach('image', path.join(process.cwd(), 'package.json'), { contentType: 'text/plain' });
    expect(badType.status).toBe(400);
    expect(badType.body.error).toMatch(/Unsupported file type/);
  });
});

describe('client-caused errors raised before a route handler stay 4xx (#61 review)', () => {
  it('returns 400 for a malformed percent-encoded path parameter', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await api(app).get('/api/items/%E0');
    expect(res.status).toBe(400);
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each([
    ['a truncated multipart body', 'multipart/form-data; boundary=xyz', '--xyz\r\nContent-Disposition: form-data; name="image"; filename="a.png"\r\nContent-Type: image/png\r\n\r\npartial'],
    ['a multipart request without a boundary', 'multipart/form-data', 'garbage'],
  ])('returns 400 for %s', async (_label, contentType, body) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await api(app).post('/api/upload-image').set('Content-Type', contentType).send(body);
    expect(res.status).toBe(400);
  });
});

describe.each([
  ['categories', 'Category'],
  ['locations', 'Location'],
])('%s name validation (#61)', (resource) => {
  const url = `/api/${resource}`;

  it.each([
    ['a number', 123],
    ['an object', { nested: 'x' }],
    ['an array', ['a']],
    ['whitespace only', '   '],
    ['an empty string', ''],
    ['over the length limit', 'n'.repeat(101)],
  ])('rejects a name that is %s on create and update', async (_label, name) => {
    const created = await api(app).post(url).send({ name });
    expect(created.status).toBe(400);

    const seed = await api(app).post(url).send({ name: `Seed ${resource} ${Math.random()}` });
    const updated = await api(app).put(`${url}/${seed.body.id}`).send({ name });
    expect(updated.status).toBe(400);
  });

  it('trims the name and stores/returns the trimmed value', async () => {
    const unique = `Trim ${resource} ${Math.random()}`;
    const res = await api(app).post(url).send({ name: `  ${unique}  ` });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe(unique);
    const put = await api(app).put(`${url}/${res.body.id}`).send({ name: `  ${unique} v2 ` });
    expect(put.body.name).toBe(`${unique} v2`);
    const list = await api(app).get(url);
    expect(list.body.find((r) => r.id === res.body.id).name).toBe(`${unique} v2`);
  });

  it('accepts a name at exactly the limit', async () => {
    const res = await api(app).post(url).send({ name: 'n'.repeat(99) + Math.floor(Math.random() * 9) });
    expect(res.status).toBe(201);
  });

  it('reports a duplicate name as 409, not a 500', async () => {
    const unique = `Dup ${resource} ${Math.random()}`;
    await api(app).post(url).send({ name: unique });
    const res = await api(app).post(url).send({ name: unique });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/);
  });
});

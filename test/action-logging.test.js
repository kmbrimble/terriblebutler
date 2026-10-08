import { describe, it, expect } from 'vitest';
import fs from 'fs';
import './setup.js';
import { api } from './setup.js';
import pkg from '../server.js';
import { createRequire } from 'module';
import request from 'supertest';

// server.js loads the logger with native require; use that same instance so flush() reaches
// the stream the server wrote to (an ESM import would be a second copy with its own stream).
const { currentLogFile, flush } = createRequire(import.meta.url)('../logger.js');

const { app } = pkg;

async function readLoggedEntries() {
  await flush();
  const file = currentLogFile();
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('action logging middleware', () => {
  it('logs a POST /api/items action with method, path, status and bodies', async () => {
    const res = await api(app).post('/api/items').send({ name: 'Logged Item', quantity: 1 });
    expect(res.status).toBe(201);

    const entries = await readLoggedEntries();
    const entry = entries.find((e) => e.path === '/api/items' && e.method === 'POST' && e.request_body?.name === 'Logged Item');
    expect(entry).toBeTruthy();
    expect(entry.status).toBe(201);
    expect(entry.response_body.name).toBe('Logged Item');
    expect(typeof entry.duration_ms).toBe('number');
  });

  it('does not log GET requests', async () => {
    const before = (await readLoggedEntries()).length;
    await api(app).get('/api/items');
    const after = (await readLoggedEntries()).length;
    expect(after).toBe(before);
  });

  it('logs a login attempt as a body-less audit event with outcome and client IP', async () => {
    const { TEST_USERNAME, TEST_PASSWORD } = await import('./setup.js');
    await request(app).post('/api/auth/login').send({ username: TEST_USERNAME, password: TEST_PASSWORD });
    await request(app).post('/api/auth/login').send({ username: 'someone-else', password: 'a-mistyped-password' });

    const entries = (await readLoggedEntries()).filter((e) => e.event === 'login');
    const success = entries.find((e) => e.outcome === 'success');
    const failure = entries.find((e) => e.outcome === 'failure');
    expect(success).toMatchObject({ username: TEST_USERNAME, status: 200 });
    expect(failure.status).toBe(401);
    expect(failure.username).toBeUndefined();
    for (const entry of entries) {
      expect(entry.ip).toBeTruthy();
      expect(entry).not.toHaveProperty('request_body');
      expect(entry).not.toHaveProperty('response_body');
    }
    const raw = fs.readFileSync(currentLogFile(), 'utf8');
    expect(raw).not.toContain('a-mistyped-password');
    expect(raw).not.toContain(TEST_PASSWORD);
  });

  it('never logs the bodies of unauthenticated requests', async () => {
    await request(app).post('/api/items').send({ name: 'unauth-marker-item', note: 'unauth-marker-body' });
    await request(app).post('/api/items').set('Authorization', 'Bearer not-a-real-token').send({ name: 'unauth-marker-item' });
    await readLoggedEntries();
    const file = currentLogFile();
    const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    expect(raw).not.toContain('unauth-marker');
  });


  it('redacts secrets in nested objects and arrays, whatever the key casing', async () => {
    await api(app).post('/api/items').send({
      name: 'Nested Secrets Item',
      quantity: 1,
      meta: { Authorization: 'Bearer nested-secret-value', list: [{ api_key: 'nested-key-value', ok: 'visible' }] },
    });
    const entry = (await readLoggedEntries()).find((e) => e.request_body?.name === 'Nested Secrets Item');
    expect(entry.request_body.meta.Authorization).toBe('***');
    expect(entry.request_body.meta.list[0].api_key).toBe('***');
    expect(entry.request_body.meta.list[0].ok).toBe('visible');
    expect(fs.readFileSync(currentLogFile(), 'utf8')).not.toContain('nested-secret-value');
  });

  it('never writes media signatures, session tokens or device-token values to the log', async () => {
    const stored = `${'b'.repeat(32)}.webp`;
    const created = await api(app).post('/api/items').send({ name: 'Signed Image Item', quantity: 1 });
    pkg.db.prepare('UPDATE items SET image_path = ? WHERE id = ?').run(stored, created.body.id);
    const edited = await api(app).put(`/api/items/${created.body.id}`).send({ name: 'Signed Image Item', reorder_threshold: 5 });
    expect(edited.status).toBe(200);
    const signature = new URL(edited.body.image_path, 'http://x').searchParams.get('sig');
    expect(signature).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const minted = await api(app).post('/api/auth/device-token').send({ device_label: 'Log Test Tablet' });
    expect(minted.status).toBe(200);
    const deviceToken = minted.body.token;

    await readLoggedEntries();
    const raw = fs.readFileSync(currentLogFile(), 'utf8');
    expect(raw).toContain('/media/');
    expect(raw).not.toContain(signature);
    expect(raw).not.toContain(deviceToken);
  });

  it('truncates oversized bodies to a bounded size', async () => {
    await api(app).post('/api/items').send({ name: 'Oversized Body Item', quantity: 1, container_details: 'x'.repeat(400) , filler: 'y'.repeat(50000) });
    const entry = (await readLoggedEntries()).find((e) => e.request_body?.preview?.includes('Oversized Body Item'));
    expect(entry.request_body.truncated).toBe(true);
    expect(entry.request_body.original_chars).toBeGreaterThan(50000);
    expect(JSON.stringify(entry).length).toBeLessThan(20000);
  });
});

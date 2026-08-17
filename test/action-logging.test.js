import { describe, it, expect } from 'vitest';
import fs from 'fs';
import './setup.js';
import { api } from './setup.js';
import pkg from '../server.js';
import { currentLogFile } from '../logger.js';

const { app } = pkg;

function readLoggedEntries() {
  const file = currentLogFile();
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('action logging middleware', () => {
  it('logs a POST /api/items action with method, path, status and bodies', async () => {
    const res = await api(app).post('/api/items').send({ name: 'Logged Item', quantity: 1 });
    expect(res.status).toBe(200);

    const entries = readLoggedEntries();
    const entry = entries.find((e) => e.path === '/api/items' && e.method === 'POST' && e.request_body?.name === 'Logged Item');
    expect(entry).toBeTruthy();
    expect(entry.status).toBe(200);
    expect(entry.response_body.name).toBe('Logged Item');
    expect(typeof entry.duration_ms).toBe('number');
  });

  it('does not log GET requests', async () => {
    const before = readLoggedEntries().length;
    await api(app).get('/api/items');
    const after = readLoggedEntries().length;
    expect(after).toBe(before);
  });

  it('redacts the password field when logging a login attempt', async () => {
    const { TEST_USERNAME, TEST_PASSWORD } = await import('./setup.js');
    const request = (await import('supertest')).default;
    await request(app).post('/api/auth/login').send({ username: TEST_USERNAME, password: TEST_PASSWORD });

    const entries = readLoggedEntries();
    const entry = entries.find((e) => e.path === '/api/auth/login');
    expect(entry).toBeTruthy();
    expect(entry.request_body.password).toBe('***');
    expect(entry.response_body.token).toBe('***');
  });
});

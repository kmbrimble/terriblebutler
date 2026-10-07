import { describe, it, expect } from 'vitest';
import request from 'supertest';
import './setup.js';
import pkg from '../server.js';
import { TEST_USERNAME, TEST_PASSWORD } from './setup.js';

const { app } = pkg;

// Separate file so the login rate limiter (5 attempts) starts fresh.
describe('POST /api/auth/login with non-string credentials', () => {
  it('returns 400 for a numeric password and keeps serving', async () => {
    const res = await request(app).post('/api/auth/login').send({ username: TEST_USERNAME, password: 1 });
    expect(res.status).toBe(400);

    const next = await request(app).get('/api/health');
    expect(next.status).toBe(200);
  });

  it.each([
    [{ username: TEST_USERNAME, password: { a: 1 } }],
    [{ username: TEST_USERNAME, password: ['x'] }],
    [{ username: 5, password: TEST_PASSWORD }],
  ])('returns 400 for %j', async (body) => {
    const res = await request(app).post('/api/auth/login').send(body);
    expect(res.status).toBe(400);
  });
});

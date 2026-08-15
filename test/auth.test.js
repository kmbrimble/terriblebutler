import { describe, it, expect } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import './setup.js';
import pkg from '../server.js';
import { TEST_USERNAME, TEST_PASSWORD } from './setup.js';

const { app } = pkg;

describe('POST /api/auth/login', () => {
  it('returns a JWT for valid credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_USERNAME, password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');

    const decoded = jwt.verify(res.body.token, process.env.JWT_SECRET);
    expect(decoded.sub).toBe(TEST_USERNAME);
  });

  it('rejects an incorrect password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_USERNAME, password: 'wrong' });

    expect(res.status).toBe(401);
    expect(res.body.token).toBeUndefined();
  });

  it('rejects an unknown username', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'nobody', password: TEST_PASSWORD });

    expect(res.status).toBe(401);
  });

  it('rejects a missing body', async () => {
    const res = await request(app).post('/api/auth/login').send({});

    expect(res.status).toBe(400);
  });

  it('rate-limits repeated login attempts from the same IP', async () => {
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/api/auth/login')
        .send({ username: TEST_USERNAME, password: 'wrong' });
    }

    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_USERNAME, password: 'wrong' });

    expect(res.status).toBe(429);
  });
});

describe('GET /api/health', () => {
  it('is reachable without a token', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('auth middleware', () => {
  it('rejects a protected route with no Authorization header', async () => {
    const res = await request(app).get('/api/items');
    expect(res.status).toBe(401);
  });

  it('rejects a protected route with a garbage token', async () => {
    const res = await request(app)
      .get('/api/items')
      .set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const forged = jwt.sign({ sub: TEST_USERNAME }, 'wrong-secret', { expiresIn: '30d' });
    const res = await request(app)
      .get('/api/items')
      .set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });

  it('allows a protected route with a valid token', async () => {
    const res = await request(app)
      .get('/api/items')
      .set('Authorization', `Bearer ${jwt.sign({ sub: TEST_USERNAME }, process.env.JWT_SECRET, { expiresIn: '30d' })}`);
    expect(res.status).toBe(200);
  });
});

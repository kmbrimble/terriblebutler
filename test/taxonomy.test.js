import { describe, it, expect } from 'vitest';
import request from 'supertest';
import './setup.js';
import pkg from '../server.js';

const { app, db } = pkg;

describe('Categories API', () => {
  it('adds and lists a category', async () => {
    const created = await request(app)
      .post('/api/categories')
      .send({ name: 'Snacks' });
    expect(created.status).toBe(201);

    const list = await request(app).get('/api/categories');
    const names = list.body.map((cat) => cat.name);
    expect(names).toContain('Snacks');
  });

  it('returns 404 when updating a non-existent category', async () => {
    const res = await request(app)
      .put('/api/categories/999999')
      .send({ name: 'X' });

    expect(res.status).toBe(404);
  });
});

describe('Locations API', () => {
  it('adds and lists a location', async () => {
    const created = await request(app)
      .post('/api/locations')
      .send({ name: 'Garage' });
    expect(created.status).toBe(201);

    const list = await request(app).get('/api/locations');
    const names = list.body.map((loc) => loc.name);
    expect(names).toContain('Garage');
  });

  it('returns 404 when deleting a non-existent location', async () => {
    const res = await request(app).delete('/api/locations/999999');

    expect(res.status).toBe(404);
  });
});

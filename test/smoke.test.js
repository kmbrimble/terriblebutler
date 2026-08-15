import { describe, it, expect } from 'vitest';
import './setup.js';
import { api } from './setup.js';
import pkg from '../server.js';

const { app } = pkg;

describe('GET /api/locations', () => {
  it('returns the seeded default locations', async () => {
    const res = await api(app).get('/api/locations');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    const names = res.body.map((loc) => loc.name);
    expect(names).toEqual(
      expect.arrayContaining(['Chest Freezer', 'Fridge Freezer', 'Fridge', 'Pantry', 'HP Cupboard'])
    );
  });
});

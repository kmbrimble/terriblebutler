import { describe, it, expect } from 'vitest';
import './setup.js';
import { api } from './setup.js';
import pkg from '../server.js';

const { app } = pkg;

// Express 5 leaves req.body undefined for body-less requests; handlers destructure it.
describe('body-less mutating requests', () => {
  it.each(['/api/categories', '/api/locations'])('POST %s with no body is a validation error, not a destructuring crash', async (url) => {
    const res = await api(app).post(url);
    expect(res.status).toBe(400);
    expect(res.body.error).not.toMatch(/destructur|undefined/i);
  });
});

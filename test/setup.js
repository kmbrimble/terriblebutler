import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll } from 'vitest';

const tmpDbPath = path.join(os.tmpdir(), `butler-test-${crypto.randomBytes(8).toString('hex')}.db`);
process.env.DB_PATH = tmpDbPath;

export const TEST_USERNAME = 'testuser';
export const TEST_PASSWORD = 'testpass123';

process.env.AUTH_USERNAME = TEST_USERNAME;
process.env.AUTH_PASSWORD_HASH = bcrypt.hashSync(TEST_PASSWORD, 4);
process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');

export const TEST_TOKEN = jwt.sign({ sub: TEST_USERNAME }, process.env.JWT_SECRET, { expiresIn: '30d' });

// Wraps supertest so every call in existing test files is authenticated by default,
// without having to add `.set('Authorization', ...)` at each of the ~50 call sites.
export function api(app) {
  const authed = (test) => test.set('Authorization', `Bearer ${TEST_TOKEN}`);
  return {
    get: (url) => authed(request(app).get(url)),
    post: (url) => authed(request(app).post(url)),
    put: (url) => authed(request(app).put(url)),
    patch: (url) => authed(request(app).patch(url)),
    delete: (url) => authed(request(app).delete(url)),
  };
}

afterAll(() => {
  for (const suffix of ['', '-shm', '-wal']) {
    const file = tmpDbPath + suffix;
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }
});

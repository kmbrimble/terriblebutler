import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import Database from 'better-sqlite3';
import { afterAll } from 'vitest';

const tmpDbPath = path.join(os.tmpdir(), `butler-test-${crypto.randomBytes(8).toString('hex')}.db`);
process.env.DB_PATH = tmpDbPath;

const tmpLogDir = path.join(os.tmpdir(), `butler-test-logs-${crypto.randomBytes(8).toString('hex')}`);
process.env.LOG_DIR = tmpLogDir;
// The stdout copy of the action log writes straight to fd 1; keep the test output readable.
process.env.ACTION_LOG_STDOUT = '0';

// Uploads never touch the real directories: stored images and multer scratch files both go
// to throwaway directories, removed in afterAll.
export const tmpUploadsDir = path.join(os.tmpdir(), `butler-test-uploads-${crypto.randomBytes(8).toString('hex')}`);
export const tmpUploadScratchDir = path.join(os.tmpdir(), `butler-test-upload-tmp-${crypto.randomBytes(8).toString('hex')}`);
process.env.UPLOADS_DIR = tmpUploadsDir;
process.env.UPLOAD_TMP_DIR = tmpUploadScratchDir;
// Upload tests make well over the production 10/min LLM-route requests from one IP.
process.env.LLM_RATE_LIMIT_MAX = '1000';

export const TEST_USERNAME = 'testuser';
export const TEST_PASSWORD = 'testpass123';

// Invoice import now shares the LLM limiter (10/min); the suite imports far more often than
// that from one address. Tests of the limiter itself set their own maximum on a fresh app.
process.env.LLM_RATE_LIMIT_MAX ??= '1000';

// Login and step-up re-authentication (revoke, sign out everywhere) share the 5-per-15-minutes
// login limiter, and the suite does far more of both from one address. Tests of the limiter
// itself load a fresh app with LOGIN_RATE_LIMIT_MAX=5.
process.env.LOGIN_RATE_LIMIT_MAX ??= '1000';

process.env.AUTH_USERNAME = TEST_USERNAME;
process.env.AUTH_PASSWORD_HASH = bcrypt.hashSync(TEST_PASSWORD, 10);
process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');

// A fresh DB starts at token epoch 1 (lib/auth-state.js), so a household JWT for these tests
// carries ver 1. Tests that bump the epoch must log in again for a current token.
export const TEST_TOKEN = jwt.sign({ sub: TEST_USERNAME, ver: 1 }, process.env.JWT_SECRET, {
  expiresIn: '30d',
  jwtid: 'test-setup-jwt',
});

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
  fs.rmSync(tmpLogDir, { recursive: true, force: true });
  fs.rmSync(tmpUploadsDir, { recursive: true, force: true });
  fs.rmSync(tmpUploadScratchDir, { recursive: true, force: true });
});

// The invoice fixtures are reused across many tests, and a duplicate invoice is now refused
// (#44), so tests that import the same PDF repeatedly start from no staged imports.
export function clearInvoiceImports() {
  const conn = new Database(process.env.DB_PATH);
  try {
    // A file that has not opened the app yet has no tables to clear.
    if (conn.prepare("SELECT 1 FROM sqlite_master WHERE name = 'invoice_imports'").get()) {
      conn.exec('DELETE FROM invoice_import_lines; DELETE FROM invoice_imports;');
    }
  } finally {
    conn.close();
  }
}

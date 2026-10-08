import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import os from 'os';
import path from 'path';
import bcrypt from 'bcryptjs';
import './setup.js';
import config from '../lib/config.js';

const { validateAuthEnv } = config;
const goodHash = bcrypt.hashSync('pw', 4);
const goodSecret = 'a'.repeat(32);
const good = { AUTH_USERNAME: 'u', AUTH_PASSWORD_HASH: goodHash, JWT_SECRET: goodSecret };

describe('validateAuthEnv', () => {
  it('accepts a valid configuration', () => {
    expect(validateAuthEnv(good)).toEqual([]);
  });

  it.each(['AUTH_USERNAME', 'AUTH_PASSWORD_HASH', 'JWT_SECRET'])('reports %s when missing', (name) => {
    const problems = validateAuthEnv({ ...good, [name]: undefined });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(name);
  });

  it('rejects a password hash that is not a bcrypt hash, naming the variable but not the value', () => {
    const problems = validateAuthEnv({ ...good, AUTH_PASSWORD_HASH: 'plaintext-sentinel-value' });
    expect(problems[0]).toContain('AUTH_PASSWORD_HASH');
    expect(problems.join()).not.toContain('plaintext-sentinel-value');
  });

  it('rejects a truncated bcrypt hash', () => {
    expect(validateAuthEnv({ ...good, AUTH_PASSWORD_HASH: goodHash.slice(0, 40) })).toHaveLength(1);
  });

  it('rejects a short JWT_SECRET, naming the variable but not the value', () => {
    const problems = validateAuthEnv({ ...good, JWT_SECRET: 'short-sentinel-secret' });
    expect(problems[0]).toContain('JWT_SECRET');
    expect(problems.join()).not.toContain('short-sentinel-secret');
  });
});

describe('startup with a bad configuration', () => {
  function boot(overrides) {
    return spawnSync('node', ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        DB_PATH: path.join(os.tmpdir(), 'butler-config-validation-never-created.db'),
        PORT: '0',
        ...good,
        ...overrides,
      },
      encoding: 'utf8',
      timeout: 20000,
    });
  }

  it('exits non-zero naming AUTH_PASSWORD_HASH without echoing it', () => {
    const run = boot({ AUTH_PASSWORD_HASH: 'plaintext-sentinel-value' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('AUTH_PASSWORD_HASH');
    expect(run.stderr + run.stdout).not.toContain('plaintext-sentinel-value');
  });

  it('exits non-zero naming JWT_SECRET without echoing it', () => {
    const run = boot({ JWT_SECRET: 'short-sentinel-secret' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('JWT_SECRET');
    expect(run.stderr + run.stdout).not.toContain('short-sentinel-secret');
  });
});

describe('numeric limits fall back instead of accepting unsafe values', () => {
  it.each(['-1', '0', 'Infinity', '2.5', 'abc', '99999999999'])('INVOICE_IMPORT_MAX_LINES=%s uses the default', async (bad) => {
    const { createRequire } = await import('module');
    const req = createRequire(import.meta.url);
    process.env.INVOICE_IMPORT_MAX_LINES = bad;
    process.env.LOGIN_RATE_LIMIT_MAX = bad;
    const path = req.resolve('../lib/config');
    delete req.cache[path];
    try {
      const fresh = req('../lib/config');
      expect([fresh.INVOICE_IMPORT_MAX_LINES, fresh.LOGIN_RATE_LIMIT_MAX]).toEqual([250, 5]);
    } finally {
      delete process.env.INVOICE_IMPORT_MAX_LINES;
      delete process.env.LOGIN_RATE_LIMIT_MAX;
      delete req.cache[path];
    }
  });
});

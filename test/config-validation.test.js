import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import os from 'os';
import path from 'path';
import bcrypt from 'bcryptjs';
import './setup.js';
import config from '../lib/config.js';

const { validateAuthEnv } = config;
const goodHash = bcrypt.hashSync('pw', 10);
const goodSecret = 'a1'.repeat(32);
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

  it.each(['00', '04', '09', '32', '99'])('rejects a bcrypt cost of %s (accepted range is 10-31)', (cost) => {
    const problems = validateAuthEnv({ ...good, AUTH_PASSWORD_HASH: goodHash.replace(/^(\$2[aby]\$)\d\d/, `$1${cost}`) });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('AUTH_PASSWORD_HASH');
    expect(problems[0]).not.toContain(goodHash.slice(7));
  });

  it.each(['10', '12', '31'])('accepts a bcrypt cost of %s', (cost) => {
    expect(validateAuthEnv({ ...good, AUTH_PASSWORD_HASH: goodHash.replace(/^(\$2[aby]\$)\d\d/, `$1${cost}`) })).toEqual([]);
  });

  it('rejects a truncated bcrypt hash', () => {
    expect(validateAuthEnv({ ...good, AUTH_PASSWORD_HASH: goodHash.slice(0, 40) })).toHaveLength(1);
  });

  it.each([
    ['short-sentinel-secret', 'a short passphrase'],
    ['a1'.repeat(31), 'only 31 bytes of hex'],
    [`${'a1'.repeat(32)}b`, 'odd-length hex'],
    ['sentinel-passphrase-'.repeat(4), 'a long human-chosen passphrase (not hex)'],
    [`${'a1'.repeat(31)}zz`, 'hex with a non-hex pair'],
    ['0x' + 'a1'.repeat(32), 'a 0x-prefixed value'],
  ])('rejects %s (%s) for JWT_SECRET, naming the variable but not the value', (secret) => {
    const problems = validateAuthEnv({ ...good, JWT_SECRET: secret });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('JWT_SECRET');
    expect(problems.join()).not.toContain(secret);
  });

  it('accepts 32 bytes of hex in either case, and longer', () => {
    for (const secret of ['A1'.repeat(32), 'a1'.repeat(48)]) expect(validateAuthEnv({ ...good, JWT_SECRET: secret })).toEqual([]);
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

describe('every bounded integer setting falls back on a bad value and honours a good one', async () => {
  const { createRequire } = await import('module');
  const req = createRequire(import.meta.url);
  const configPath = req.resolve('../lib/config');
  function loadConfig(env) {
    const saved = {};
    for (const [key, value] of Object.entries(env)) { saved[key] = process.env[key]; process.env[key] = value; }
    delete req.cache[configPath];
    try {
      return { ...req('../lib/config') };
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      delete req.cache[configPath];
    }
  }

  // [variable, exported name, default, a good value, bad values]
  const common = ['-1', '0', 'Infinity', '2.5', 'abc', '', ' ', '1e3', '0x10', '99999999999'];
  it.each([
    ['INVOICE_IMPORT_RETENTION_DAYS', 'INVOICE_IMPORT_RETENTION_DAYS', 30, '90', [...common, '3651']],
    ['PDF_PARSE_TIMEOUT_MS', 'PDF_PARSE_TIMEOUT_MS', 20000, '5000', [...common, '600001']],
    ['PDF_WORKER_MEMORY_MB', 'PDF_WORKER_MEMORY_MB', 256, '128', [...common, '1', '63', '4097']],
    ['INVOICE_IMPORT_MAX_LINES', 'INVOICE_IMPORT_MAX_LINES', 250, '100', [...common, '1001']],
    ['INVOICE_MATCH_MAX_ITEMS', 'INVOICE_MATCH_MAX_ITEMS', 400, '100', [...common, '2001']],
    ['HEAVY_WORK_CONCURRENCY', 'HEAVY_WORK_CONCURRENCY', 2, '4', [...common, '33']],
    ['SOCKET_HANDSHAKE_RATE_LIMIT_MAX', 'SOCKET_HANDSHAKE_RATE_LIMIT_MAX', 60, '30', [...common, '100001']],
    ['SOCKET_MAX_PER_CLIENT', 'SOCKET_MAX_PER_CLIENT', 20, '5', [...common, '10001']],
    ['SOCKET_MAX_TOTAL', 'SOCKET_MAX_TOTAL', 200, '50', [...common, '100001']],
    ['PORT', 'PORT', 2626, '8080', ['-1', 'Infinity', '2.5', 'abc', '', ' ', '1e3', '0x10', '65536', '99999999999']],
  ])('%s', (variable, exported, fallback, good, bad) => {
    expect(loadConfig({ [variable]: '' })[exported]).toBe(fallback); // unset/blank (the suite itself sets PORT)
    expect(loadConfig({ [variable]: good })[exported]).toBe(Number(good));
    for (const value of bad) expect(loadConfig({ [variable]: value })[exported], `${variable}=${JSON.stringify(value)}`).toBe(fallback);
  });

  it('PORT=0 is kept (any free port), and the number is what server.listen receives', () => {
    expect(loadConfig({ PORT: '0' }).PORT).toBe(0);
    expect(loadConfig({ PORT: '2626' }).PORT).toBe(2626);
  });

  it('HEAVY_WORK_QUEUE accepts 0 (no waiting) and falls back on junk', () => {
    expect(loadConfig({})).toMatchObject({ HEAVY_WORK_QUEUE: 4 });
    expect(loadConfig({ HEAVY_WORK_QUEUE: '0' }).HEAVY_WORK_QUEUE).toBe(0);
    expect(loadConfig({ HEAVY_WORK_QUEUE: '12' }).HEAVY_WORK_QUEUE).toBe(12);
    for (const bad of ['-1', 'x', '', '1.5', '1001', 'Infinity']) expect(loadConfig({ HEAVY_WORK_QUEUE: bad }).HEAVY_WORK_QUEUE, bad).toBe(4);
  });
});

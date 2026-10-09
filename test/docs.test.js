// CLAUDE.md is read as the map of this codebase; these keep it from drifting away from the code.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import os from 'os';
import { createRequire } from 'module';
import './setup.js';

const require = createRequire(import.meta.url);
const repo = path.resolve(import.meta.dirname, '..');
const claude = fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8');
const list = (dir, ext) => fs.readdirSync(path.join(repo, dir)).filter((f) => ext.test(f));

describe('CLAUDE.md names every module', () => {
  it.each([
    ...list('lib', /\.js$/).map((f) => `lib/${f}`),
    ...list('parsers', /\.js$/).map((f) => `parsers/${f.replace(/\.js$/, '')}`),
    ...list('scripts', /\.(js|sh)$/).map((f) => `scripts/${f}`),
    ...list('.', /\.js$/).filter((f) => !/config\.js$/.test(f)).map((f) => f),
    ...list('routes', /\.js$/).map((f) => f.replace(/\.js$/, '')),
  ])('%s', (name) => {
    const short = path.basename(name).replace(/\.js$/, '');
    // a module may be named by path, by file name, or (parsers/routes) by its group; lib/pdf-text.js and
    // lib/pdf-worker.js are documented together as "lib/pdf-text.js / lib/pdf-worker.js"
    expect(claude.includes(name) || claude.includes(`${short}.js`) || claude.includes(`\`${short}\``) || claude.includes(`\`${short}.js\``), `${name} is not mentioned in CLAUDE.md`).toBe(true);
  });
});

describe('CLAUDE.md lists every live table and every environment variable', () => {
  it('"Live schema tables" names each table in a fresh database', () => {
    const file = path.join(os.tmpdir(), `butler-docs-${process.pid}.db`);
    const { openDatabase } = require('../lib/database');
    const saved = process.env.DB_PATH;
    process.env.DB_PATH = file;
    try {
      const { db } = openDatabase();
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
      db.close();
      const section = claude.slice(claude.indexOf('- Live schema tables:'), claude.indexOf('## Container runtime'));
      for (const table of tables) expect(section, `table ${table}`).toContain(table);
    } finally {
      process.env.DB_PATH = saved;
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    }
  });

  it('every environment variable the server reads is documented', () => {
    const sources = ['server.js', 'logger.js', 'backup.js', 'db-migrations.js', 'item-matching.js']
      .concat(list('lib', /\.js$/).map((f) => `lib/${f}`), list('routes', /\.js$/).map((f) => `routes/${f}`));
    const names = new Set();
    for (const file of sources) {
      const text = fs.readFileSync(path.join(repo, file), 'utf8');
      for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)|boundedIntegerEnv\('([A-Z][A-Z0-9_]+)'/g)) names.add(m[1] || m[2]);
    }
    expect(names.size).toBeGreaterThan(20);
    for (const name of names) expect(claude, `${name} is not documented in CLAUDE.md`).toContain(name);
  });

  it('does not describe things that no longer exist', () => {
    expect(claude).not.toMatch(/parseIntOrNull/);
    expect(claude).not.toMatch(/`public\/` now only holds/);
  });
});

describe('client-IP / proxy guidance matches the verified topology', () => {
  const read = (f) => fs.readFileSync(path.join(repo, f), 'utf8');

  it('CLAUDE.md describes Cloudflare DNS -> port-forward -> NPM -> proxynet, not the tunnel', () => {
    for (const phrase of ['does NOT use the cloudflared', 'Cloudflare-proxied', 'router port-forward', '172.18.0.5', 'CF-Connecting-IP', 'set_real_ip_from', 'AdGuardHome', 'Remove the host publish of port 2626']) {
      expect(claude, phrase).toContain(phrase);
    }
  });

  it('nothing recommends trusting docker0 (172.17.0.0/16) any more', () => {
    for (const file of ['CLAUDE.md', 'docker-compose.yml', 'server.js']) expect(read(file), file).not.toContain('172.17.0.0/16,172.18.0.0/16');
    expect(read('docker-compose.yml')).not.toMatch(/^\s*-\s*TRUST_PROXY=.*172\.17/m);
    // history is kept, but every old recommendation is marked as superseded
    for (const line of read('CHANGELOG.md').split('\n').filter((l) => l.includes('TRUST_PROXY=172.17'))) expect(line).toContain('superseded in 0.46');
  });

  it('the compose comment and the startup warning say the same thing as CLAUDE.md', () => {
    const compose = read('docker-compose.yml');
    expect(compose).toMatch(/e\.g\. TRUST_PROXY=172\.18\.0\.5/);
    expect(compose).toContain('CF-Connecting-IP');
    const server = read('server.js');
    const warning = server.split('\n').find((l) => l.includes('TRUST_PROXY is "none"'));
    expect(warning).toContain('CF-Connecting-IP');
    expect(warning).toContain('Client IP and rate limits');
    expect(warning).not.toContain('172.17');
  });
});

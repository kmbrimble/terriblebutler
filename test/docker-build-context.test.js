// Guards for the image's build inputs: what is excluded from the context, what the runtime stage
// copies, and the single storage path that Dockerfile, entrypoint, config and compose share.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const repo = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(repo, f), 'utf8');
const dockerfile = read('Dockerfile');
const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));

describe('.dockerignore', () => {
  const rules = read('.dockerignore').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  it.each(['.git', 'node_modules', 'public/uploads/', 'data/'])('excludes %s from the build context', (rule) => expect(rules).toContain(rule));

  // Docker's matching: `**/` is any directory depth (including none), `*` stays within one path
  // segment, and a trailing `/` means a directory and everything under it.
  const toRegExp = (rule) => {
    const body = rule.replace(/\/$/, '').replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\//g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '(?:.*/)?');
    return new RegExp(`^${body}(?:/.*)?$`);
  };
  const ignored = (file) => rules.some((rule) => toRegExp(rule).test(file));

  it.each([
    '.env', '.env.local', '.env.production', 'client/.env', 'client/.env.production', 'a/b/c/.env',
    'server.pem', 'certs/server.pem', 'tls/private.key', 'client/deploy.key', 'bundle.p12', 'x/bundle.pfx',
    '.npmrc', 'client/.npmrc', '.netrc', 'home/.netrc', '.aws/credentials', 'x/.aws/config', '.ssh/id_rsa', 'x/.ssh/known_hosts',
    'id_rsa', 'id_rsa.pub', 'keys/id_rsa', 'id_ed25519', 'keys/id_ed25519.pub',
  ])('keeps the secret-looking file %s out of the build context', (file) => expect(ignored(file), file).toBe(true));

  it.each([
    'server.js', 'package.json', 'lib/config.js', 'client/src/main.tsx', 'client/package.json', 'docker-entrypoint.sh', 'routes/auth.js',
    'client/public/theme-init.js', 'scripts/generate-password-hash.js', 'lib/environment.js',
  ])('does not exclude %s, which the build needs', (file) => expect(ignored(file), file).toBe(false));
});

describe('docker-compose.yml', () => {
  const compose = read('docker-compose.yml');
  const live = compose.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

  it('has no obsolete top-level version key', () => expect(compose).not.toMatch(/^version:/m));

  it('does not publish the Node port on any host interface by default (constraint #8)', () => {
    expect(live).not.toMatch(/^\s*ports:/m);
    expect(live).not.toMatch(/2626:2626/);
  });

  it('shows a loopback-only publish for local development, commented out', () => {
    expect(compose).toMatch(/^\s*#\s*- "127\.0\.0\.1:2626:2626"/m);
  });

  it('attaches to the reverse proxy network, declared external', () => {
    expect(live).toMatch(/networks:\s*\n\s*- proxynet/);
    expect(live).toMatch(/^networks:\s*\n\s*proxynet:\s*\n(?:\s*#.*\n)?\s*external: true/m);
  });

  it('passes TRUST_PROXY and APP_ORIGIN through, empty by default (test/trust-proxy.test.js shows the app reads empty as unset)', () => {
    expect(live).toMatch(/- TRUST_PROXY=\$\{TRUST_PROXY:-\}/);
    expect(live).toMatch(/- APP_ORIGIN=\$\{APP_ORIGIN:-\}/);
  });

  it('keeps the data and uploads mounts and the TRUST_PROXY guidance, including the gateway warning and the NPM client-IP requirement', () => {
    expect(live).toMatch(/- \.\/data:\/app\/data/);
    expect(live).toMatch(/- \.\/uploads:\/app\/public\/uploads/);
    expect(compose).toMatch(/TRUST_PROXY=/);
    expect(compose).toMatch(/gateway/i);
    expect(compose).toMatch(/CF-Connecting-IP/);
    expect(compose).toMatch(/NPM/);
  });
});

describe('runtime stage copies an explicit allow-list', () => {
  const copies = [...runtimeStage.matchAll(/^COPY (?!--from)(?:--chmod=\d+ )?(.+)$/gm)].map((m) => m[1].trim().split(/\s+/));

  it('never uses a wholesale COPY . or copies the client source', () => {
    expect(runtimeStage).not.toMatch(/^COPY (--\S+ )*\.\s/m);
    for (const parts of copies) for (const src of parts.slice(0, -1)) {
      expect(src).not.toMatch(/^client\/?$/);
      expect(src).not.toBe('.');
    }
  });

  it('includes every local module reachable from server.js (and the helper scripts)', () => {
    const copied = new Set(copies.flatMap((p) => p.slice(0, -1)).map((p) => p.replace(/\/$/, '')));
    const covered = (rel) => [...copied].some((c) => rel === c || rel.startsWith(`${c}/`));
    const seen = new Set();
    const walk = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      const rel = path.relative(repo, file);
      expect(covered(rel), `${rel} is required at run time but is not COPY'd into the runtime stage`).toBe(true);
      for (const m of fs.readFileSync(file, 'utf8').matchAll(/require\(\s*'(\.{1,2}\/[^']+)'\s*\)/g)) {
        walk(require.resolve(path.resolve(path.dirname(file), m[1])));
      }
    };
    walk(path.join(repo, 'server.js'));
    walk(path.join(repo, 'scripts/generate-password-hash.js'));
    expect(seen.size).toBeGreaterThan(20);
  });

  it('does not copy tests, docs or e2e into the image', () => {
    for (const parts of copies) for (const src of parts.slice(0, -1)) {
      expect(src).not.toMatch(/^(test|test-e2e|client|\.github)\b/);
    }
  });
});

describe('UPLOADS_DIR default is the bind-mount target', () => {
  const TARGET = '/app/public/uploads';

  it('Dockerfile sets ENV UPLOADS_DIR and WORKDIR /app', () => {
    expect(runtimeStage).toMatch(/UPLOADS_DIR=\/app\/public\/uploads(\s|\\|$)/);
    expect(runtimeStage).toMatch(/^WORKDIR \/app$/m);
    expect(runtimeStage).toMatch(/WRITABLE_ROOT=\/app(\s|\\|$)/);
  });

  it('entrypoint defaults to the same directory and chowns inside the same root', () => {
    const ep = read('docker-entrypoint.sh');
    expect(ep).toContain('UPLOADS="${UPLOADS_DIR:-$APP_ROOT/public/uploads}"');
    expect(ep).toMatch(/^APP_ROOT=\/app$/m);
  });

  it('docker-compose mounts uploads at the same target', () => {
    expect(read('docker-compose.yml')).toMatch(new RegExp(`:${TARGET}\\s*$`, 'm'));
  });

  it('lib/config.js defaults to <app dir>/public/uploads (= the target when the app lives in /app)', () => {
    const saved = process.env.UPLOADS_DIR;
    delete process.env.UPLOADS_DIR;
    process.env.AUTH_USERNAME ??= 'u';
    process.env.AUTH_PASSWORD_HASH ??= `$2b$10$${'a'.repeat(53)}`;
    process.env.JWT_SECRET ??= 'a'.repeat(64);
    const modPath = require.resolve('../lib/config');
    delete require.cache[modPath];
    try {
      expect(require('../lib/config').UPLOADS_DIR).toBe(path.join(repo, 'public', 'uploads'));
    } finally {
      delete require.cache[modPath];
      if (saved !== undefined) process.env.UPLOADS_DIR = saved;
    }
  });
});

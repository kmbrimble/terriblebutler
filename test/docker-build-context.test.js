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
  const rules = read('.dockerignore').split('\n').map((l) => l.trim());
  it.each(['.env', '.env.*', '*.pem', '*.key', '.npmrc', '.git', 'node_modules', 'public/uploads/', 'data/'])(
    'excludes %s from the build context', (rule) => expect(rules).toContain(rule));
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
    process.env.JWT_SECRET ??= 'x'.repeat(32);
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

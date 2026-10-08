// docker-entrypoint.sh runs as root and chowns recursively, so its input validation and
// privilege drop are tested without Docker: the script runs under sh against a temp APP_ROOT
// with `id`, `find` and `setpriv` stubbed on PATH (the stubs record their arguments).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
process.env.AUTH_USERNAME ??= 'u';
process.env.AUTH_PASSWORD_HASH ??= `$2b$10$${'a'.repeat(53)}`;
process.env.JWT_SECRET ??= 'x'.repeat(32);
const { validateStoragePaths } = require('../lib/config');

const repo = path.resolve(import.meta.dirname, '..');
const script = fs.readFileSync(path.join(repo, 'docker-entrypoint.sh'), 'utf8');
let sandbox;
let root;
let bin;
let logFile;

beforeAll(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-entrypoint-'));
  root = path.join(sandbox, 'app');
  bin = path.join(sandbox, 'bin');
  logFile = path.join(sandbox, 'calls.log');
  fs.mkdirSync(root);
  fs.mkdirSync(bin);
  const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  stub('id', '[ "$1" = "-u" ] && echo "${STUB_UID:-0}"');
  stub('find', 'echo "find $*" >> "$STUB_LOG"');
  stub('setpriv', 'echo "setpriv $*" >> "$STUB_LOG"');
  // The only edit to the production script: point APP_ROOT at the sandbox.
  expect(script).toMatch(/^APP_ROOT=\/app$/m);
  fs.writeFileSync(path.join(sandbox, 'entrypoint.sh'), script.replace(/^APP_ROOT=\/app$/m, `APP_ROOT=${root}`));
});
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

function run(env = {}, args = ['node', 'server.js']) {
  fs.rmSync(logFile, { force: true });
  const res = spawnSync('sh', [path.join(sandbox, 'entrypoint.sh'), ...args], {
    env: { PATH: `${bin}:/usr/bin:/bin`, STUB_LOG: logFile, ...env },
    encoding: 'utf8',
  });
  const calls = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n') : [];
  return { ...res, calls };
}

describe('PUID / PGID', () => {
  it.each([
    [{ PUID: 'abc' }], [{ PGID: '1x' }], [{ PUID: '-5' }], [{ PUID: '1 2' }], [{ PUID: '' , PGID: 'a' }],
  ])('rejects non-numeric ids %j before touching anything', (env) => {
    const res = run(env);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('PUID and PGID must be numeric');
    expect(res.calls).toEqual([]);
  });

  it.each([[{ PUID: '0' }], [{ PGID: '0' }], [{ PUID: '00' }]])('refuses to run the app as root %j', (env) => {
    const res = run(env);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('refusing to run the app as root');
    expect(res.calls).toEqual([]);
  });

  it('defaults to 99:100', () => {
    const res = run();
    expect(res.status).toBe(0);
    expect(res.calls.at(-1)).toBe('setpriv --reuid=99 --regid=100 --clear-groups --no-new-privs node server.js');
  });
});

describe('privilege drop', () => {
  it('chowns, then drops permanently and execs the command with its arguments intact', () => {
    const res = run({ PUID: '1234', PGID: '5678' }, ['node', 'server.js', '--flag', 'two words']);
    expect(res.status).toBe(0);
    expect(res.calls.at(-1)).toBe('setpriv --reuid=1234 --regid=5678 --clear-groups --no-new-privs node server.js --flag two words');
    // every chown happens before the drop, and setpriv is last
    expect(res.calls.filter((c) => c.startsWith('setpriv'))).toHaveLength(1);
    expect(res.calls.findIndex((c) => c.startsWith('setpriv'))).toBe(res.calls.length - 1);
  });

  it('does nothing but exec when already started as a non-root user', () => {
    const res = run({ STUB_UID: '1000' }, ['echo', 'ran-directly']);
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe('ran-directly');
    expect(res.calls).toEqual([]);
  });
});

describe('chown scope', () => {
  it('prepares exactly the data, uploads and log directories by default', () => {
    const res = run();
    const finds = res.calls.filter((c) => c.startsWith('find'));
    expect(finds.map((c) => c.split(' ')[1])).toEqual([`${root}/data`, `${root}/public/uploads`, `${root}/logs`]);
    for (const f of finds) {
      expect(f).toContain('-xdev');
      expect(f).toContain('chown -h 99:100 {} +');
    }
    for (const d of ['data', 'public/uploads', 'logs']) expect(fs.statSync(path.join(root, d)).isDirectory()).toBe(true);
  });

  it('honours DB_PATH, UPLOADS_DIR and LOG_DIR inside the app root', () => {
    const res = run({ DB_PATH: `${root}/db/inv.db`, UPLOADS_DIR: `${root}/media`, LOG_DIR: `${root}/var/log` });
    expect(res.status).toBe(0);
    expect(res.calls.filter((c) => c.startsWith('find')).map((c) => c.split(' ')[1]))
      .toEqual([`${root}/db`, `${root}/media`, `${root}/var/log`]);
  });

  it('refuses a symlink that leads outside the app root, without chowning', () => {
    const outside = path.join(sandbox, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, 'escape'));
    const res = run({ UPLOADS_DIR: `${root}/escape` });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('resolves outside');
    expect(res.calls.some((c) => c.startsWith('setpriv'))).toBe(false);
  });
});

// One table drives the shell script and lib/config.js so they cannot drift apart. `{R}` is the app
// root; `ok` says whether both must accept the combination.
const R = '{R}';
const cases = [
  ['defaults', {}, true],
  ['custom data dir', { DB_PATH: `${R}/storage/inv.db` }, true],
  ['DB_PATH at the root of the filesystem (mistyped)', { DB_PATH: '/x.db' }, false],
  ['DB_PATH directly in the app root (would chown the app)', { DB_PATH: `${R}/x.db` }, false],
  ['DB_PATH outside the app root', { DB_PATH: '/data/inv.db' }, false],
  ['DB_PATH relative', { DB_PATH: 'data/inv.db' }, false],
  ['DB_PATH with ..', { DB_PATH: `${R}/data/../../etc/inv.db` }, false],
  ['DB_PATH with a dot segment', { DB_PATH: `${R}/./data/inv.db` }, false],
  ['DB_PATH with a double slash', { DB_PATH: `${R}//data/inv.db` }, false],
  ['DB_PATH with a trailing slash', { DB_PATH: `${R}/data/` }, false],
  ['DB_PATH with a space', { DB_PATH: `${R}/my data/inv.db` }, false],
  ['DB_PATH with a glob character', { DB_PATH: `${R}/da*ta/inv.db` }, false],
  ['DB directory inside the code', { DB_PATH: `${R}/lib/inv.db` }, false],
  ['DB directory is node_modules', { DB_PATH: `${R}/node_modules/inv.db` }, false],
  ['UPLOADS_DIR is /', { UPLOADS_DIR: '/' }, false],
  ['UPLOADS_DIR is a system directory', { UPLOADS_DIR: '/etc' }, false],
  ['UPLOADS_DIR is the app root', { UPLOADS_DIR: R }, false],
  ['UPLOADS_DIR is the client source', { UPLOADS_DIR: `${R}/client` }, false],
  ['UPLOADS_DIR relative', { UPLOADS_DIR: 'uploads' }, false],
  ['UPLOADS_DIR sibling of the app root', { UPLOADS_DIR: `${R}-evil/uploads` }, false],
  ['LOG_DIR is /var/log', { LOG_DIR: '/var/log' }, false],
  ['LOG_DIR is the app root', { LOG_DIR: R }, false],
  ['LOG_DIR contains the data dir', { LOG_DIR: `${R}/data` }, false],
  ['UPLOADS_DIR is inside the data dir', { UPLOADS_DIR: `${R}/data/uploads` }, false],
  ['UPLOADS_DIR is the data dir', { UPLOADS_DIR: `${R}/data` }, false],
  ['LOG_DIR inside uploads', { LOG_DIR: `${R}/public/uploads/logs` }, false],
  ['separate nested-looking names are fine', { UPLOADS_DIR: `${R}/data2`, LOG_DIR: `${R}/data-logs` }, true],
];

describe('path validation: entrypoint and lib/config.js agree', () => {
  it.each(cases)('%s', (_name, env, ok) => {
    const sub = (v) => v.replaceAll(R, root);
    const resolved = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, sub(v)]));
    const shell = run(resolved);
    const problems = validateStoragePaths({ ...resolved, WRITABLE_ROOT: root }, root);
    expect(shell.status === 0).toBe(ok);
    expect(problems.length === 0).toBe(ok);
    if (!ok) {
      expect(shell.stderr).toMatch(/^entrypoint: /);
      expect(shell.calls).toEqual([]); // refused before any find/chown/setpriv
    }
  });

  it('the container defaults pass the app-side check at /app', () => {
    expect(validateStoragePaths({}, '/app')).toEqual([]);
    expect(validateStoragePaths({ DB_PATH: '/x.db' }, '/app')).toEqual(['DB_PATH must be inside /app.']);
  });

  it('config only enforces containment when WRITABLE_ROOT is set, but always enforces the form', () => {
    expect(validateStoragePaths({ DB_PATH: '/tmp/some/inv.db' }, undefined)).toEqual([]);
    expect(validateStoragePaths({ DB_PATH: '/tmp/../inv.db' }, undefined)).toHaveLength(1);
  });
});

describe('UPLOAD_TMP_DIR (swept at startup, so it must not overlap data)', () => {
  it('rejects a scratch dir that is the uploads dir, inside the data dir, or malformed', () => {
    expect(validateStoragePaths({ UPLOAD_TMP_DIR: '/app/public/uploads' }, '/app')).toHaveLength(1);
    expect(validateStoragePaths({ UPLOAD_TMP_DIR: '/app/data/tmp' }, '/app')).toHaveLength(1);
    expect(validateStoragePaths({ UPLOAD_TMP_DIR: 'tmp' }, '/app')).toHaveLength(1);
  });
  it('accepts a separate scratch dir, inside or outside /app', () => {
    expect(validateStoragePaths({ UPLOAD_TMP_DIR: '/tmp/butler-upload-tmp' }, '/app')).toEqual([]);
    expect(validateStoragePaths({ UPLOAD_TMP_DIR: '/app/scratch' }, '/app')).toEqual([]);
  });
});

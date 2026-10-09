// Every shell script in the repo must be clean under a pinned ShellCheck (scripts/ensure-shellcheck.js
// fetches v0.11.0 once into node_modules/.cache and verifies its SHA-256). A warning is a failure.
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { ensureShellcheck, VERSION } = require('../scripts/ensure-shellcheck.js');
const repo = path.resolve(import.meta.dirname, '..');

function shellScripts(dir = repo) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', '.git', 'dist'].includes(entry.name)) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return shellScripts(full);
    return entry.name.endsWith('.sh') ? [path.relative(repo, full)] : [];
  });
}

describe('shellcheck', () => {
  let bin;
  beforeAll(async () => { bin = await ensureShellcheck(); }, 120_000);

  it(`runs the pinned ShellCheck ${VERSION}`, () => {
    expect(spawnSync(bin, ['--version'], { encoding: 'utf8' }).stdout).toContain(`version: ${VERSION}`);
  });

  it('finds the shell scripts it is meant to check', () => {
    expect(shellScripts()).toEqual(expect.arrayContaining(['docker-entrypoint.sh', 'scripts/docker-smoke.sh']));
  });

  it.each(shellScripts())('%s has no ShellCheck findings', (script) => {
    const run = spawnSync(bin, ['--severity=style', '--shell=sh', script], { cwd: repo, encoding: 'utf8' });
    expect(run.stdout + run.stderr).toBe('');
    expect(run.status).toBe(0);
  });

  it('actually reports a problem when there is one (the check is not vacuous)', () => {
    const run = spawnSync(bin, ['--shell=sh', '-'], { input: '#!/bin/sh\nrm -rf $UNQUOTED/*\n', encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(run.stdout).toMatch(/SC2086/);
  });
});

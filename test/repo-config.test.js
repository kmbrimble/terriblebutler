// Guards for repository and CI configuration that has no other test: Renovate (which replaced Dependabot when the
// repo moved to Gitea), the CI/publish workflow split, and the documented Dockerfile exceptions.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const repo = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(repo, f), 'utf8');

describe('renovate.json (replaces .github/dependabot.yml)', () => {
  const config = JSON.parse(read('renovate.json'));

  it('covers npm (server and client), the Dockerfile and GitHub/Gitea Actions', () => {
    expect(config.enabledManagers).toEqual(['npm', 'dockerfile', 'github-actions']);
    const files = config.packageRules.flatMap((r) => r.matchFileNames ?? []);
    expect(files).toContain('package.json');
    expect(files).toContain('client/package.json');
  });

  it('keeps the release-age cooldown on version updates (at least a week)', () => {
    expect(config.minimumReleaseAge).toMatch(/^([7-9]|\d\d+) days$/);
    // Semgrep (p/default) also wants it inside the packageRules, so every rule carries it
    for (const rule of config.packageRules) expect(rule.minimumReleaseAge, rule.description).toMatch(/^([7-9]|\d\d+) days$/);
  });

  it('is run by a scheduled Gitea workflow that uses a Gitea token and only a read-only GitHub lookup token', () => {
    const wf = read('.gitea/workflows/renovate.yml');
    expect(wf).toMatch(/^\s+- cron: /m);
    expect(wf).toMatch(/RENOVATE_PLATFORM: gitea/);
    expect(wf).toMatch(/RENOVATE_TOKEN: \$\{\{ secrets\.RENOVATE_TOKEN \}\}/);
    // the one GitHub credential allowed is the read-only lookup token (org secret), passed as Renovate's own env name
    expect(wf).toMatch(/RENOVATE_GITHUB_COM_TOKEN: \$\{\{ secrets\.RENOVATE_GITHUB_COM_TOKEN \}\}/);
    expect(wf.replace(/RENOVATE_GITHUB_COM_TOKEN/g, '')).not.toMatch(/GITHUB_COM_TOKEN|GH_TOKEN|GITHUB_TOKEN/);
  });

  it('the Claude Code GitHub action and Dependabot are gone', () => {
    expect(fs.existsSync(path.join(repo, '.github/workflows/claude.yml'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.github/dependabot.yml'))).toBe(false);
  });
});

describe('Dockerfile exceptions are documented', () => {
  const dockerfile = read('Dockerfile');

  it('the unpinned builder-stage apt-get carries a hadolint ignore directly above it, with the reason', () => {
    expect(dockerfile).toMatch(/# hadolint ignore=DL3008\nRUN apt-get update/);
    expect(dockerfile).toMatch(/Not pinned, deliberately \(hadolint DL3008\)/);
  });

  it('the root entrypoint is annotated for the scanner, naming the rule', () => {
    expect(dockerfile).toMatch(/# nosemgrep: dockerfile\.security\.missing-user-entrypoint\.missing-user-entrypoint -- .+\nENTRYPOINT/);
    expect(dockerfile).toMatch(/# nosemgrep: dockerfile\.security\.missing-user\.missing-user -- .+\nCMD/);
  });
});

describe('inline scanner suppressions are precise', () => {
  const files = ['server.js', 'backup.js', 'lib/uploads.js', 'Dockerfile', 'scripts/ensure-shellcheck.js', 'test-e2e/auth-fixtures.cjs', 'test-e2e/v2-feedback-and-locations.spec.js'];

  it('every nosemgrep names a rule id and gives a reason', () => {
    let count = 0;
    for (const file of files) {
      for (const line of read(file).split('\n').filter((l) => l.includes('nosemgrep'))) {
        count += 1;
        expect(line, `${file}: ${line.trim()}`).toMatch(/nosemgrep: [a-z0-9_.-]+\.[a-z0-9_.-]+ -- \S/);
      }
    }
    expect(count).toBeGreaterThan(10);
  });
});

describe('dependencies', () => {
  const pkg = JSON.parse(read('package.json'));
  const sources = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(path.join(repo, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!['node_modules', 'client', 'test', 'test-e2e', 'public', '.git', 'data'].includes(entry.name)) walk(rel); }
      else if (/\.(js|cjs|mjs)$/.test(entry.name)) sources.push(read(rel));
    }
  })('.');
  const all = sources.join('\n');

  it.each(Object.keys(pkg.dependencies))('production dependency %s is actually required by the server code', (name) => {
    expect(all, `${name} is listed in dependencies but nothing requires it`).toMatch(new RegExp(`require\\(\\s*['"]${name.replace(/[/.]/g, '\\$&')}['"]\\s*\\)`));
  });

  it('cors is not a direct dependency (Socket.IO and engine.io bring their own)', () => {
    expect(pkg.dependencies.cors).toBeUndefined();
    expect(all).not.toMatch(/require\(\s*['"]cors['"]\s*\)/);
  });
});

describe('npm install scripts are an explicit allow-list', () => {
  it('root: better-sqlite3 (its native build) is allowed, fsevents (macOS-only watcher) is denied', () => {
    expect(JSON.parse(read('package.json')).allowScripts).toEqual({ 'better-sqlite3': true, fsevents: false });
  });

  it('client: no dependency may run install scripts (fsevents denied explicitly)', () => {
    expect(JSON.parse(read('client/package.json')).allowScripts).toEqual({ fsevents: false });
  });

  it('both projects ask npm to enforce the list (.npmrc), as does every npm ci in the Dockerfile, which first asserts the policy', () => {
    expect(read('.npmrc')).toMatch(/^strict-allow-scripts=true$/m);
    expect(read('client/.npmrc')).toMatch(/^strict-allow-scripts=true$/m);
    for (const f of ['.npmrc', 'client/.npmrc']) expect(read(f), f).toMatch(/^min-release-age=([7-9]|\d\d+)$/m);
    const installs = read('Dockerfile').split('\n').filter((l) => /^\s*(RUN|&&) npm ci\b/.test(l));
    expect(installs).toHaveLength(2);
    for (const line of installs) expect(line).toContain('--strict-allow-scripts');
    // the build asserts the allowScripts policy itself before installing (a require() of the module would pass on a prebuilt binary)
    expect(read('Dockerfile')).toMatch(/RUN node -e "const a = require\('\.\/package\.json'\)\.allowScripts[^\n]*better-sqlite3'\] !== true \|\| a\.fsevents !== false[^\n]*\\\n\s+&& npm ci --omit=dev --strict-allow-scripts/);
  });

  it('every dependency with an install script in the lockfiles is covered by a decision', () => {
    for (const [lockfile, project] of [['package-lock.json', 'package.json'], ['client/package-lock.json', 'client/package.json']]) {
      const decided = Object.keys(JSON.parse(read(project)).allowScripts ?? {});
      const withScripts = Object.entries(JSON.parse(read(lockfile)).packages)
        .filter(([, meta]) => meta.hasInstallScript).map(([key]) => key.replace(/^.*node_modules\//, ''));
      for (const name of withScripts) expect(decided, `${name} (${lockfile}) has an install script but no allowScripts decision`).toContain(name);
    }
  });
});

describe('CI and publishing workflows (the Gitea gate gates merges; a separate Gitea workflow publishes the image to the Gitea registry)', () => {
  const ci = read('.gitea/workflows/ci.yml');
  const build = read('.gitea/workflows/image.yml');
  const gate = ci.slice(ci.indexOf('\n  gate:'));

  it('every action in every workflow is pinned to a full commit SHA (with its version in a comment)', () => {
    for (const workflow of [ci, build]) {
      const uses = [...workflow.matchAll(/^\s*uses:\s*(\S+)(.*)$/gm)];
      expect(uses.length).toBeGreaterThanOrEqual(workflow === build ? 1 : 3);
      for (const [, ref, rest] of uses) {
        expect(ref, ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
        expect(rest, ref).toMatch(/# v\d/);
      }
    }
  });

  it('the image is built and pushed only by the image workflow, only for a push to main, and the gate cannot publish', () => {
    expect(build).toMatch(/^    branches: \[main\]$/m);
    expect(build).toMatch(/IMAGE: git\.kiztigs\.com\/kmbrimble\/terriblebutler/);
    expect(gate).not.toMatch(/docker login|docker push|git\.kiztigs\.com\/kmbrimble\/terriblebutler/);
    expect(fs.existsSync(path.join(repo, '.github/workflows/build.yml'))).toBe(false);
  });

  it('the image workflow can never write back to the repository', () => {
    expect(build).not.toMatch(/contents: write|git push|git commit|git tag|gh release|gh pr/);
  });

  it('the gate runs everything the owner requires, on Node 24', () => {
    for (const needle of [
      "node-version: '24'", 'npm ci', 'npm --prefix client ci', 'npm test', 'npm --prefix client run build',
      'npx playwright install --with-deps chromium', 'npm run test:e2e',
      '--config p/default --metrics=off --error .', 'hadolint" Dockerfile',
      'scan source -L package-lock.json -L client/package-lock.json',
      'npm audit --audit-level=low', 'npm --prefix client audit --audit-level=low',
    ]) expect(gate, needle).toContain(needle);
  });

  it('downloaded tools are version-pinned and checksum-verified, and semgrep is pinned', () => {
    expect(ci).toMatch(/SEMGREP_VERSION: '\d+\.\d+\.\d+'/);
    for (const tool of ['HADOLINT', 'OSV_SCANNER']) {
      expect(ci).toMatch(new RegExp(`${tool}_VERSION: 'v\\d+\\.\\d+\\.\\d+'`));
      expect(ci).toMatch(new RegExp(`${tool}_SHA256: '[0-9a-f]{64}'`));
    }
    expect((gate.match(/sha256sum --check --strict/g) || []).length).toBe(2);
    expect(gate).not.toMatch(/curl[^\n]*\|\s*(ba)?sh/);
  });

  it('the image workflow publishes only to the Gitea registry with the org REGISTRY_TOKEN secret (no GHCR)', () => {
    expect(build).not.toMatch(/ghcr\.io/);
    expect(build).toMatch(/TOKEN: \$\{\{ secrets\.REGISTRY_TOKEN \}\}/);
    expect(build).toMatch(/docker login "\$REGISTRY" -u butler-bot/);
  });

  it('the gate runs on pushes and pull requests so it can be proven before merging (it is the required check on main)', () => {
    expect(ci).toMatch(/^  push:$/m);
    expect(ci).toMatch(/^  pull_request:$/m);
    expect(ci).toMatch(/^  workflow_dispatch:$/m);
  });
});

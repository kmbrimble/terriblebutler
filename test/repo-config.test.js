// Guards for repository and CI configuration that has no other test: Dependabot, the @claude
// workflow gate, and the documented Dockerfile exceptions.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const repo = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(repo, f), 'utf8');

describe('.github/dependabot.yml', () => {
  const blocks = read('.github/dependabot.yml').split(/^ {2}- package-ecosystem: /m).slice(1);

  it('covers npm (server and client), docker and github-actions', () => {
    expect(blocks.map((b) => b.split('\n')[0])).toEqual(['npm', 'npm', 'docker', 'github-actions']);
  });

  it.each([0, 1, 2, 3])('update block %i has a cooldown on version updates', (index) => {
    expect(blocks[index]).toMatch(/^ {4}cooldown:\n {6}default-days: ([1-9]\d*)$/m);
  });
});

describe('.github/workflows/claude.yml', () => {
  const workflow = read('.github/workflows/claude.yml');
  const condition = workflow.slice(workflow.indexOf('    if: |'), workflow.indexOf('    runs-on'));
  const branches = condition.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('(github.event_name =='));

  it('has a branch per trigger, and every branch checks the author association', () => {
    expect(branches).toHaveLength(4);
    for (const branch of branches) {
      expect(branch).toContain('@claude');
      expect(branch).toMatch(/fromJSON\('\["OWNER","MEMBER","COLLABORATOR"\]'\), github\.event\.(comment|review|issue)\.author_association\)/);
    }
  });

  it('reads the association from the same payload object as the text it matched', () => {
    const pairs = [['issue_comment', 'comment'], ['pull_request_review_comment', 'comment'], ['pull_request_review', 'review'], ['issues', 'issue']];
    for (const [event, object] of pairs) {
      const branch = branches.find((b) => b.includes(`'${event}'`));
      expect(branch, event).toContain(`github.event.${object}.author_association`);
    }
  });

  it('does not admit the weaker associations', () => {
    expect(condition).not.toMatch(/CONTRIBUTOR|FIRST_TIME|NONE|MANNEQUIN/);
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

describe('.github/workflows/build.yml', () => {
  const workflow = read('.github/workflows/build.yml');
  const jobs = workflow.slice(workflow.indexOf('\njobs:'));
  const gate = jobs.slice(jobs.indexOf('\n  gate:'), jobs.indexOf('\n  build-and-push:'));
  const build = jobs.slice(jobs.indexOf('\n  build-and-push:'));

  it('every action is pinned to a full commit SHA (with its version in a comment)', () => {
    const uses = [...workflow.matchAll(/^\s*uses:\s*(\S+)(.*)$/gm)];
    expect(uses.length).toBeGreaterThanOrEqual(5);
    for (const [, ref, rest] of uses) {
      expect(ref, ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
      expect(rest, ref).toMatch(/# v\d/);
    }
  });

  it('the image is built only after the gate, and only for a push to main', () => {
    expect(build).toMatch(/^\s+needs: gate$/m);
    expect(build).toMatch(/if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
    expect(gate).not.toMatch(/packages: write|docker\/login-action|push: true/);
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
    expect(workflow).toMatch(/SEMGREP_VERSION: '\d+\.\d+\.\d+'/);
    for (const tool of ['HADOLINT', 'OSV_SCANNER']) {
      expect(workflow).toMatch(new RegExp(`${tool}_VERSION: 'v\\d+\\.\\d+\\.\\d+'`));
      expect(workflow).toMatch(new RegExp(`${tool}_SHA256: '[0-9a-f]{64}'`));
    }
    expect((gate.match(/sha256sum --check --strict/g) || []).length).toBe(2);
    expect(gate).not.toMatch(/curl[^\n]*\|\s*(ba)?sh/);
  });

  it('token permissions are read-only at the top; only the publishing job may write packages', () => {
    expect(workflow).toMatch(/^permissions:\n  contents: read$/m);
    expect(build).toMatch(/permissions:\n\s+contents: read\n\s+packages: write/);
  });

  it('runs on branch pushes and pull requests so it can be proven before merging', () => {
    expect(workflow).toMatch(/^\s+- 'security\/\*\*'$/m);
    expect(workflow).toMatch(/^  pull_request:$/m);
    expect(workflow).toMatch(/^  workflow_dispatch:$/m);
  });
});

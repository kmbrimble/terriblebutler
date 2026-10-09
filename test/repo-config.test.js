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
